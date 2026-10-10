// Verify the actual SDK/native returned Response inside the DO, before public HTTP buffering.
export type ReleaseObservation = {
  stage: "before" | "after";
  samples: number;
  elapsedMs: number;
  running: 0 | 1 | null;
  streams: 0 | 1 | 2 | null;
  identityMatches: 0 | 1 | null;
  postsMatches: 0 | 1 | null;
};
export type StreamErrorCheckReport =
  | { code: "pass"; bytes: 35; reads: number; elapsedMs: number }
  | {
      code:
        | "timeout"
        | "process"
        | "stats"
        | "identity"
        | "posts"
        | "streams"
        | "streams_before"
        | "streams_after"
        | "fetch"
        | "http"
        | "body"
        | "encoding"
        | "payload"
        | "limit"
        | "eof"
        | "partial"
        | "timing";
      observation?: ReleaseObservation;
    };
type Failure = Exclude<StreamErrorCheckReport["code"], "pass">;
type Stats = { processIdentity: string; posts: number; streams: number };
type Dependencies = {
  fetchBoundary: (request: Request) => Promise<Response>;
  running: () => boolean;
  outerSignal?: AbortSignal;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  timeoutMs?: number;
  cancelTimeoutMs?: number;
  onEvent?: (event: "running" | "stats" | "fetch" | "read_error" | "cancel") => void;
};
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
class CheckFailure {
  constructor(readonly code: Failure) {}
}
const fail = (code: Failure): never => {
  throw new CheckFailure(code);
};
const validCount = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0;

export async function checkStreamError({
  fetchBoundary,
  running,
  outerSignal,
  now = Date.now,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  timeoutMs = 46_000,
  cancelTimeoutMs = 3_000,
  onEvent,
}: Dependencies): Promise<StreamErrorCheckReport> {
  const emit = (event: "running" | "stats" | "fetch" | "read_error" | "cancel") => {
    try {
      onEvent?.(event);
    } catch {
      // Observability cannot alter the gate.
    }
  };
  const globalStarted = now();
  const aborter = new AbortController();
  let observation: ReleaseObservation | undefined;
  let releaseDeadline: Promise<never> | undefined;
  let releaseState: { expired: boolean } | undefined;
  let timedOut = false;
  let rejectDeadline!: (reason: CheckFailure) => void;
  const deadline = new Promise<never>((_, reject) => {
    rejectDeadline = reject;
  });
  const timeout = () => {
    timedOut = true;
    aborter.abort();
    rejectDeadline(new CheckFailure("timeout"));
  };
  const timer = setTimeout(timeout, timeoutMs);
  const outerAbort = () => timeout();
  outerSignal?.addEventListener("abort", outerAbort, { once: true });
  const bounded = <T>(operation: Promise<T>) =>
    Promise.race(releaseDeadline ? [operation, deadline, releaseDeadline] : [operation, deadline]);
  const cancel = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    let cancelTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const operation = reader.cancel();
      if (timedOut || outerSignal?.aborted) {
        void operation.catch(() => {});
        return;
      }
      await bounded(
        Promise.race([
          operation,
          new Promise<never>((_, reject) => {
            cancelTimer = setTimeout(
              () => reject(new Error("cancel_timeout")),
              Math.max(0, Math.min(cancelTimeoutMs, timeoutMs - (now() - globalStarted))),
            );
          }),
        ]),
      );
    } catch {
      // A terminal read error normally makes cancel reject; after stats prove release.
    } finally {
      if (cancelTimer) clearTimeout(cancelTimer);
      emit("cancel");
    }
  };
  const fetchOwned = async (request: Request) => {
    const ownedRelease = releaseState;
    const operation = fetchBoundary(request);
    let claimed = false;
    void operation.then(
      (response) => {
        if (!claimed && (aborter.signal.aborted || ownedRelease?.expired) && response.body) {
          try {
            void cancel(response.body.getReader());
          } catch {
            // Late response was already locked.
          }
        }
      },
      () => {},
    );
    const response = await bounded(operation);
    claimed = true;
    return response;
  };
  const sample = async (): Promise<Stats> => {
    emit("running");
    const isRunning = running();
    if (observation) observation.running = isRunning ? 1 : 0;
    if (!isRunning) fail("process"); // /stats would auto-start a stopped process.
    if (observation) observation.samples++;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let complete = false;
    try {
      const response = await fetchOwned(
        new Request("http://container/stats", { signal: aborter.signal }),
      );
      reader = response.body?.getReader();
      if (response.status !== 200 || !reader) fail("stats");
      const parts: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const part = await bounded(reader!.read());
        if (part.done) {
          complete = true;
          break;
        }
        size += part.value.byteLength;
        if (size > 4096) fail("stats");
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
      if (!value || typeof value !== "object" || Array.isArray(value)) fail("stats");
      const stats = value as Record<string, unknown>;
      if (
        typeof stats.processIdentity !== "string" ||
        !UUID.test(stats.processIdentity) ||
        !validCount(stats.posts) ||
        !validCount(stats.streams)
      )
        fail("stats");
      emit("stats");
      return stats as Stats;
    } catch (error) {
      if (timedOut || error instanceof CheckFailure) throw error;
      throw new CheckFailure("stats");
    } finally {
      if (reader && !complete) await cancel(reader);
    }
  };
  let baseline: Stats | undefined;
  const release = async (stage: "before" | "after"): Promise<Stats> => {
    const started = now();
    observation = {
      stage,
      samples: 0,
      elapsedMs: 0,
      running: null,
      streams: null,
      identityMatches: null,
      postsMatches: null,
    };
    const reason = stage === "before" ? "streams_before" : "streams_after";
    let stageTimer: ReturnType<typeof setTimeout> | undefined;
    const stageState = { expired: false };
    releaseState = stageState;
    releaseDeadline = new Promise<never>((_, reject) => {
      stageTimer = setTimeout(() => {
        stageState.expired = true;
        reject(new CheckFailure(reason));
      }, 3_000);
    });
    try {
      for (;;) {
        if (timedOut || outerSignal?.aborted) fail("timeout");
        if (now() - globalStarted >= timeoutMs) {
          timeout();
          fail("timeout");
        }
        if (observation.samples >= 31 || now() - started >= 3_000) fail(reason);
        const stats = await sample();
        observation.streams = stats.streams === 0 ? 0 : stats.streams === 1 ? 1 : 2;
        baseline ??= stats;
        observation.identityMatches = stats.processIdentity === baseline.processIdentity ? 1 : 0;
        observation.postsMatches = stats.posts === baseline.posts ? 1 : 0;
        // Timers can run after promise microtasks; elapsed time also guards late success.
        if (now() - globalStarted >= timeoutMs) {
          timeout();
          fail("timeout");
        }
        if (now() - started >= 3_000) fail(reason);
        if (!observation.identityMatches) fail("identity");
        if (!observation.postsMatches) fail("posts");
        if (stats.streams === 0) {
          observation = undefined;
          return stats;
        }
        if (stats.streams !== 1) fail(reason);
        if (observation.samples >= 31) fail(reason);
        const remaining = Math.min(3_000 - (now() - started), timeoutMs - (now() - globalStarted));
        if (remaining <= 0) fail(reason);
        await bounded(sleep(Math.min(100, remaining)));
      }
    } finally {
      if (observation)
        observation.elapsedMs = Math.min(46_000, Math.max(0, Math.trunc(now() - started)));
      stageState.expired = true;
      if (stageTimer) clearTimeout(stageTimer);
      releaseDeadline = undefined;
      releaseState = undefined;
    }
  };
  let streamReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let result: StreamErrorCheckReport = { code: "fetch" };
  try {
    if (outerSignal?.aborted) fail("timeout");
    await release("before");
    emit("fetch");
    // Time starts after baseline stats, so a slow stats request cannot satisfy the source delay.
    const started = now();
    let response!: Response;
    try {
      response = await fetchOwned(
        new Request("http://container/stream-error", { signal: aborter.signal }),
      );
    } catch (error) {
      if (timedOut) throw error;
      fail("fetch");
    }
    try {
      streamReader = response.body?.getReader();
    } catch {
      fail("body");
    }
    if (response.status !== 200) fail("http");
    const encoding = response.headers.get("content-encoding");
    if (encoding && encoding.trim().toLowerCase() !== "identity") fail("encoding");
    if (!streamReader) fail("body");
    let bytes = 0;
    let reads = 0;
    let errored = false;
    while (true) {
      let part: ReadableStreamReadResult<Uint8Array>;
      try {
        part = await bounded(streamReader!.read());
      } catch {
        if (timedOut || outerSignal?.aborted || aborter.signal.aborted) fail("timeout");
        errored = true;
        emit("read_error");
        break;
      }
      if (part.done) fail("eof");
      const chunk = part.value!;
      if (!(chunk instanceof Uint8Array) || chunk.byteLength === 0) fail("payload");
      bytes += chunk.byteLength;
      reads++;
      if (bytes > 35 || reads > 64) fail("limit");
      for (const byte of chunk) if (byte !== 1) fail("payload");
    }
    if (!errored) fail("fetch");
    if (bytes !== 35) fail("partial");
    const elapsedMs = now() - started;
    if (
      !Number.isSafeInteger(elapsedMs) ||
      elapsedMs < 35_000 ||
      elapsedMs > timeoutMs ||
      timedOut ||
      outerSignal?.aborted
    )
      fail("timing");
    // A read-error stream can reject cancel. Source release is judged by the next /stats.
    await cancel(streamReader!);
    streamReader = undefined;
    await release("after");
    if (now() - globalStarted >= timeoutMs) timeout();
    if (timedOut || outerSignal?.aborted) fail("timeout");
    result = { code: "pass", bytes: 35, reads, elapsedMs };
  } catch (error) {
    result = {
      code: timedOut ? "timeout" : error instanceof CheckFailure ? error.code : "fetch",
      ...(observation ? { observation: { ...observation } } : {}),
    };
  } finally {
    if (streamReader) await cancel(streamReader!);
    aborter.abort();
    clearTimeout(timer);
    outerSignal?.removeEventListener("abort", outerAbort);
  }
  return result;
}
