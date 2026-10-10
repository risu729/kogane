// Pure settings contracts: the public schema is the private parser, and grants
// attenuate operation/source rather than relying on a client hint.
import { expect, test } from "bun:test";
import { z } from "zod";
import {
  delegatedJobResultSchema,
  delegatedJobSchema,
  delegatedJobPayloadSchema,
  executionFor,
  validDelegatedExecution,
  type DelegatedPrincipal,
} from "../src/index.ts";
const p: DelegatedPrincipal = {
  kind: "delegated",
  id: "mcp-client:settings-synthetic",
  delegator: "settings-synthetic",
  capabilities: ["schedules.job.update"],
  scopes: { sources: "*", accounts: "*", scheduleSources: ["vpass"] },
  notAfter: "2099-01-01T00:00:00.000Z",
  delegationRef: `dlg_${"a".repeat(64)}`,
  budget: { writesPerDay: 2 },
};
const payload = {
  jobId: "vpass",
  source: "vpass",
  revision: 1,
  enabled: false,
  timezone: "Asia/Tokyo",
  pattern: { kind: "daily", time: "06:00", weekdays: [0, 1, 2, 3, 4, 5, 6] },
};
test("closed job schema rejects hidden authority and invalid native fields; JSON Schema includes the real pattern", () => {
  expect(delegatedJobPayloadSchema.safeParse(payload).success).toBe(true);
  expect(
    delegatedJobSchema.safeParse({ ...payload, step: "prepare", idempotencyKey: "one" }).success,
  ).toBe(true);
  for (const change of [
    { source: undefined },
    { source: "Not-a-source" },
    { revision: 0 },
    { revision: 1.5 },
    { enabled: "false" },
    { timezone: "Europe/London" },
    { actor: "human" },
    { confirmationDigest: "bad" },
    { pattern: { kind: "daily", time: "24:00", weekdays: [1] } },
    { pattern: { kind: "daily", time: "06:00", weekdays: [1, 1] } },
    { pattern: { kind: "daily", time: "06:00", weekdays: [7] } },
    { pattern: { kind: "daily", time: "06:00", weekdays: [], minutes: 5 } },
    { pattern: { kind: "interval", minutes: 4 } },
    { pattern: { kind: "interval", minutes: 1441 } },
    { pattern: { kind: "interval", minutes: 5, time: "06:00" } },
  ])
    expect(
      delegatedJobSchema.safeParse({
        ...payload,
        step: "prepare",
        idempotencyKey: "one",
        ...change,
      }).success,
    ).toBe(false);
  const advertised = JSON.stringify(z.toJSONSchema(delegatedJobSchema));
  for (const field of ["daily", "interval", "weekdays", "minutes", "additionalProperties"])
    expect(advertised).toContain(field);
});
test("schedule authority is exact and closed; source-only grant cannot affect a global or another source job", () => {
  const auth = executionFor(p, "schedules.job.update", {
    namespace: "schedule-source",
    source: "vpass",
  });
  expect(auth.schedule).toEqual({ operation: "schedules.job.update", source: "vpass" });
  expect(validDelegatedExecution(auth)).toBe(true);
  expect(executionFor(p).schedule).toBeUndefined();
  for (const scope of [null, { namespace: "schedule-source" as const, source: "sony-bank" }])
    expect(() => executionFor(p, "schedules.job.update", scope)).toThrow(
      "capability_not_delegated",
    );
  expect(() =>
    executionFor(p, "schedules.maintenance.update", {
      namespace: "schedule-source",
      source: "vpass",
    }),
  ).toThrow("capability_not_delegated");
  expect(() =>
    executionFor(p, "schedules.lease.release", { namespace: "schedule-source", source: "vpass" }),
  ).toThrow("operation_not_delegable");
  expect(
    executionFor(
      { ...p, scopes: { ...p.scopes, scheduleSources: "*" } },
      "schedules.job.update",
      null,
    ).schedule,
  ).toEqual({ operation: "schedules.job.update", source: null });
  for (const schedule of [
    {},
    { operation: "schedules.job.update" },
    { operation: "schedules.job.update", source: undefined },
    { operation: "schedules.job.update", source: "vpass", delegator: "other" },
    { operation: "schedules.lease.release", source: "vpass" },
    { operation: { toString: () => "schedules.job.update" }, source: "vpass" },
    { operation: "schedules.job.update", source: "Vpass" },
  ])
    expect(validDelegatedExecution({ ...auth, schedule })).toBe(false);
});

test("closed save results distinguish native reservation from replay without claiming a current alarm", () => {
  const saved = {
    saved: true,
    jobId: "vpass",
    revision: 2,
    replayed: false,
    reservation: "pending",
    actualAlarmAt: null,
  };
  for (const reservation of ["pending", "disabled", "armed"])
    expect(delegatedJobResultSchema.safeParse({ ...saved, reservation }).success).toBe(true);
  expect(
    delegatedJobResultSchema.safeParse({
      ...saved,
      reservation: "armed",
      actualAlarmAt: "2099-01-01T00:00:00.000Z",
    }).success,
  ).toBe(true);
  expect(
    delegatedJobResultSchema.safeParse({ ...saved, replayed: true, reservation: null }).success,
  ).toBe(true);
  for (const change of [
    { reservation: null },
    { replayed: true },
    { reservation: "synced" },
    { actualAlarmAt: "private detail" },
    { providerText: "private detail" },
  ])
    expect(delegatedJobResultSchema.safeParse({ ...saved, ...change }).success).toBe(false);
});
