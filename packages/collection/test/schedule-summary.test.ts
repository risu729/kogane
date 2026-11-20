// The schedules page's `summary` detail (ADR 0123): one line per job that
// keeps every closed state of the job and of its newest receipt, derived from
// the snapshot alone. Every id and time is invented.
import { expect, test } from "bun:test";
import {
  scheduleSnapshotSummary,
  type ScheduleOccurrence,
  type ScheduleSnapshot,
  type ScheduleView,
} from "../src/schedule-model";

function job(id: string, extra: Partial<ScheduleView> = {}): ScheduleView {
  return {
    id,
    source: id,
    kind: "collection",
    enabled: true,
    supported: true,
    timezone: "Asia/Tokyo",
    pattern: { kind: "daily", time: "06:00", weekdays: [] },
    revision: 1,
    nextNominalAt: "2099-01-03T21:00:00.000Z",
    nextRunAt: "2099-01-03T21:00:00.000Z",
    actualAlarmAt: null,
    reservation: "armed",
    maintenance: {
      status: "confirmed",
      referenceUrl: "https://example.invalid/maintenance",
      verifiedAt: "2099-01-01T00:00:00.000Z",
    },
    latest: null,
    ...extra,
  };
}
const failed: ScheduleOccurrence = {
  id: "scheduled:synthetic-a:1",
  scheduleId: "synthetic-a",
  nominalAt: "2099-01-02T21:00:00.000Z",
  startedAt: "2099-01-02T21:00:01.000Z",
  finishedAt: "2099-01-02T21:05:00.000Z",
  status: "failed",
  runIds: ["run-a"],
  runLinks: [{ runId: "run-a", evidenceId: null }],
  failureCode: "collection_failed",
};

test("a job line keeps the job's closed states, its dispatch and its newest receipt's code", () => {
  const snapshot: ScheduleSnapshot = {
    schedules: [
      job("synthetic-a", {
        latest: failed,
        collectionRequest: { source: "synthetic-a", dispatch: "lane_disabled" },
      }),
      job("synthetic-b", {
        enabled: false,
        supported: false,
        reservation: "disabled",
        collectionRequest: null,
      }),
      // A Processor that predates the collection request says nothing of it.
      job("synthetic-c", { source: null, kind: "processor" }),
    ],
    maintenance: [
      {
        id: "rule-1",
        source: "synthetic-a",
        timezone: "Asia/Tokyo",
        pattern: { kind: "weekly", weekdays: [1], start: "01:00", end: "02:00" },
        enabled: true,
        referenceUrl: "https://example.invalid/maintenance",
        verifiedAt: "2099-01-01T00:00:00.000Z",
        scope: "collection",
        revision: 1,
      },
    ],
    occurrences: [failed],
    leases: [{ source: "synthetic-a", leaseRef: "lease-1", startedAt: "2099-01-02T21:00:01.000Z" }],
  };
  expect(scheduleSnapshotSummary(snapshot)).toEqual({
    detail: "summary",
    schedules: [
      {
        id: "synthetic-a",
        source: "synthetic-a",
        kind: "collection",
        enabled: true,
        supported: true,
        nextRunAt: "2099-01-03T21:00:00.000Z",
        reservation: "armed",
        dispatch: "lane_disabled",
        latest: {
          nominalAt: "2099-01-02T21:00:00.000Z",
          status: "failed",
          failureCode: "collection_failed",
        },
      },
      {
        id: "synthetic-b",
        source: "synthetic-b",
        kind: "collection",
        enabled: false,
        supported: false,
        nextRunAt: "2099-01-03T21:00:00.000Z",
        reservation: "disabled",
        dispatch: null,
        latest: null,
      },
      {
        id: "synthetic-c",
        source: null,
        kind: "processor",
        enabled: true,
        supported: true,
        nextRunAt: "2099-01-03T21:00:00.000Z",
        reservation: "armed",
        latest: null,
      },
    ],
    maintenance: [
      { source: "synthetic-a", status: "confirmed", rules: 1 },
      { source: "synthetic-b", status: "confirmed", rules: 0 },
    ],
    leases: snapshot.leases,
  });
});
