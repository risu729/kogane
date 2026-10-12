import {
  BACKPRESSURE_CHECK_MAX_CHUNKS,
  checkBackpressure,
  type BackpressureEvent,
  type BackpressureReport,
} from "./backpressure-check";

type Snapshot = {
  running: 0 | 1 | null;
  chunks: number | null;
  streams: number | null;
  posts: number | null;
};
export type DiagnosticArm = {
  code: BackpressureReport["code"];
  firstReadBytes: number | null;
  elapsedMs: number | null;
  baseline: Snapshot;
  early: Snapshot;
  late: Snapshot;
  cancelled: 0 | 1;
};
export type BackpressureComparison = {
  code: "backpressure_compare";
  activityLease: 0 | 1;
  sdk: DiagnosticArm | null;
  raw: DiagnosticArm | null;
  sameProcess: 0 | 1 | null;
  conclusive: 0 | 1;
};

type Dependencies = {
  sdkFetch: (request: Request) => Promise<Response>;
  rawFetch: (request: Request) => Promise<Response>;
  running: () => boolean;
  renewActivityTimeout: () => void;
  outerSignal?: AbortSignal;
  intervalMs?: number;
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  check?: typeof checkBackpressure;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
};

const bytesMax = BACKPRESSURE_CHECK_MAX_CHUNKS * 64 * 1024;
const empty = (): Snapshot => ({ running: null, chunks: null, streams: null, posts: null });
const safeBytes = (value: number) =>
  Number.isSafeInteger(value) && value > 0 && value <= bytesMax ? value : null;
const safeElapsed = (value: number) =>
  Number.isSafeInteger(value) && value >= 0 && value <= 46_000 ? value : null;

export async function compareBackpressure({
  sdkFetch,
  rawFetch,
  running,
  renewActivityTimeout,
  outerSignal,
  intervalMs = 10_000,
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  check = checkBackpressure,
  wait,
  now,
}: Dependencies): Promise<BackpressureComparison> {
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
    const baseline = empty();
    const early = empty();
    const late = empty();
    const identities: (string | null)[] = [null, null, null];
    let firstReadBytes: number | null = null;
    let elapsedMs: number | null = null;
    let cancelled: 0 | 1 = 0;
    const onEvent = (event: Readonly<BackpressureEvent>) => {
      if (event.kind === "first") firstReadBytes = safeBytes(event.bytes);
      else if (event.kind === "elapsed") elapsedMs = safeElapsed(event.ms);
      else if (event.kind === "cancel") cancelled = event.ok;
      else {
        const index = { baseline: 0, early: 1, late: 2 }[event.sample];
        const snapshot = [baseline, early, late][index];
        if (event.kind === "running") snapshot.running = event.value;
        else {
          snapshot.chunks = event.value.backpressureChunks;
          snapshot.streams = event.value.streams;
          snapshot.posts = event.value.posts;
          identities[index] = event.value.processIdentity;
        }
      }
    };
    const result = await check({
      fetchBoundary,
      running,
      outerSignal,
      onEvent,
      wait,
      now,
      timeoutMs: 46_000,
      cancelTimeoutMs: 3_000,
    });
    const arm: DiagnosticArm = {
      code: result.code,
      firstReadBytes,
      elapsedMs,
      baseline: { ...baseline },
      early: { ...early },
      late: { ...late },
      cancelled,
    };
    return { arm, identities };
  };
  const full = (arm: DiagnosticArm | undefined) =>
    arm?.cancelled === 1 &&
    arm.firstReadBytes !== null &&
    arm.elapsedMs !== null &&
    arm.elapsedMs >= 30_000 &&
    [arm.baseline, arm.early, arm.late].every(
      (item) =>
        item.running === 1 && item.chunks !== null && item.streams !== null && item.posts !== null,
    ) &&
    arm.baseline.streams === 0 &&
    arm.early.streams === 1 &&
    (arm.late.streams === 1 || (arm.code === "exhausted_late" && arm.late.streams === 0)) &&
    arm.early.posts === arm.baseline.posts &&
    arm.late.posts === arm.baseline.posts &&
    arm.early.chunks! >= 1 &&
    arm.early.chunks! < BACKPRESSURE_CHECK_MAX_CHUNKS &&
    arm.late.chunks! >= arm.early.chunks! &&
    arm.late.chunks! <= BACKPRESSURE_CHECK_MAX_CHUNKS;
  let sdk: Awaited<ReturnType<typeof observe>> | null = null;
  let raw: Awaited<ReturnType<typeof observe>> | null = null;
  try {
    if (activityLease === 1) sdk = await observe(sdkFetch);
    // A timed-out or failed cancellation cannot leave two source streams active.
    if (
      activityLease === 1 &&
      full(sdk?.arm) &&
      ["pass", "progress", "exhausted_late"].includes(sdk!.arm.code) &&
      running()
    )
      raw = await observe(rawFetch);
  } finally {
    clearIntervalImpl(interval);
  }
  const ids = [...(sdk?.identities ?? []), ...(raw?.identities ?? [])];
  const sameProcess: 0 | 1 | null =
    ids.length !== 6 || ids.some((id) => id === null)
      ? null
      : ids.every((id) => id === ids[0])
        ? 1
        : 0;
  const conclusive: 0 | 1 =
    activityLease === 1 &&
    sameProcess === 1 &&
    full(sdk?.arm) &&
    full(raw?.arm) &&
    ["pass", "progress", "exhausted_late"].includes(sdk!.arm.code) &&
    ["pass", "progress", "exhausted_late"].includes(raw!.arm.code)
      ? 1
      : 0;
  return {
    code: "backpressure_compare",
    activityLease,
    sdk: sdk?.arm ?? null,
    raw: raw?.arm ?? null,
    sameProcess,
    conclusive,
  };
}
