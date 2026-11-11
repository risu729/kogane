// Synthetic raw Vpass responses, parsed through the real local pipeline.
import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { vpassCreditSnapshot } from "../../../packages/parsers/src/parsers/vpass-credit.ts";
import { authori, revo } from "../../../packages/parsers/test/fixtures/vpass-credit.ts";
import { runParsers } from "../src/parse.ts";
import { latestBalances } from "../src/queries.ts";
import {
  insertFetchRun,
  insertFetchUnitOutcome,
  insertFetchArtifact,
  putRawObject,
  upsertSource,
  type Store,
} from "../src/store.ts";
import { closeStores, database } from "./snapshot-fixture.ts";
import { openTestStore } from "./test-store.ts";
afterEach(closeStores);

function capture(
  store: Store,
  day: number,
  cards: readonly { card: number; outcome: "success" | "failed"; malformedRevo?: boolean }[],
) {
  upsertSource(store, { id: "vpass", provider: "Synthetic Vpass", ingestion: "collector-r2" });
  const time = `2026-09-0${day}T00:00:00.000Z`;
  const partial = cards.some((card) => card.outcome === "failed");
  const runId = insertFetchRun(store, {
    sourceId: "vpass",
    externalRunId: `synthetic-vpass-${day}`,
    tool: "synthetic-vpass",
    startedAt: time,
    completedAt: time,
    status: partial ? "partial" : "success",
    failureCount: partial ? 1 : 0,
  });
  for (const { card, outcome, malformedRevo } of cards) {
    const unitKey = `card-${String(card).padStart(3, "0")}`;
    insertFetchUnitOutcome(store, {
      fetchRunId: runId,
      unitKey,
      unitOutcome: outcome,
      ...(outcome === "failed" ? { failureCode: "synthetic-fetch-failed" } : {}),
    });
    for (const [artifactKey, value] of [
      ["credit/authori.json", authori(String(100 + card + day))],
      ["credit/revo.json", revo(malformedRevo ? "unreadable" : `+${100000 + card + day}`)],
    ] as const) {
      const raw = putRawObject(
        store,
        new TextEncoder().encode(JSON.stringify(value)),
        "application/json",
      );
      insertFetchArtifact(store, {
        fetchRunId: runId,
        sourceId: "vpass",
        dataset: "credit-snapshot",
        fetchUnitKey: unitKey,
        artifactKey,
        fetchedAt: time,
        mime: "application/json",
        sha256: raw.sha256,
      });
    }
  }
}
const outstanding = (store: Store, card: number) =>
  latestBalances(store).find(
    (row) =>
      row.source_account === `vpass:card-${String(card).padStart(3, "0")}` &&
      row.metric === "reported_card_outstanding_thousand_yen",
  )?.amount_text;

test("the real local parser runner publishes independent Vpass card units and requires both complete response artifacts", () => {
  const store = database();
  capture(store, 1, [
    { card: 1, outcome: "success" },
    { card: 2, outcome: "success" },
  ]);
  expect(runParsers(store, [vpassCreditSnapshot])).toMatchObject({
    parsed: 4,
    observations: 28,
    errors: 0,
    blocked: 0,
  });
  expect(latestBalances(store)).toHaveLength(28);
  expect(outstanding(store, 1)).toBe("102000");
  expect(outstanding(store, 2)).toBe("103000");

  capture(store, 2, [
    { card: 1, outcome: "success" },
    { card: 2, outcome: "failed" },
  ]);
  expect(runParsers(store, [vpassCreditSnapshot])).toMatchObject({
    parsed: 2,
    observations: 14,
    errors: 0,
    blocked: 2,
  });
  expect(latestBalances(store)).toHaveLength(28);
  expect(outstanding(store, 1)).toBe("103000");
  expect(outstanding(store, 2)).toBe("103000");
  expect(
    store.db
      .query(
        "SELECT DISTINCT unit_scope,parent_run_status,unit_report_outcome FROM parse_coverage_claims WHERE parent_run_status='partial'",
      )
      .all(),
  ).toEqual([{ unit_scope: "unit", parent_run_status: "partial", unit_report_outcome: "success" }]);

  // One unreadable companion response cannot make the newer card snapshot complete.
  capture(store, 3, [{ card: 1, outcome: "success", malformedRevo: true }]);
  expect(runParsers(store, [vpassCreditSnapshot])).toMatchObject({
    parsed: 1,
    errors: 1,
    blocked: 2,
  });
  expect(outstanding(store, 1)).toBe("103000");
  expect(outstanding(store, 2)).toBe("103000");
  expect(latestBalances(store)).toHaveLength(28);
});

test("reopening mirrors the exact 0092 policy once and preserves an operator's rollback and version pin", () => {
  const store = database();
  const policy = () =>
    store.db
      .query(
        "SELECT policy_id,required_parser_version,replaces_previous_on_complete_empty,unit_scope,snapshot_selection FROM dataset_snapshot_policies WHERE parser_name='vpass-credit-snapshot'",
      )
      .get();
  expect(policy()).toEqual({
    policy_id: "coverage-v1",
    required_parser_version: "1.0.1",
    replaces_previous_on_complete_empty: 0,
    unit_scope: "unit",
    snapshot_selection: 1,
  });
  store.db.exec(
    "UPDATE dataset_snapshot_policies SET unit_scope='run',required_parser_version='9.0.0' WHERE parser_name='vpass-credit-snapshot'",
  );
  const reopened = openTestStore(join(store.blobDir, ".."));
  try {
    expect(
      reopened.db
        .query(
          "SELECT unit_scope,required_parser_version FROM dataset_snapshot_policies WHERE parser_name='vpass-credit-snapshot'",
        )
        .get(),
    ).toEqual({ unit_scope: "run", required_parser_version: "9.0.0" });
  } finally {
    reopened.db.close();
  }
});
