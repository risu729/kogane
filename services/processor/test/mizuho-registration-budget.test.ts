// The largest complete run the Mizuho collector writes — the account list plus
// the first history page of each of its ten accounts, eleven artifacts — built
// by the collector's own `mizuhoRunPlan`, registers in one invocation of the
// per-invocation operation budget (#250). A partial run, with a failed unit
// for each account past that limit, persists and registers too. Synthetic
// HTML only.
import { expect, test } from "bun:test";
import {
  REGISTRATION_OPERATION_BUDGET,
  RegistrationBudget,
  registerTerminal,
} from "../../../packages/application/src/collection/index.ts";
import { persistRun } from "../../../packages/collection/src/writer.ts";
import { sanitizeMizuhoPage } from "../../../packages/parsers/src/parsers/mizuho-html.ts";
import {
  mizuhoAccountCard,
  mizuhoAccountHtml,
  mizuhoHistoryHtml,
} from "../../../packages/parsers/test/mizuho-fixture.ts";
import type { MizuhoArtifact } from "../../collector-mizuho/src/client.ts";
import { mizuhoRunPlan } from "../../collector-mizuho/src/storage.ts";
import { CLIENT, collectionHarness } from "./collection-harness.ts";

const ACCOUNTS = 10;
const account = (index: number) => String(1_234_560 + index);

async function persistedRun(pastLimit: number) {
  const harness = collectionHarness();
  harness.db.exec(`
    INSERT OR IGNORE INTO producers (id, kind, display_name)
      VALUES ('collector-mizuho-bank', 'collector', 'Mizuho collector');
    INSERT INTO producer_sources (producer_id, source_id)
      VALUES ('collector-mizuho-bank', 'mizuho-bank');
    INSERT INTO ingest_client_producers (ingest_client_id, producer_id)
      VALUES ('${CLIENT}', 'collector-mizuho-bank');
    INSERT INTO ingest_client_routes (ingest_client_id, producer_id, source_id)
      VALUES ('${CLIENT}', 'collector-mizuho-bank', 'mizuho-bank');
  `);
  const cards = Array.from({ length: ACCOUNTS }, (_, index) =>
    mizuhoAccountCard(String(index).padStart(3, "0"), `001-${account(index)}`),
  ).join("");
  const artifacts: MizuhoArtifact[] = [
    {
      artifactKey: "account-list.html",
      unitKey: "account-list",
      dataset: "mizuho-account-list-html",
      body: sanitizeMizuhoPage(mizuhoAccountHtml(cards)),
      mediaType: "text/html",
      partial: false,
    },
    ...Array.from({ length: ACCOUNTS }, (_, index) => ({
      artifactKey: `ordinary/001-${account(index)}/history/1-1.html`,
      unitKey: `ordinary:001:${account(index)}:page:1:1`,
      dataset: "mizuho-ordinary-history-html" as const,
      body: sanitizeMizuhoPage(mizuhoHistoryHtml().replace("1234567", account(index))),
      mediaType: "text/html" as const,
      partial: false,
    })),
  ];
  const plan = await mizuhoRunPlan({
    runId: "mizuho-run-001",
    startedAt: "2026-09-01T00:00:00.000Z",
    completedAt: "2026-09-01T00:01:00.000Z",
    version: "mizuho-collector-v1",
    artifacts,
    failedUnits: Array.from(
      { length: pastLimit },
      (_, index) => `ordinary:001:${account(ACCOUNTS + index)}`,
    ),
    partial: pastLimit > 0,
    failed: false,
  });
  expect(plan.artifacts).toHaveLength(ACCOUNTS + 1);
  expect(plan.run.units).toHaveLength(ACCOUNTS + 1 + pastLimit);
  expect((await persistRun(harness.bucket, plan)).outcome).toBe("persisted");
  const register = async () => {
    const budget = new RegistrationBudget(REGISTRATION_OPERATION_BUDGET);
    const outcome = await registerTerminal({
      env: { DB: harness.env.DB, EVIDENCE: harness.env.EVIDENCE },
      bucket: harness.env.EVIDENCE,
      clientId: CLIENT,
      source: "mizuho-bank",
      runId: "mizuho-run-001",
      budget,
    });
    expect(budget.used).toBeLessThanOrEqual(REGISTRATION_OPERATION_BUDGET);
    return outcome;
  };
  const count = (sql: string) => (harness.db.query(sql).get() as { n: number }).n;
  return { plan, register, count };
}

test("a Mizuho run at the collector's account limit registers in one invocation", async () => {
  const { plan, register, count } = await persistedRun(0);
  expect(plan.run.providerOutcome).toBe("success");
  expect(await register()).toMatchObject({ outcome: "registered", artifacts: ACCOUNTS + 1 });
  expect(count("SELECT count(*) AS n FROM fetch_run_seals")).toBe(1);
  expect(count("SELECT count(*) AS n FROM fetch_artifacts WHERE source_id='mizuho-bank'")).toBe(
    ACCOUNTS + 1,
  );
});

test("a partial Mizuho run with accounts past the limit persists and registers", async () => {
  // The manifest refuses a non-success run without a run-level safe error
  // code; before the collector named one, every partial run failed to persist.
  const pastLimit = 15;
  const { plan, register, count } = await persistedRun(pastLimit);
  expect(plan.run).toMatchObject({
    providerOutcome: "partial",
    coverageStatus: "partial",
    safeErrorCode: "collection-unit-failed",
  });
  // Extra units may take a second invocation; the budget resumes, never fails.
  let outcome = await register();
  for (let invocation = 1; outcome.outcome === "pending" && invocation < 3; invocation++)
    outcome = await register();
  expect(outcome).toMatchObject({ outcome: "registered", artifacts: ACCOUNTS + 1 });
  expect(count("SELECT count(*) AS n FROM fetch_run_seals")).toBe(1);
  expect(count("SELECT count(*) AS n FROM fetch_units")).toBe(ACCOUNTS + 1 + pastLimit);
});
