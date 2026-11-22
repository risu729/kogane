// `insertRunReportIfAbsent` binds every column by name. It used to bind
// `Object.values(fields)` in the order the caller happened to build the object,
// so a report whose fields were listed in any other order stored each value in
// another column (a status as a version, a count as a basis), and nothing in
// the type said the order mattered. Synthetic values only.
import { beforeAll, expect, test } from "bun:test";
import {
  insertRunReportIfAbsent,
  readRunReport,
  type RunReportFields,
} from "../src/core/fetch-runs.ts";
import { CLIENT, EMPTY_RUN_ID, pilotDatabase } from "./core-fixture.ts";
import { fullCoreDatabase, sqliteD1 } from "./sqlite.ts";

beforeAll(() => {
  fullCoreDatabase().close();
}, 60_000);

const FIELDS: RunReportFields = {
  producer_version: "v2",
  producer_revision: "rev2",
  manifest_schema_version: "manifest-v1",
  producer_status: "running",
  normalized_outcome: "running",
  started_at_ms: 900,
  started_at_basis: "manifest",
  completed_at_ms: null,
  completed_at_basis: null,
  declared_artifact_count: 2,
  artifact_count_scope: "all_catalogued",
};

test("a report's fields land in their own columns whatever order the object lists them in", async () => {
  const db = sqliteD1(pilotDatabase());
  const reversed = Object.fromEntries(Object.entries(FIELDS).reverse()) as RunReportFields;
  await insertRunReportIfAbsent(
    db,
    EMPTY_RUN_ID,
    "progress-2",
    "progress",
    CLIENT,
    reversed,
    1_000,
  );
  const { id: _id, ...stored } = (await readRunReport(db, EMPTY_RUN_ID, "progress-2"))!;
  expect(stored).toEqual({ report_kind: "progress", recorded_by_client_id: CLIENT, ...FIELDS });
});

test("a field the type does not declare is never bound", async () => {
  const db = sqliteD1(pilotDatabase());
  const wider = { ...FIELDS, report_key: "synthetic-extra" } as RunReportFields;
  await insertRunReportIfAbsent(db, EMPTY_RUN_ID, "progress-3", "progress", CLIENT, wider, 1_000);
  const { id: _id, ...stored } = (await readRunReport(db, EMPTY_RUN_ID, "progress-3"))!;
  expect(stored).toEqual({ report_kind: "progress", recorded_by_client_id: CLIENT, ...FIELDS });
});
