// This verifies the returned reader's lifetime and bytes, not producer backpressure.
export const READER_FRAMES = 64;
export const READER_FRAME_BYTES = 64 * 1024;
export const READER_TOTAL_BYTES = READER_FRAMES * READER_FRAME_BYTES;
export type ReaderArm = "resume" | "cancel";
export type ReaderReport =
  | { code: "pass"; elapsedMs: number; bytes: number }
  | {
      code:
        | "timing"
        | "process"
        | "identity"
        | "posts"
        | "payload"
        | "stream"
        | "cancel"
        | "timeout";
    };
type Failure = Exclude<ReaderReport["code"], "pass">;
type Stats = { processIdentity: string; posts: number };
type Dependencies = {
  arm: ReaderArm;
  fetchBoundary: (request: Request) => Promise<Response>;
  running: () => boolean;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  cancelTimeoutMs?: number;
  outerSignal?: AbortSignal;
  onEvent?: (event: "running" | "stats" | "first" | "resumed" | "cancelled") => void;
};
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
class CheckFailure {
  constructor(readonly code: Failure) {}
}
const fail = (code: Failure): never => {
  throw new CheckFailure(code);
};
const defaultWait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Error("aborted"));
    const aborted = () => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", aborted);
      resolve();
    }, ms);
    signal.addEventListener("abort", aborted, { once: true });
  });
/** Consume the SDK/native returned Response inside the DO before outer HTTP buffering. */
export async function checkReaderLifetime({
  arm,
  fetchBoundary,
  running,
  wait = defaultWait,
  now = Date.now,
  timeoutMs = 110_000,
  cancelTimeoutMs = 3_000,
  outerSignal,
  onEvent,
}: Dependencies): Promise<ReaderReport> {
  const emit = (event: "running" | "stats" | "first" | "resumed" | "cancelled") => {
    try {
      onEvent?.(event);
    } catch {
      /* Diagnostics cannot change the gate. */
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
  const outerAbort = () => {
    timedOut = true;
    aborter.abort();
    rejectDeadline(new CheckFailure("timeout"));
  };
  outerSignal?.addEventListener("abort", outerAbort, { once: true });
  const bounded = <T>(operation: Promise<T>) => Promise.race([operation, deadline]);
  const cancel = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        reader.cancel(),
        new Promise<never>((_, reject) => {
          cancelTimer = setTimeout(() => reject(new Error("cancel_timeout")), cancelTimeoutMs);
        }),
      ]);
      return true;
    } catch {
      return false;
    } finally {
      if (cancelTimer) clearTimeout(cancelTimer);
    }
  };
  const fetchOwned = async (request: Request) => {
    const operation = fetchBoundary(request);
    let claimed = false;
    void operation.then(
      (response) => {
        if (!claimed && aborter.signal.aborted) {
          try {
            if (response.body) void cancel(response.body.getReader());
          } catch {
            /* Locked. */
          }
        }
      },
      () => {},
    );
    const response = await bounded(operation);
    claimed = true;
    return response;
  };
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let eof = false,
    cancelled = false;
  let result: ReaderReport = { code: "stream" };
  try {
    if (outerSignal?.aborted) fail("timeout");
    const sample = async (): Promise<Stats> => {
      emit("running");
      if (!running()) fail("process"); // /stats can auto-start a stopped process.
      const response = await fetchOwned(
        new Request("http://container/stats", { signal: aborter.signal }),
      );
      let owned: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let complete = false;
      try {
        owned = response.body?.getReader();
        if (response.status !== 200 || !owned) fail("identity");
        const parts: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const part = await bounded(owned!.read());
          if (part.done) {
            complete = true;
            break;
          }
          size += part.value.byteLength;
          if (size > 4096) fail("identity");
          parts.push(part.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) {
          bytes.set(part, offset);
          offset += part.byteLength;
        }
        const value: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
        );
        if (!value || typeof value !== "object" || Array.isArray(value)) fail("identity");
        const stats = value as Record<string, unknown>;
        if (
          typeof stats.processIdentity !== "string" ||
          !UUID.test(stats.processIdentity) ||
          !Number.isSafeInteger(stats.posts) ||
          Number(stats.posts) < 0
        )
          fail("identity");
        emit("stats");
        return { processIdentity: stats.processIdentity as string, posts: stats.posts as number };
      } catch (error) {
        if (timedOut || error instanceof CheckFailure) throw error;
        throw new CheckFailure("identity");
      } finally {
        if (owned && !complete) await cancel(owned);
      }
    };
    const baseline = await sample();
    const response = await fetchOwned(
      new Request("http://container/reader-lifetime", {
        signal: aborter.signal,
        headers: { "accept-encoding": "identity" },
      }),
    );
    reader = response.body?.getReader();
    if (response.status !== 200 || !reader) fail("stream");
    const encoding = response.headers.get("content-encoding");
    if (encoding && encoding.trim().toLowerCase() !== "identity") fail("payload");
    let received = 0;
    const verify = (bytes: Uint8Array) => {
      if (!bytes.byteLength || received + bytes.byteLength > READER_TOTAL_BYTES) fail("payload");
      for (let i = 0; i < bytes.byteLength; i++) {
        const position = received + i;
        const frame = Math.floor(position / READER_FRAME_BYTES);
        const offset = position % READER_FRAME_BYTES;
        const expected =
          offset < 4 ? (frame >>> (offset * 8)) & 255 : (frame * 37 + offset * 13) & 255;
        if (bytes[i] !== expected) fail("payload");
      }
      received += bytes.byteLength;
    };
    const first = await bounded(reader!.read());
    if (first.done || !first.value?.byteLength) fail("payload");
    verify(first.value!);
    if (received >= READER_TOTAL_BYTES) fail("payload");
    emit("first");
    const started = now();
    await bounded(wait(36_000, aborter.signal));
    const elapsed = now() - started;
    if (!Number.isFinite(elapsed) || elapsed < 35_000 || elapsed > timeoutMs) fail("timing");
    const late = await sample();
    if (late.processIdentity !== baseline.processIdentity) fail("identity");
    if (late.posts !== baseline.posts) fail("posts");
    if (arm === "resume") {
      while (true) {
        const part = await bounded(reader!.read());
        if (part.done) {
          eof = true;
          break;
        }
        verify(part.value);
      }
      if (received !== READER_TOTAL_BYTES) fail("payload");
      emit("resumed");
      result = { code: "pass", elapsedMs: elapsed, bytes: received };
    } else {
      if (!(await cancel(reader!))) fail("cancel");
      cancelled = true;
      emit("cancelled");
      result = { code: "pass", elapsedMs: elapsed, bytes: received };
    }
  } catch (error) {
    result = { code: timedOut ? "timeout" : error instanceof CheckFailure ? error.code : "stream" };
  } finally {
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", outerAbort);
    if (reader && !eof && !cancelled && !(await cancel(reader)) && result.code === "pass")
      result = { code: "cancel" };
    aborter.abort();
  }
  return result;
}
