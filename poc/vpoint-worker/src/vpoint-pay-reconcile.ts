import type { RawArtifact } from "./types";
import type { VPointPayEmailEvent } from "./vpoint-pay-email";

export type ReconciliationStatus = "matched" | "ambiguous" | "unmatched" | "not-comparable";

export interface EmailReconciliationSummary {
  reportKey: string;
  emailEventCount: number;
  comparableCount: number;
  matchedCount: number;
  ambiguousCount: number;
  unmatchedCount: number;
  notComparableCount: number;
  appLedgerStatus: "unavailable-no-live-snapshot" | "available-not-compared";
}

interface VPointHistoryRow {
  source: string;
  index: number;
  date: string;
  points: number;
  fingerprint: string;
}

interface ReconciliationEntry {
  emailEventId: string;
  status: ReconciliationStatus;
  candidateRows: Array<{
    source: string;
    index: number;
    fingerprint: string;
  }>;
}

export async function reconcileVPointPayEmails(options: {
  bucket: R2Bucket;
  vPointArtifacts: RawArtifact[];
  runId: string;
  completedAt: string;
}): Promise<EmailReconciliationSummary> {
  const events = await listEmailEvents(options.bucket);
  const rows = await historyRows(options.vPointArtifacts);
  const entries: ReconciliationEntry[] = [];
  for (const event of events) {
    const pointAmount = comparablePointAmount(event);
    if (pointAmount === null || pointAmount === 0) {
      entries.push({
        emailEventId: event.id,
        status: "not-comparable",
        candidateRows: [],
      });
      continue;
    }
    const date = jstDate(event.occurredAt);
    const candidates = rows.filter(
      (row) => row.date === date && row.points === -Math.abs(pointAmount),
    );
    entries.push({
      emailEventId: event.id,
      status:
        candidates.length === 1 ? "matched" : candidates.length > 1 ? "ambiguous" : "unmatched",
      candidateRows: candidates.map(({ source, index, fingerprint }) => ({
        source,
        index,
        fingerprint,
      })),
    });
  }
  const appLedgerStatus = (await hasLiveAppSnapshot(options.bucket))
    ? "available-not-compared"
    : "unavailable-no-live-snapshot";
  const counts = (status: ReconciliationStatus) =>
    entries.filter((entry) => entry.status === status).length;
  const report = {
    schemaVersion: "vpoint-pay-email-reconciliation-v1",
    runId: options.runId,
    completedAt: options.completedAt,
    policy: {
      match:
        "exact JST date and explicit V Point amount, including an explicitly V Point-funded charge",
      mutation: "none",
      ambiguousMatchesRemainUnresolved: true,
    },
    sources: {
      vPointHistory: "current collector run",
      vPointPayEmail: "all normalized archived notifications",
      vPointPayApp: appLedgerStatus,
    },
    entries,
  };
  const date = options.completedAt.slice(0, 10).replaceAll("-", "/");
  const reportKey = `derived/v-point-pay-email-reconciliation/${date}/${options.runId}.json`;
  await options.bucket.put(reportKey, JSON.stringify(report), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: {
      source: "v-point-pay-email-reconciliation",
      runId: options.runId,
    },
  });
  return {
    reportKey,
    emailEventCount: entries.length,
    comparableCount: entries.length - counts("not-comparable"),
    matchedCount: counts("matched"),
    ambiguousCount: counts("ambiguous"),
    unmatchedCount: counts("unmatched"),
    notComparableCount: counts("not-comparable"),
    appLedgerStatus,
  };
}

function comparablePointAmount(event: VPointPayEmailEvent): number | null {
  if (event.usedPoints !== null) return event.usedPoints;
  if (
    event.eventType === "charge" &&
    event.detail?.includes("ポイント") &&
    event.amountYen !== null
  )
    return event.amountYen;
  return null;
}

async function listEmailEvents(bucket: R2Bucket): Promise<VPointPayEmailEvent[]> {
  const events: VPointPayEmailEvent[] = [];
  let cursor: string | undefined;
  do {
    const listed = await bucket.list({
      prefix: "raw/v-point-pay-email/",
      cursor,
      limit: 1000,
    });
    for (const object of listed.objects) {
      if (!object.key.endsWith(".json")) continue;
      const stored = await bucket.get(object.key);
      if (!stored) continue;
      const value: unknown = await stored.json();
      if (isEmailEvent(value)) events.push(value);
    }
    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);
  return events;
}

async function historyRows(artifacts: RawArtifact[]): Promise<VPointHistoryRow[]> {
  const rows: VPointHistoryRow[] = [];
  for (const artifact of artifacts) {
    if (!artifact.dataset.startsWith("history-page-")) continue;
    const body: unknown = JSON.parse(artifact.body);
    if (!isObject(body) || !isObject(body.results)) continue;
    const history = body.results.history;
    if (!Array.isArray(history)) continue;
    for (const [index, value] of history.entries()) {
      if (!isObject(value)) continue;
      const date = normalizedDate(value.date_use ?? value.date_reflect);
      const points = integer(value.point);
      if (!date || points === null) continue;
      rows.push({
        source: artifact.filename,
        index,
        date,
        points,
        fingerprint: await sha256Hex(JSON.stringify(value)),
      });
    }
  }
  return rows;
}

async function hasLiveAppSnapshot(bucket: R2Bucket): Promise<boolean> {
  const listed = await bucket.list({ prefix: "raw/v-point-pay/", limit: 1 });
  return listed.objects.length > 0;
}

function isEmailEvent(value: unknown): value is VPointPayEmailEvent {
  if (!isObject(value)) return false;
  return (
    value.schemaVersion === "vpoint-pay-email-event-v1" &&
    typeof value.id === "string" &&
    typeof value.occurredAt === "string" &&
    ["usage", "charge", "balance-addition", "declined"].includes(
      typeof value.eventType === "string" ? value.eventType : "",
    ) &&
    (value.usedPoints === null || Number.isSafeInteger(value.usedPoints))
  );
}

function normalizedDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const compact = value.match(/^(20[0-9]{2})(0[1-9]|1[0-2])(0[1-9]|[12][0-9]|3[01])$/u);
  if (compact?.[1] && compact[2] && compact[3]) {
    return `${compact[1]}-${compact[2]}-${compact[3]}`;
  }
  const match = value.match(
    /(20[0-9]{2})[/.\-年](0?[1-9]|1[0-2])[/.\-月](0?[1-9]|[12][0-9]|3[01])/u,
  );
  if (!match?.[1] || !match[2] || !match[3]) return null;
  return `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
}

function jstDate(value: string): string {
  const date = new Date(value);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function integer(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Number(value.replaceAll(",", ""));
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((part) => part.toString(16).padStart(2, "0")).join("");
}
