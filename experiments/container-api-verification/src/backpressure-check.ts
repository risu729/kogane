export type BackpressureReport =
  | { code: "pass"; earlyChunks: number; lateChunks: number; elapsedMs: number }
  | {
      code:
        | "timing"
        | "process"
        | "stream"
        | "posts"
        | "chunks"
        | "encoding"
        | "exhausted_early"
        | "exhausted_late"
        | "progress"
        | "timeout";
    };

type Code = Exclude<BackpressureReport["code"], "pass">;
type Stats = {
  processIdentity: string;
  posts: number;
  streams: number;
  backpressureChunks: number;
};
export type BackpressureEvent =
  | { kind: "running"; sample: "baseline" | "early" | "late"; value: 0 | 1 }
  | { kind: "stats"; sample: "baseline" | "early" | "late"; value: Readonly<Stats> }
  | { kind: "first"; bytes: number }
  | { kind: "elapsed"; ms: number }
  | { kind: "cancel"; ok: 0 | 1 };
type Dependencies = {
  fetchBoundary: (request: Request) => Promise<Response>;
  running: () => boolean;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  cancelTimeoutMs?: number;
  outerSignal?: AbortSignal;
  onEvent?: (event: Readonly<BackpressureEvent>) => void;
};
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
// Matches the immutable random 64 KiB source's 4096-chunk cap.
export const BACKPRESSURE_CHECK_MAX_CHUNKS = 4096;
class CheckFailure {
  constructor(readonly code: Code) {}
}
const fail = (code: Code): never => {
  throw new CheckFailure(code);
};
const defaultWait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
const validCount = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;

/** Consume the SDK/native fetch Response inside the DO, before outer HTTP buffering. */
export async function checkBackpressure({
  fetchBoundary,
  running,
  wait = defaultWait,
  now = Date.now,
  timeoutMs = 110_000,
  cancelTimeoutMs = 3_000,
  outerSignal,
  onEvent,
}: Dependencies): Promise<BackpressureReport> {
  const emit = (event: BackpressureEvent) => {
    try {
      onEvent?.(Object.freeze(event));
    } catch {
      /* Diagnostics cannot alter the gate. */
    }
  };
  const aborter = new AbortController();
  let timedOut = false;
  let rejectDeadline!: (reason: CheckFailure) => void;
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  const timer = setTimeout(() => {
    timedOut = true;
    aborter.abort();
    rejectDeadline(new CheckFailure("timeout"));
  }, timeoutMs);
  const outerAbort = () => aborter.abort();
  outerSignal?.addEventListener("abort", outerAbort, { once: true });
  const bounded = <T>(operation: Promise<T>) => Promise.race([operation, deadline]);
  const cancelReader = async (owned: ReadableStreamDefaultReader<Uint8Array>) => {
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        owned.cancel(),
        new Promise<never>((_, reject) => {
          cancelTimer = setTimeout(() => reject(new CheckFailure("stream")), cancelTimeoutMs);
        }),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      if (cancelTimer) clearTimeout(cancelTimer);
    }
  };
  const cancelResponse = async (response: Response) => {
    try {
      if (response.body) await cancelReader(response.body.getReader());
    } catch {
      // The response may already have been locked by a rejected transport.
    }
  };
  const fetchOwned = async (request: Request) => {
    const operation = fetchBoundary(request);
    let claimed = false;
    // A fetch may resolve after the deadline. It still owns a body that needs release.
    void operation.then(
      (response) => {
        if (!claimed && aborter.signal.aborted) void cancelResponse(response);
      },
      () => {},
    );
    const response = await bounded(operation);
    claimed = true;
    return response;
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let sampleIndex = 0;
  let result: BackpressureReport = { code: "stream" };
  try {
    if (outerSignal?.aborted) fail("timeout");
    const sample = async (): Promise<Stats> => {
      const sampleName = (["baseline", "early", "late"] as const)[sampleIndex++];
      // Never auto-start a stopped process by requesting /stats.
      const alive = running();
      emit({ kind: "running", sample: sampleName, value: alive ? 1 : 0 });
      if (!alive) fail("process");
      const response = await fetchOwned(
        new Request("http://container/stats", { signal: aborter.signal }),
      );
      let statsReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let complete = false;
      try {
        if (response.body) statsReader = response.body.getReader();
        if (response.status !== 200 || !statsReader) fail("chunks");
        const parts: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const part = await bounded(statsReader!.read());
          if (part.done) {
            complete = true;
            break;
          }
          size += part.value.byteLength;
          if (size > 4096) fail("chunks");
          parts.push(part.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) {
          bytes.set(part, offset);
          offset += part.byteLength;
        }
        const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
        if (!value || typeof value !== "object" || Array.isArray(value)) fail("chunks");
        const stats = value as Record<string, unknown>;
        if (
          !UUID.test(stats.processIdentity as string) ||
          !validCount(stats.posts) ||
          !validCount(stats.streams) ||
          !validCount(stats.backpressureChunks)
        )
          fail("chunks");
        emit({
          kind: "stats",
          sample: sampleName,
          value: Object.freeze({
            processIdentity: stats.processIdentity as string,
            posts: stats.posts as number,
            streams: stats.streams as number,
            backpressureChunks: stats.backpressureChunks as number,
          }),
        });
        return stats as Stats;
      } catch (error) {
        if (timedOut || error instanceof CheckFailure) throw error;
        throw new CheckFailure("chunks");
      } finally {
        if (statsReader && !complete) await cancelReader(statsReader);
      }
    };
    const baseline = await sample();
    if (baseline.streams !== 0) fail("stream");
    const response = await fetchOwned(
      new Request("http://container/backpressure", {
        signal: aborter.signal,
        headers: { "accept-encoding": "identity" },
      }),
    );
    const body = response.body;
    if (body) reader = body.getReader();
    if (response.status !== 200 || !reader) fail("stream");
    const encoding = response.headers.get("content-encoding");
    if (encoding && encoding.trim().toLowerCase() !== "identity") fail("encoding");
    let first: ReadableStreamReadResult<Uint8Array> = { done: true, value: undefined };
    try {
      first = await bounded(reader!.read());
    } catch (error) {
      if (timedOut) throw error;
      fail("stream");
    }
    if (first.done || !first.value?.byteLength) fail("chunks");
    emit({ kind: "first", bytes: first.value!.byteLength });
    await bounded(wait(1000, aborter.signal));
    const early = await sample();
    const started = now();
    await bounded(wait(35_000, aborter.signal));
    const elapsed = now() - started;
    if (Number.isFinite(elapsed)) emit({ kind: "elapsed", ms: elapsed });
    if (!Number.isFinite(elapsed) || elapsed < 30_000) fail("timing");
    const late = await sample();
    if (now() - started < 30_000) fail("timing");
    if (
      early.processIdentity !== baseline.processIdentity ||
      late.processIdentity !== baseline.processIdentity
    )
      fail("process");
    if (early.backpressureChunks < 1 || late.backpressureChunks < 1) fail("chunks");
    if (early.backpressureChunks >= BACKPRESSURE_CHECK_MAX_CHUNKS) fail("exhausted_early");
    if (late.backpressureChunks >= BACKPRESSURE_CHECK_MAX_CHUNKS) fail("exhausted_late");
    if (early.streams !== 1 || late.streams !== 1) fail("stream");
    if (early.posts !== baseline.posts || late.posts !== baseline.posts) fail("posts");
    if (late.backpressureChunks !== early.backpressureChunks) fail("progress");
    result = {
      code: "pass",
      earlyChunks: early.backpressureChunks,
      lateChunks: late.backpressureChunks,
      elapsedMs: elapsed,
    };
  } catch (error) {
    result = { code: timedOut ? "timeout" : error instanceof CheckFailure ? error.code : "stream" };
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", outerAbort);
    if (reader) {
      const cancelled = await cancelReader(reader);
      emit({ kind: "cancel", ok: cancelled ? 1 : 0 });
      if (!cancelled && result.code === "pass") result = { code: "stream" };
    } else emit({ kind: "cancel", ok: 0 });
    aborter.abort();
  }
  return result;
}
