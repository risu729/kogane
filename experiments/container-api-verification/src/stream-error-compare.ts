// Diagnostic only. This does not change the /stream-error acceptance gate.
type Encoding = "absent" | "identity" | "gzip" | "br" | "deflate" | "other";
type Terminal =
  | "read_error"
  | "eof"
  | "fetch_error"
  | "http_error"
  | "missing_body"
  | "limit"
  | "timeout";
type Snapshot = { running: 0 | 1 | null; streams: number | null; posts: number | null };
export type StreamErrorArm = {
  status: number | null;
  body: 0 | 1 | null;
  encoding: Encoding | null;
  bytes: number;
  reads: number;
  elapsedMs: number | null;
  terminal: Terminal;
  baseline: Snapshot;
  after: Snapshot;
  cancelAttempted: 0 | 1;
  cancelOk: 0 | 1;
};
export type StreamErrorComparison = {
  code: "stream_error_compare";
  activityLease: 0 | 1;
  sdk: StreamErrorArm | null;
  raw: StreamErrorArm | null;
  sameProcess: 0 | 1 | null;
  conclusive: 0 | 1;
};
type Dependencies = {
  sdkFetch: (request: Request) => Promise<Response>;
  rawFetch: (request: Request) => Promise<Response>;
  running: () => boolean;
  renewActivityTimeout: () => void;
  outerSignal?: AbortSignal;
  armTimeoutMs?: number;
  cancelTimeoutMs?: number;
  intervalMs?: number;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  now?: () => number;
};
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const MAX_BYTES = 64; // The immutable source emits 35 one-byte values before error.
const empty = (): Snapshot => ({ running: null, streams: null, posts: null });
export function encodingCategory(value: string | null): Encoding {
  if (value === null) return "absent";
  const normalized = value.trim().toLowerCase();
  if (["identity", "gzip", "br", "deflate"].includes(normalized)) return normalized as Encoding;
  return "other";
}
const validStats = (
  value: unknown,
): value is { processIdentity: string; streams: number; posts: number } => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.processIdentity === "string" &&
    UUID.test(item.processIdentity) &&
    Number.isSafeInteger(item.streams) &&
    Number(item.streams) >= 0 &&
    Number.isSafeInteger(item.posts) &&
    Number(item.posts) >= 0
  );
};

export async function compareStreamError({
  sdkFetch,
  rawFetch,
  running,
  renewActivityTimeout,
  outerSignal,
  armTimeoutMs = 46_000,
  cancelTimeoutMs = 3_000,
  intervalMs = 10_000,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  now = Date.now,
}: Dependencies): Promise<StreamErrorComparison> {
  if (outerSignal?.aborted)
    return {
      code: "stream_error_compare",
      activityLease: 0,
      sdk: null,
      raw: null,
      sameProcess: null,
      conclusive: 0,
    };
  let activityLease: 0 | 1 = 1;
  const renew = () => {
    try {
      renewActivityTimeout();
    } catch {
      activityLease = 0;
    }
  };
  renew();
  const interval = setIntervalImpl(renew, intervalMs);
  const observe = async (fetchBoundary: Dependencies["sdkFetch"]) => {
    const arm: StreamErrorArm = {
      status: null,
      body: null,
      encoding: null,
      bytes: 0,
      reads: 0,
      elapsedMs: null,
      terminal: "fetch_error",
      baseline: empty(),
      after: empty(),
      cancelAttempted: 0,
      cancelOk: 0,
    };
    const ids: (string | null)[] = [null, null];
    const started = now();
    const aborter = new AbortController();
    let timedOut = false;
    let rejectDeadline!: (error: Error) => void;
    const deadline = new Promise<never>((_, reject) => {
      rejectDeadline = reject;
    });
    const timeout = () => {
      timedOut = true;
      aborter.abort();
      rejectDeadline(new Error("timeout"));
    };
    const timer = setTimeout(timeout, armTimeoutMs);
    const outerAbort = () => timeout();
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
          if (!claimed && aborter.signal.aborted && response.body) {
            try {
              void cancel(response.body.getReader());
            } catch {
              /* Late response already locked. */
            }
          }
        },
        () => {},
      );
      const response = await bounded(operation);
      claimed = true;
      return response;
    };
    const sample = async (slot: 0 | 1): Promise<void> => {
      const snapshot = slot === 0 ? arm.baseline : arm.after;
      // /stats can auto-start a stopped process. Check DO-only state first.
      snapshot.running = running() ? 1 : 0;
      if (snapshot.running === 0) return;
      let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
      let complete = false;
      try {
        const response = await fetchOwned(
          new Request("http://container/stats", { signal: aborter.signal }),
        );
        reader = response.body?.getReader();
        if (response.status !== 200 || !reader) return;
        const parts: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const part = await bounded(reader.read());
          if (part.done) {
            complete = true;
            break;
          }
          size += part.value.byteLength;
          if (size > 4096) return;
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
        if (!validStats(value)) return;
        snapshot.streams = value.streams;
        snapshot.posts = value.posts;
        ids[slot] = value.processIdentity;
      } catch {
        /* A partial sample stays null and the report is inconclusive. */
      } finally {
        if (reader && !complete) await cancel(reader);
      }
    };
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let complete = false;
    try {
      await sample(0);
      if (arm.baseline.running !== 1 || arm.baseline.streams === null) return { arm, ids };
      let response: Response;
      try {
        response = await fetchOwned(
          new Request("http://container/stream-error", { signal: aborter.signal }),
        );
      } catch {
        arm.terminal = timedOut ? "timeout" : "fetch_error";
        return { arm, ids };
      }
      arm.status = response.status;
      arm.encoding = encodingCategory(response.headers.get("content-encoding"));
      try {
        reader = response.body?.getReader();
      } catch {
        /* Locked body is unavailable. */
      }
      arm.body = reader ? 1 : 0;
      if (response.status !== 200) arm.terminal = "http_error";
      else if (!reader) arm.terminal = "missing_body";
      else {
        try {
          while (true) {
            const part = await bounded(reader.read());
            if (part.done) {
              complete = true;
              arm.terminal = "eof";
              break;
            }
            arm.bytes += part.value.byteLength;
            arm.reads++;
            if (arm.bytes > MAX_BYTES || arm.reads > MAX_BYTES) {
              arm.bytes = Math.min(arm.bytes, MAX_BYTES);
              arm.reads = Math.min(arm.reads, MAX_BYTES);
              arm.terminal = "limit";
              break;
            }
          }
        } catch {
          arm.terminal = timedOut ? "timeout" : "read_error";
        }
      }
    } catch {
      arm.terminal = timedOut ? "timeout" : "fetch_error";
    } finally {
      if (reader && !complete) {
        arm.cancelAttempted = 1;
        arm.cancelOk = (await cancel(reader)) ? 1 : 0;
        // A rejected cancel after a terminal read error is expected; /stats proves release.
      }
      if (!timedOut) await sample(1);
      const elapsed = now() - started;
      if (Number.isSafeInteger(elapsed) && elapsed >= 0 && elapsed <= 50_000)
        arm.elapsedMs = elapsed;
      clearTimeout(timer);
      outerSignal?.removeEventListener("abort", outerAbort);
    }
    return { arm, ids };
  };
  let sdk: Awaited<ReturnType<typeof observe>> | null = null;
  let raw: Awaited<ReturnType<typeof observe>> | null = null;
  try {
    if (activityLease === 1) sdk = await observe(sdkFetch);
    const sdkArm = sdk?.arm;
    const released =
      sdkArm &&
      sdkArm.terminal !== "timeout" &&
      sdkArm.baseline.running === 1 &&
      sdkArm.after.running === 1 &&
      sdkArm.baseline.streams === 0 &&
      sdkArm.after.streams === 0 &&
      sdkArm.baseline.posts !== null &&
      sdkArm.after.posts === sdkArm.baseline.posts &&
      sdk?.ids[0] !== null &&
      sdk?.ids[0] === sdk?.ids[1];
    if (activityLease === 1 && released && running() && !outerSignal?.aborted)
      raw = await observe(rawFetch);
  } finally {
    clearIntervalImpl(interval);
  }
  const ids = [...(sdk?.ids ?? []), ...(raw?.ids ?? [])];
  const sameProcess: 0 | 1 | null =
    ids.length !== 4 || ids.some((id) => id === null)
      ? null
      : ids.every((id) => id === ids[0])
        ? 1
        : 0;
  const full = (arm: StreamErrorArm | undefined) =>
    arm?.status === 200 &&
    arm.body === 1 &&
    ["read_error", "eof"].includes(arm.terminal) &&
    arm.bytes === 35 &&
    arm.reads >= 1 &&
    arm.elapsedMs !== null &&
    arm.elapsedMs >= 35_000 &&
    arm.baseline.running === 1 &&
    arm.after.running === 1 &&
    arm.baseline.streams === 0 &&
    arm.after.streams === 0 &&
    arm.baseline.posts !== null &&
    arm.after.posts === arm.baseline.posts;
  return {
    code: "stream_error_compare",
    activityLease,
    sdk: sdk?.arm ?? null,
    raw: raw?.arm ?? null,
    sameProcess,
    conclusive:
      activityLease === 1 &&
      sameProcess === 1 &&
      full(sdk?.arm) &&
      full(raw?.arm) &&
      sdk!.arm.after.posts === raw!.arm.baseline.posts
        ? 1
        : 0,
  };
}
