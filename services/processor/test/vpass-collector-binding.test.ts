// ADR 0023 option 3: the Vpass collector writes the card binding, the trusted
// binding view admits it, identity policy 2 binds the collector's rows, and
// card purchase recognition moves from the importer's producer to the
// collector's without losing the account entity.
//
// Two substrates, each for what it can prove:
//
//  * the whole CORE schema (bun:sqlite, every migration) for registration:
//    the collector's real card-run plan, persisted into an in-memory R2 and
//    registered through the Processor's in-process port, then the trusted
//    view, the parse of a statement page by the deployed parser, and identity
//    with its pin and seal triggers, all on what registration wrote;
//  * the Miniflare card world for the purchase lane, with the collector's
//    binding in the shape the first part registers.
//
// Everything is synthetic: the card tuple, the keys, the card names, the
// merchants and the amounts are placeholders in the observed shapes.
import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { fullCoreDatabase, sqliteD1 } from "../../../packages/storage-d1/test/sqlite.ts";
import { splitSqlStatements } from "../../../packages/storage-d1/src/migrations.ts";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket.ts";
import { objectKey } from "../../../packages/collection/src/keys.ts";
import { persistRun } from "../../../packages/collection/src/writer.ts";
import { resolveIdentity } from "../../../packages/identity/src/index.ts";
import { vpassStatementPage } from "../../../packages/parsers/src/parsers/vpass.ts";
import type { Observation } from "../../../packages/parsers/src/types.ts";
import { registerCollectionRun, type CollectionEnv } from "../src/collection/index.ts";
import type { CardPurchaseSweepResult } from "../src/card-purchase-job.ts";
import { identifyParse } from "../src/identity-store.ts";
import {
  vpassCardRunPlan,
  type VpassCardRun,
} from "../../collector-vpass/src/shared-collection.ts";
import {
  disposeWorlds,
  meta,
  PRODUCER,
  TOKEN_A,
  TOKEN_B,
  vpassPayload,
  world,
  type UsageRow,
} from "./card-purchase-world.ts";
import { publishParse } from "./harness.ts";

afterEach(disposeWorlds);

const CLIENT = "processor-shared-r2";
const COLLECTOR = "collector-vpass";
const SESSION = "2026-09-01T00-00-00-000Z";
const KEY = "5e".repeat(32);
const TUPLE = { externalId: "E".repeat(32), globalid: "G".repeat(32), cardCode: "C".repeat(13) };
const ROWS: UsageRow[] = [
  { date: "26/08/03", merchant: "架空店舗C", amount: "1,234", paymentType: "1" },
];

// ---------------------------------------------------------------------------
// Registration, the view, parse and identity on the whole CORE schema
// ---------------------------------------------------------------------------

function harness(): { db: Database; bucket: FakeR2Bucket; env: CollectionEnv } {
  const db = fullCoreDatabase();
  // The registry exactly as an operator applies it.
  const bootstrap = readFileSync(
    new URL("../../../infra/bootstrap/ingest-clients.sql", import.meta.url),
    "utf8",
  );
  for (const statement of splitSqlStatements(bootstrap)) db.exec(statement);
  const bucket = new FakeR2Bucket();
  return {
    db,
    bucket,
    env: {
      DB: sqliteD1(db) as CollectionEnv["DB"],
      EVIDENCE: bucket as unknown as CollectionEnv["EVIDENCE"],
      SHARED_R2_INGEST_ENABLED: "true",
      COLLECTION_INGEST_CLIENT: CLIENT,
      COLLECTION_DATA_BUCKET: "kogane-raw-evidence",
      COLLECTION_ACCOUNT_ID: "0123456789abcdef0123456789abcdef",
    },
  };
}

const envelope = (content: Record<string, unknown>, bean?: Record<string, unknown>) =>
  JSON.stringify({
    header: { resultCode: 0, ...(bean === undefined ? {} : { vpSessionBean: bean }) },
    body: { content },
  });
const bean = { ...TUPLE, cardName: "SYNTHETIC CARD" };

function collectorCardRun(overrides: Partial<VpassCardRun> = {}): VpassCardRun {
  return {
    sessionRunId: SESSION,
    cardLabel: "card-001",
    startedAt: "2026-09-01T00:00:00.000Z",
    completedAt: "2026-09-01T00:05:00.000Z",
    cardListRawJson: envelope({
      DropdownListInitDisplayServiceBean: {
        multiCardInfoList: [
          { name: "SYNTHETIC CARD", value: "synthetic-selector-1" },
          { name: "SECOND SYNTHETIC CARD", value: "synthetic-selector-2" },
        ],
      },
    }),
    selectCardRawJson: envelope({ MultiCardUpdateBean: {} }, bean),
    webMeisaiTopRawJson: envelope({ WebMeisaiTopDisplayServiceBean: {} }, bean),
    months: {
      "202608": {
        pages: [
          { kind: "top", index: 0, rawJson: JSON.stringify(vpassPayload("web", "202608", ROWS)) },
        ],
        transactionCount: ROWS.length,
      },
    },
    ...overrides,
  };
}

/** The importer's token construction, written out independently of the collector. */
async function importerToken(key: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(key.match(/../gu)!, (pair) => Number.parseInt(pair, 16)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    new TextEncoder().encode(
      JSON.stringify(["vpass-card-binding-v1", TUPLE.externalId, TUPLE.globalid, TUPLE.cardCode]),
    ),
  );
  return `vpass-card-v1-${Buffer.from(mac).toString("hex")}`;
}

async function registered(key: string | undefined) {
  const h = harness();
  const plan = await vpassCardRunPlan(collectorCardRun(), key);
  expect(plan.run.producer).toBe(COLLECTOR);
  expect((await persistRun(h.bucket, plan)).outcome).toBe("persisted");
  const result = await registerCollectionRun(h.env, { source: "vpass", runId: plan.run.runId });
  expect(result).toMatchObject({ outcome: "registered", artifacts: plan.artifacts.length });
  if (result.outcome !== "registered") throw new Error("unreachable");
  const all = <T>(sql: string, ...binds: unknown[]) =>
    h.db.query(sql).all(...(binds as never[])) as T[];
  const one = <T>(sql: string, ...binds: unknown[]) =>
    h.db.query(sql).get(...(binds as never[])) as T;

  /** Parse the statement page with the deployed parser, as the parse lane would. */
  async function parsePage(): Promise<number> {
    const page = one<{ id: number; sha256: string; artifact_key: string; unit_key: string }>(
      `SELECT a.id,a.sha256,a.artifact_key,u.unit_key FROM fetch_artifacts a
         JOIN fetch_units u ON u.id=a.fetch_unit_id
        WHERE a.fetch_run_id=? AND a.artifact_key GLOB 'months/*'`,
      result.fetchRunId,
    );
    const stored = await h.bucket.get(objectKey(page.sha256));
    const bytes = new Uint8Array(await stored!.arrayBuffer());
    const parse = one<{ id: number }>(
      `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
       VALUES(?,?,?,'2026-09-01','pending','[]') RETURNING id`,
      page.id,
      vpassStatementPage.name,
      vpassStatementPage.version,
    ).id;
    const parsed = vpassStatementPage.parse(
      bytes,
      meta(page.id, "vpass", "statement-page", page.artifact_key, "2026-09-01T00:05:00.000Z", {
        fetchUnitKey: page.unit_key,
      }),
    ).observations as Observation[];
    let rows = 0;
    for (const row of parsed) {
      if (row.kind !== "transaction") continue;
      rows += 1;
      h.db
        .query(
          `INSERT INTO transaction_observations(parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,currency,description,counterparty,as_of,observed_at,raw_locator,extra_json)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          parse,
          row.sourceAccount,
          row.externalId ?? null,
          row.status ?? null,
          row.amountMinor ?? null,
          row.amountText ?? null,
          row.amountScale ?? null,
          row.currency ?? null,
          row.description ?? null,
          row.counterparty ?? null,
          row.asOf ?? null,
          row.observedAt ?? null,
          row.rawLocator,
          JSON.stringify(row.extra),
        );
    }
    expect(rows).toBe(ROWS.length);
    h.db.query("UPDATE parse_runs SET status='ok' WHERE id=?").run(parse);
    await publishParse(h.env.DB as never, parse);
    await identifyParse(
      h.env.DB as never,
      {
        id: parse,
        artifact_id: page.id,
        source_id: "vpass",
        producer_id: COLLECTOR,
        fetch_run_id: result.fetchRunId,
      },
      resolveIdentity,
    );
    return parse;
  }
  return { h, plan, run: result.fetchRunId, all, one, parsePage };
}

describe("ADR 0023 a registered collector card run", () => {
  test("with the key: the binding registers, the view admits it, and identity policy 2 binds the rows to the importer's token", async () => {
    const token = await importerToken(KEY);
    const { plan, run, all, one, parsePage } = await registered(KEY);
    expect(plan.run.units.map((unit) => unit.unitKey)).toEqual(["card-001", token]);

    // Registration wrote the run shape the view's shared-R2 branch reads.
    expect(one("SELECT status,failure_count FROM observation_fetch_runs WHERE id=?", run)).toEqual({
      status: "success",
      failure_count: 0,
    });
    expect(
      one(
        `SELECT s.external_id_namespace AS namespace, r.producer_id AS producer, r.source_run_key AS run_key
           FROM fetch_runs r JOIN acquisition_sessions s ON s.id=r.acquisition_session_id WHERE r.id=?`,
        run,
      ),
    ).toEqual({
      namespace: "shared-r2",
      producer: COLLECTOR,
      run_key: `${SESSION}-card-001:terminal-registration-v1`,
    });
    const binding = one<Record<string, unknown>>(
      `SELECT a.id,a.artifact_role,a.dataset,a.format_id,a.format_version,a.payload_fidelity,
              a.lineage_disposition,u.unit_key,u.unit_kind,
              (SELECT group_concat(t.step_kind) FROM artifact_transform_steps t WHERE t.fetch_artifact_id=a.id) AS steps
         FROM fetch_artifacts a JOIN fetch_units u ON u.id=a.fetch_unit_id
        WHERE a.fetch_run_id=? AND a.artifact_key='card-identity-binding.json'`,
      run,
    );
    expect(binding).toMatchObject({
      artifact_role: "collector_derived",
      dataset: "card-identity-binding",
      format_id: "vpass-card-identity-binding-json",
      format_version: "1",
      payload_fidelity: "transformed",
      lineage_disposition: "source_bytes_not_available",
      unit_key: token,
      unit_kind: "card",
      steps: "extracted",
    });
    // Only the binding carries a dataset here: the statement pages' dataset is
    // the registration table's (ADR 0022), not this change's.
    expect(
      all<{ n: number }>(
        "SELECT count(*) AS n FROM fetch_artifacts WHERE fetch_run_id=? AND dataset IS NOT NULL",
        run,
      ),
    ).toEqual([{ n: 1 }]);

    // Every financial artifact of the card unit binds to the one token.
    const trusted = all<{
      card_token: string;
      financial_unit_key: string;
      binding_artifact_id: number;
    }>("SELECT card_token,financial_unit_key,binding_artifact_id FROM trusted_vpass_card_bindings");
    expect(trusted).toHaveLength(4);
    for (const row of trusted) {
      expect(row).toEqual({
        card_token: token,
        financial_unit_key: "card-001",
        binding_artifact_id: binding["id"] as number,
      });
    }

    // Identity: policy 2 selected through the view, the pin and seal triggers
    // (which join the view) accepted it, and the rows resolve to the token.
    await parsePage();
    expect(one("SELECT policy_family,policy_version FROM identity_run_contexts")).toEqual({
      policy_family: "vpass-card-binding",
      policy_version: 2,
    });
    expect(all("SELECT card_token FROM identity_vpass_bindings")).toEqual([{ card_token: token }]);
    expect(one<{ n: number }>("SELECT count(*) AS n FROM identity_run_seals").n).toBe(1);
    expect(
      all(
        `SELECT a.producer_id,a.reference_json,m.status,m.reason FROM current_identity_observations o
           JOIN source_accounts a ON a.id=o.source_account_id
           JOIN current_account_mappings m ON m.source_account_id=a.id`,
      ),
    ).toEqual([
      {
        producer_id: COLLECTOR,
        reference_json: JSON.stringify(["vpass:card", token]),
        status: "provider-local",
        reason: "verified-collector-durable-card-binding",
      },
    ]);
  }, 30_000);

  test("without the key: no binding, the view is empty, and the rows stay run-scoped and unresolved", async () => {
    const { plan, run, all, one, parsePage } = await registered(undefined);
    expect(plan.run.units.map((unit) => unit.unitKey)).toEqual(["card-001"]);
    expect(
      one<{ n: number }>(
        "SELECT count(*) AS n FROM fetch_artifacts WHERE fetch_run_id=? AND artifact_key='card-identity-binding.json'",
        run,
      ).n,
    ).toBe(0);
    expect(all("SELECT * FROM trusted_vpass_card_bindings")).toEqual([]);
    await parsePage();
    expect(one("SELECT policy_family FROM identity_run_contexts")).toEqual({
      policy_family: "identity-default",
    });
    expect(all("SELECT * FROM identity_vpass_bindings")).toEqual([]);
    expect(
      all(
        `SELECT a.reference_json,m.status FROM current_identity_observations o
           JOIN source_accounts a ON a.id=o.source_account_id
           JOIN current_account_mappings m ON m.source_account_id=a.id`,
      ),
    ).toEqual([
      {
        reference_json: JSON.stringify(["vpass:card-001", "fetch-run", String(run)]),
        status: "unresolved",
      },
    ]);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// The purchase lane across the producer switch, in the card world
// ---------------------------------------------------------------------------

function counts(result: CardPurchaseSweepResult) {
  return {
    recognized: result.recognized,
    revised: result.revised,
    reanchored: result.reanchored,
    retired: result.retired,
    conflicts: result.conflicts,
    failed: result.failed,
  };
}
const NOTHING = { recognized: 0, revised: 0, reanchored: 0, retired: 0, conflicts: 0, failed: 0 };

/** Live (not retired) purchase events: their producer, account and state. */
const LIVE = `SELECT json_extract(k.recognition_key,'$[1]') AS producer, c.account_id, c.state
  FROM current_card_purchase_recognitions c
  JOIN current_card_purchase_keys k ON k.event_id=c.event_id AND k.revision=c.revision
  WHERE c.state IN ('captured','authorized') ORDER BY producer, c.account_id`;

/**
 * Every row a snapshot held is still there and unchanged, except that a
 * revision's `superseded_by` pointer may be set once (null to the successor):
 * the importer's revisions are kept, never rewritten or removed.
 */
function appendOnly(before: Record<string, unknown>, after: Record<string, unknown>): void {
  const stable = (row: unknown) => {
    const { superseded_by: _pointer, ...rest } = row as Record<string, unknown>;
    return JSON.stringify(rest);
  };
  for (const [table, rows] of Object.entries(before)) {
    const now = new Set((after[table] as unknown[]).map(stable));
    for (const row of rows as unknown[]) {
      expect([table, now.has(stable(row))]).toEqual([table, true]);
    }
    expect((after[table] as unknown[]).length).toBeGreaterThanOrEqual((rows as unknown[]).length);
  }
}

describe("ADR 0023 the view's shared-R2 branch keeps the importer's evidence requirements", () => {
  const TRUSTED =
    "SELECT count(*) AS n FROM trusted_vpass_card_bindings WHERE financial_artifact_id=?";

  test("one binding unit and artifact in a successful collector run, nothing more and nothing less", async () => {
    const w = await world();
    let card = 0;
    const capture = async (options: { producer?: string; token?: string | null } = {}) =>
      w.vpass({
        family: "web",
        card: `card-${String((card += 1)).padStart(3, "0")}`,
        fetchedAt: "2026-09-27T00:00:00.000Z",
        rows: ROWS,
        producer: options.producer ?? COLLECTOR,
        binding: "collector",
        token: options.token === undefined ? TOKEN_A : options.token,
        identify: null,
      });
    const bindingUnit = (run: number) =>
      w.all<{ id: number }>(
        "SELECT id FROM fetch_units WHERE fetch_run_id=? AND unit_key=?",
        run,
        TOKEN_A,
      );

    const trusted = await capture();
    expect(await w.count(TRUSTED, trusted.artifact)).toBe(1);

    // The importer's producer in the collector's shape: its branch requires a sibling run.
    const importer = await capture({ producer: PRODUCER });
    expect(await w.count(TRUSTED, importer.artifact)).toBe(0);

    // Another namespace.
    const namespace = await capture();
    await w.db
      .prepare(
        "UPDATE acquisition_sessions SET external_id_namespace='vpass-worker-card-v1' WHERE id=?",
      )
      .bind(namespace.run)
      .run();
    expect(await w.count(TRUSTED, namespace.artifact)).toBe(0);

    // A run key that names another card ordinal.
    const runKey = await capture();
    await w.db
      .prepare("UPDATE fetch_runs SET source_run_key=? WHERE id=?")
      .bind(`run-${runKey.run}-card-999:terminal-registration-v1`, runKey.run)
      .run();
    expect(await w.count(TRUSTED, runKey.artifact)).toBe(0);

    // A third unit in the run.
    const third = await capture();
    await w.db
      .prepare(
        "INSERT INTO fetch_units(id,fetch_run_id,unit_key,unit_kind) VALUES(?,?,'card-900','card')",
      )
      .bind(900_001, third.run)
      .run();
    expect(await w.count(TRUSTED, third.artifact)).toBe(0);

    // A second binding artifact in the run.
    const second = await capture();
    await w.db
      .prepare(
        "INSERT INTO fetch_artifacts(id,fetch_run_id,source_id,dataset,artifact_key,fetch_unit_id,artifact_role,format_id,format_version) VALUES(?,?,'vpass','card-identity-binding','other-binding.json',?,'collector_derived','vpass-card-identity-binding-json','1')",
      )
      .bind(900_002, second.run, (await bindingUnit(second.run))[0]!.id)
      .run();
    expect(await w.count(TRUSTED, second.artifact)).toBe(0);

    // A binding unit whose terminal report is not a success.
    const partial = await capture();
    await w.db
      .prepare("UPDATE fetch_unit_reports SET normalized_outcome='partial' WHERE fetch_unit_id=?")
      .bind((await bindingUnit(partial.run))[0]!.id)
      .run();
    expect(await w.count(TRUSTED, partial.artifact)).toBe(0);

    // A token of the wrong shape.
    const shape = await capture({ token: `vpass-card-v1-${"A".repeat(64)}` });
    expect(await w.count(TRUSTED, shape.artifact)).toBe(0);

    // No binding at all.
    const none = await capture({ token: null });
    expect(await w.count(TRUSTED, none.artifact)).toBe(0);
  }, 60_000);
});

describe("ADR 0023 purchase recognition moves to the collector's binding", () => {
  test("the importer's event of the card-month retires and is recognised again once, on the same account entity", async () => {
    const w = await world();
    await w.vpass({
      family: "web",
      card: "card-001",
      month: "202608",
      fetchedAt: "2026-08-10T00:00:00.000Z",
      rows: ROWS,
    });
    expect(counts(await w.sweep())).toEqual({ ...NOTHING, recognized: 1 });
    const before = await w.all<{ producer: string; account_id: string }>(LIVE);
    expect(before.map((row) => row.producer)).toEqual([PRODUCER]);
    expect(await w.totals()).toMatchObject({ captured: "1234", unresolved: 0 });
    const snapshot = await w.snapshot();

    // The collector's capture of the same card-month, bound in its own run to
    // the same token (the same key derives the same token).
    await w.vpass({
      family: "web",
      card: "card-001",
      month: "202608",
      fetchedAt: "2026-09-27T00:00:00.000Z",
      rows: ROWS,
      producer: COLLECTOR,
      binding: "collector",
      token: TOKEN_A,
    });
    const usage = await w.usage();
    expect(usage.map((row) => [row.producer_id, row.policy_family, row.account_status])).toEqual([
      [COLLECTOR, "vpass-card-binding", "provider-local"],
    ]);

    expect(counts(await w.sweep())).toEqual({ ...NOTHING, recognized: 1, retired: 1 });
    const after = await w.all<{ producer: string; account_id: string }>(LIVE);
    expect(after.map((row) => row.producer)).toEqual([COLLECTOR]);
    // Two source accounts, one per producer, and one account entity.
    expect(after.map((row) => row.account_id)).toEqual(before.map((row) => row.account_id));
    expect(
      await w.all(
        `SELECT a.producer_id, m.account_id FROM source_accounts a
           JOIN current_account_mappings m ON m.source_account_id=a.id
          WHERE a.source_id='vpass' ORDER BY a.producer_id`,
      ),
    ).toEqual([
      { producer_id: PRODUCER, account_id: before[0]!.account_id },
      { producer_id: COLLECTOR, account_id: before[0]!.account_id },
    ]);
    // Nothing counted twice: the retired importer event is an `unknown`
    // revision the summary counts as unresolved, the captured total is kept.
    expect(await w.totals()).toMatchObject({ captured: "1234", unresolved: 1 });
    appendOnly(snapshot, await w.snapshot());
    expect(counts(await w.sweep())).toEqual(NOTHING);
  }, 60_000);

  test("without the collector's binding its rows are skipped as account_not_resolved", async () => {
    const w = await world();
    await w.vpass({
      family: "web",
      card: "card-001",
      month: "202608",
      fetchedAt: "2026-08-10T00:00:00.000Z",
      rows: ROWS,
    });
    expect(counts(await w.sweep())).toEqual({ ...NOTHING, recognized: 1 });
    await w.vpass({
      family: "web",
      card: "card-001",
      month: "202608",
      fetchedAt: "2026-09-27T00:00:00.000Z",
      rows: ROWS,
      producer: COLLECTOR,
      binding: "collector",
      token: null,
    });
    const usage = await w.usage();
    expect(usage.map((row) => [row.producer_id, row.policy_family, row.account_status])).toEqual([
      [COLLECTOR, "identity-default", "unresolved"],
    ]);
    const result = await w.sweep();
    expect(counts(result)).toEqual({ ...NOTHING, retired: 1 });
    expect(result.skipped).toMatchObject({ account_not_resolved: 1 });
    expect(await w.all(LIVE)).toEqual([]);
  }, 60_000);

  test("a token derived under another key is another account entity: nothing carries over, nothing is counted twice", async () => {
    const w = await world();
    await w.vpass({
      family: "web",
      card: "card-001",
      month: "202608",
      fetchedAt: "2026-08-10T00:00:00.000Z",
      rows: ROWS,
    });
    expect(counts(await w.sweep())).toEqual({ ...NOTHING, recognized: 1 });
    const before = await w.all<{ account_id: string }>(LIVE);
    await w.vpass({
      family: "web",
      card: "card-001",
      month: "202608",
      fetchedAt: "2026-09-27T00:00:00.000Z",
      rows: ROWS,
      producer: COLLECTOR,
      binding: "collector",
      token: TOKEN_B,
    });
    expect(counts(await w.sweep())).toEqual({ ...NOTHING, recognized: 1, retired: 1 });
    const after = await w.all<{ producer: string; account_id: string }>(LIVE);
    expect(after.map((row) => row.producer)).toEqual([COLLECTOR]);
    expect(after[0]!.account_id).not.toBe(before[0]!.account_id);
    expect(await w.totals()).toMatchObject({ captured: "1234", unresolved: 1 });
  }, 60_000);
});
