// The maintenance read's `summary` detail (ADR 0123, amendment 2026-11-19):
// per job and per rule one line that keeps every closed state and code of
// what it collapses, paged by line, derived from the full read alone. Every
// id, time and host is invented.
import { expect, test } from "bun:test";
import {
  MAINTENANCE_SUMMARY_LINES,
  type MaintenanceRead,
  type MaintenanceReadRevision,
  type MaintenanceReadSource,
  maintenanceReadSummary,
} from "../src/schedule-model";

function revision(
  number: number,
  extra: Partial<MaintenanceReadRevision> = {},
): MaintenanceReadRevision {
  return {
    revision: number,
    timezone: "Asia/Tokyo",
    pattern: { kind: "weekly", weekdays: [6], start: "22:00", end: "08:00" },
    enabled: true,
    scope: "collection",
    referenceUrl: "https://maintenance.example.invalid/notices",
    verifiedAt: "2099-01-01T00:00:00.000Z",
    createdAt: "2099-01-01T00:00:00.000Z",
    actorKind: "operator",
    changeReason: "operator-edit",
    byCaller: false,
    ...extra,
  };
}

function source(
  id: string,
  jobs: number,
  rules: MaintenanceReadRevision[][],
  reference: MaintenanceReadSource["reference"] = {
    status: "confirmed",
    referenceUrl: "https://maintenance.example.invalid/notices",
    verifiedAt: "2099-01-01T00:00:00.000Z",
  },
): MaintenanceReadSource {
  return {
    source: id,
    reference,
    schedules: Array.from({ length: jobs }, (_, index) => ({
      id: `${id}-job-${index}`,
      source: id,
      kind: "collection",
      enabled: index === 0,
      supported: true,
      timezone: "Asia/Tokyo",
      pattern: { kind: "daily", time: "06:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
      revision: 3,
      nextNominalAt: "2099-01-03T21:00:00.000Z",
      nextRunAt: "2099-01-03T23:00:00.000Z",
      actualAlarmAt: "2099-01-03T23:00:00.000Z",
      reservation: index === 0 ? "armed" : "disabled",
      latest:
        index === 0
          ? {
              nominalAt: "2099-01-02T21:00:00.000Z",
              startedAt: "2099-01-02T21:00:01.000Z",
              finishedAt: "2099-01-02T21:04:00.000Z",
              status: "failed",
              failureCode: "collection_failed",
            }
          : null,
    })),
    rules: rules.map((revisions, index) => ({ id: `${id}-rule-${index}`, revisions })),
  };
}

const LIMITS = { maxDeferralHours: 168, writesPerDay: 30, writesUsedToday: 2 };

test("a job keeps its closed states, revision, run times and newest receipt's failure code", () => {
  const read: MaintenanceRead = { sources: [source("vpass", 2, [])], limits: LIMITS };
  const summary = maintenanceReadSummary(read);
  expect(summary).toEqual({
    detail: "summary",
    sources: [
      {
        source: "vpass",
        reference: "confirmed",
        scheduleCount: 2,
        ruleCount: 0,
        schedules: [
          {
            id: "vpass-job-0",
            kind: "collection",
            enabled: true,
            supported: true,
            revision: 3,
            nextNominalAt: "2099-01-03T21:00:00.000Z",
            nextRunAt: "2099-01-03T23:00:00.000Z",
            reservation: "armed",
            latest: {
              nominalAt: "2099-01-02T21:00:00.000Z",
              status: "failed",
              failureCode: "collection_failed",
            },
          },
          {
            id: "vpass-job-1",
            kind: "collection",
            enabled: false,
            supported: true,
            revision: 3,
            nextNominalAt: "2099-01-03T21:00:00.000Z",
            nextRunAt: "2099-01-03T23:00:00.000Z",
            reservation: "disabled",
            latest: null,
          },
        ],
        rules: [],
      },
    ],
    limits: LIMITS,
    coverage: {
      sources: 1,
      lines: 2,
      limit: MAINTENANCE_SUMMARY_LINES,
      offset: 0,
      nextOffset: null,
    },
  });
  // Provenance is in the full read only.
  const text = JSON.stringify(summary);
  for (const dropped of ["referenceUrl", "verifiedAt", "actualAlarmAt", "startedAt", "pattern"])
    expect(text).not.toContain(dropped);
});

test("a rule is its current revision, with every actor kind and change reason of its history", () => {
  const read: MaintenanceRead = {
    sources: [
      source("sony-bank", 1, [
        [
          revision(3, {
            enabled: false,
            actorKind: "delegated",
            changeReason: "official-notice-withdrawn",
            byCaller: true,
          }),
          revision(2, { actorKind: "operator", changeReason: "operator-edit" }),
          revision(1, { actorKind: null, changeReason: null }),
        ],
      ]),
    ],
    limits: LIMITS,
  };
  expect(maintenanceReadSummary(read).sources[0]!.rules).toEqual([
    {
      id: "sony-bank-rule-0",
      revision: 3,
      timezone: "Asia/Tokyo",
      pattern: { kind: "weekly", weekdays: [6], start: "22:00", end: "08:00" },
      enabled: false,
      scope: "collection",
      revisions: 3,
      // A revision written before CORE 0078 recorded these is kept as null, never dropped.
      actorKinds: ["delegated", "operator", null],
      changeReasons: ["official-notice-withdrawn", "operator-edit", null],
      byCaller: 1,
    },
  ]);
});

test("pages by line: a source whose lines continue is listed on both pages with its counts", () => {
  const rules = Array.from({ length: 20 }, (_, index) => [revision(index + 1)]);
  const read: MaintenanceRead = {
    sources: [source("myjcb", 1, []), source("sbi-securities", 2, rules), source("vpoint", 1, [])],
    limits: LIMITS,
  };
  const first = maintenanceReadSummary(read);
  expect(first.coverage).toEqual({
    sources: 3,
    lines: 24,
    limit: MAINTENANCE_SUMMARY_LINES,
    offset: 0,
    nextOffset: 16,
  });
  expect(
    first.sources.map((entry) => [entry.source, entry.schedules.length, entry.rules.length]),
  ).toEqual([
    ["myjcb", 1, 0],
    ["sbi-securities", 2, 13],
  ]);
  const second = maintenanceReadSummary(read, 16);
  expect(second.coverage.nextOffset).toBeNull();
  expect(
    second.sources.map((entry) => [
      entry.source,
      entry.schedules.length,
      entry.rules.length,
      entry.scheduleCount,
      entry.ruleCount,
    ]),
  ).toEqual([
    ["sbi-securities", 0, 7, 2, 20],
    ["vpoint", 1, 0, 1, 0],
  ]);
  // Every rule once, in order.
  expect(
    [...first.sources, ...second.sources].flatMap((entry) => entry.rules.map((rule) => rule.id)),
  ).toEqual(rules.map((_, index) => `sbi-securities-rule-${index}`));
  // Past the last line: no source, and no next page.
  expect(maintenanceReadSummary(read, 24)).toMatchObject({
    sources: [],
    coverage: { lines: 24, offset: 24, nextOffset: null },
  });
});

test("a source with neither a job nor a rule is one line, and its missing reference stays null", () => {
  const read: MaintenanceRead = {
    sources: [source("st-george", 0, [], null)],
    limits: LIMITS,
  };
  expect(maintenanceReadSummary(read)).toMatchObject({
    sources: [
      {
        source: "st-george",
        reference: null,
        scheduleCount: 0,
        ruleCount: 0,
        schedules: [],
        rules: [],
      },
    ],
    coverage: { sources: 1, lines: 1, nextOffset: null },
  });
});

test("a rule the read lists without a revision is refused, never summarized as empty", () => {
  const read: MaintenanceRead = { sources: [source("vpass", 1, [[]])], limits: LIMITS };
  expect(() => maintenanceReadSummary(read)).toThrow("maintenance_rule_without_revision");
});
