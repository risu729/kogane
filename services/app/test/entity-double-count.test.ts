// Two provider references the current identity mapping maps to one account
// entity are one account, not two (INV06; ADR 0001's amendment of
// 2026-11-20). Before `distinct-identified-accounts-v3` the projection's
// disjointness policy declared them apart (listed apart within one source,
// or identified, or at two listed institutions) without reading the entity,
// so both were adopted and every reader of the adopted set added both
// amounts. Each reader is checked here over the published snapshot the
// Processor's own job builds: the latest page and its known-assets subtotal,
// `kogane.balances.read`, and `holdings` over `/api/v2/query` and
// `kogane.financial.query`.
//
// Every label, amount, date and id is synthetic; only the shapes mirror what
// providers report.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { runBalanceProjection } from "../../processor/src/balance-projection-job";
import { publishParse, seedRegistry, seedRun } from "./fixtures";
import { pageReadHarness } from "./page-read-harness";

const page = pageReadHarness("entity-double-count", { READ_PROJECTION_ENABLED: "true" });

interface SyntheticAccount {
  rawAccount: string;
  amount: number;
  /** Map this reference onto the entity of another raw account instead of its own. */
  entityOf?: string;
}

interface SyntheticCapture {
  source: string;
  dataset?: string;
  parser: string;
  metric: string;
  status: "identified" | "provider-local";
  accounts: SyntheticAccount[];
}

const SOURCES = ["smbc-bank", "sbi-shinsei-bank", "mizuho-bank"];

beforeAll(async () => {
  await seedRegistry();
  await env.DB.batch(
    SOURCES.flatMap((source) => [
      env.DB.prepare(
        "INSERT INTO producer_sources(producer_id,source_id) VALUES ('evidence-test',?)",
      ).bind(source),
      env.DB.prepare(
        "INSERT INTO ingest_client_routes(ingest_client_id,producer_id,source_id) VALUES ('evidence-test','evidence-test',?)",
      ).bind(source),
    ]),
  );
});

/** The account entity id of a raw account, the shape the identity store derives. */
async function entityOf(rawAccount: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(rawAccount));
  return `acc_${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}

/** One published capture of a source's dataset, each account organized by a sealed identity run. */
async function seedCapture(capture: SyntheticCapture): Promise<void> {
  const run = await seedRun({
    count: 1,
    source: capture.source,
    ...(capture.dataset === undefined ? {} : { dataset: capture.dataset }),
  });
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES (?,?,'1','2026-11-18T21:05:00Z','ok','[]') RETURNING id`,
  )
    .bind(run.artifacts[0]!.id, capture.parser)
    .first<{ id: number }>();
  await publishParse(parse!.id, "2026-11-18T21:06:00Z");
  const prefix = `edc-${String(parse!.id)}-`;
  const statements = [];
  for (const [index, account] of capture.accounts.entries()) {
    const reference = `${prefix}ref-${String(index)}`;
    const mapping = `${prefix}am-${String(index)}`;
    const entity = await entityOf(account.entityOf ?? account.rawAccount);
    const label = `合成口座 ${String(index)}`;
    const inserted = await env.DB.prepare(
      `INSERT INTO balance_observations
         (parse_run_id,source_account,metric,instrument,amount_minor,amount_text,amount_scale,as_of,raw_locator,extra_json)
       VALUES (?,?,?,'JPY',?,?,0,'2026-11-18',?,'{}') RETURNING id`,
    )
      .bind(
        parse!.id,
        account.rawAccount,
        capture.metric,
        String(account.amount),
        String(account.amount),
        `json:$.synthetic.accounts[${String(index)}]`,
      )
      .first<{ id: number }>();
    statements.push(
      env.DB.prepare(
        "INSERT INTO accounts SELECT ?1,?2,'cash',?3 WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE id=?1)",
      ).bind(entity, label, capture.status),
      env.DB.prepare("INSERT INTO source_accounts VALUES (?,?,'evidence-test',?)").bind(
        reference,
        capture.source,
        JSON.stringify([account.rawAccount, parse!.id]),
      ),
      env.DB.prepare(
        `INSERT INTO account_mappings VALUES (?,?,1,?,'rule','provider-scope',1,'2026-11-18T21:07:00Z',?,?)`,
      ).bind(mapping, reference, entity, label, capture.status),
      env.DB.prepare("INSERT INTO identity_observations VALUES (?,?,'balance',?,?,?,'[]')").bind(
        `${prefix}io-${String(inserted!.id)}`,
        `${prefix}ir`,
        inserted!.id,
        reference,
        mapping,
      ),
    );
  }
  await env.DB.batch([
    env.DB.prepare("INSERT INTO identity_runs VALUES (?,?,1,'2026-11-18T21:07:00Z')").bind(
      `${prefix}ir`,
      parse!.id,
    ),
    ...statements,
    env.DB.prepare("INSERT INTO identity_run_seals VALUES (?,?,'2026-11-18T21:07:00Z')").bind(
      `${prefix}ir`,
      capture.accounts.length,
    ),
  ]);
}

async function build(): Promise<void> {
  const result = await runBalanceProjection(
    { ...env, BALANCE_PROJECTION_ENABLED: "1", READ_PROJECTION_ENABLED: "true" } as never,
    { writeBudget: 20_000 },
  );
  expect(result.status).toBe("complete");
}

const amount = (index: number) => 100_000 + index * 1_000;
const deposits = (source: string, count: number): SyntheticAccount[] =>
  Array.from({ length: count }, (_, index) => ({
    rawAccount: `${source}:synthetic-ordinary-${String(index)}`,
    amount: amount(index),
  }));
const sum = (indexes: readonly number[]) =>
  String(indexes.reduce((total, index) => total + amount(index), 0));
/** The eight SMBC deposits of the example, each its own account entity. */
const SMBC_EIGHT = deposits("smbc-bank", 8);
const SMBC_SECOND: SyntheticAccount = {
  rawAccount: "smbc-bank:synthetic-second-reference",
  amount: amount(3),
  entityOf: SMBC_EIGHT[3]!.rawAccount,
};
const smbc = (accounts: SyntheticAccount[]): SyntheticCapture => ({
  source: "smbc-bank",
  dataset: "balance-normalized",
  parser: "smbc-direct-balance",
  metric: "account_balance",
  status: "provider-local",
  accounts,
});

interface LatestItem {
  row: { source_account: string };
  adoption: { state: string; reasonCode: string | null };
}

async function latest(source: string) {
  const served = await page.route(`/api/v2/balances/latest?source=${source}&detail=full&limit=50`);
  expect(served.status).toBe(200);
  return served.body as {
    items: LatestItem[];
    subtotals: {
      knownAssetsSubtotal: { unitRef: string; coefficient: string; adoptedCount: number }[] | null;
      reasonCode: string | null;
    };
    dataCoverage: { completeness: string; reasons: string[] };
  };
}

interface Holdings {
  completeness: string;
  data: { units: { unitRef: string; coefficient: string; adoptedCount: number }[] };
  coverage: { gaps: { reasonCode: string }[] };
}

async function holdings(): Promise<Holdings> {
  const served = await page.route("/api/v2/query?intent=holdings");
  expect(served.status).toBe(200);
  const overMcp = await page.mcp("kogane.financial.query", { intent: "holdings" });
  expect(overMcp.isError).toBe(false);
  const result = (served.body as { result: Holdings }).result;
  // The MCP tool answers from the same application service and the same snapshot.
  const viaMcp = (overMcp.body as { result: Holdings }).result;
  expect(viaMcp.data.units).toEqual(result.data.units);
  expect(viaMcp.completeness).toBe(result.completeness);
  expect(viaMcp.coverage.gaps).toEqual(result.coverage.gaps);
  return result;
}

const stateOf = (items: readonly LatestItem[], rawAccount: string) =>
  items.find((item) => item.row.source_account === rawAccount)!.adoption;

describe("one account entity reached through two references", () => {
  it("counts references of different entities separately", async () => {
    await seedCapture(smbc(SMBC_EIGHT));
    await build();
    const served = await latest("smbc-bank");
    expect(served.subtotals.knownAssetsSubtotal).toEqual([
      { unitRef: "JPY", coefficient: sum([0, 1, 2, 3, 4, 5, 6, 7]), scale: 0, adoptedCount: 8 },
    ]);
    expect(served.dataCoverage.completeness).toBe("complete");
    const answer = await holdings();
    expect(answer.completeness).toBe("complete");
    expect(answer.data.units).toEqual([
      { unitRef: "JPY", coefficient: sum([0, 1, 2, 3, 4, 5, 6, 7]), scale: 0, adoptedCount: 8 },
    ]);
  });

  it("does not count a second reference of one entity twice, and names why", async () => {
    // The next capture of the same dataset lists a ninth reference whose
    // current mapping names the entity of the fourth account. v2 adopted
    // nine amounts: the latest subtotal and `holdings` both said 9.
    await seedCapture(smbc([...SMBC_EIGHT, SMBC_SECOND]));
    await build();
    const served = await latest("smbc-bank");
    const others = [0, 1, 2, 4, 5, 6, 7];
    expect(served.subtotals).toMatchObject({
      knownAssetsSubtotal: [
        { unitRef: "JPY", coefficient: sum(others), scale: 0, adoptedCount: 7 },
      ],
      reasonCode: null,
    });
    // The entity is shown with its closed reason, never dropped and never zero.
    for (const rawAccount of [SMBC_EIGHT[3]!.rawAccount, SMBC_SECOND.rawAccount])
      expect(stateOf(served.items, rawAccount)).toMatchObject({
        state: "unresolved",
        reasonCode: "account_entity_shared",
      });
    expect(served.items).toHaveLength(9);
    expect(served.dataCoverage).toMatchObject({
      completeness: "partial",
      reasons: ["unresolved:account_entity_shared"],
    });
    // `kogane.balances.read` reads the same snapshot through the same service.
    const overMcp = await page.mcp("kogane.balances.read", {
      collection: "latest",
      source: "smbc-bank",
      limit: 50,
    });
    expect(overMcp.isError).toBe(false);
    expect(overMcp.body.data.subtotals).toEqual(served.subtotals);
    expect(overMcp.body.data.dataCoverage).toEqual(served.dataCoverage);
    const answer = await holdings();
    expect(answer.completeness).toBe("partial");
    expect(answer.data.units).toEqual([
      { unitRef: "JPY", coefficient: sum(others), scale: 0, adoptedCount: 7 },
    ]);
    expect(answer.coverage.gaps.map((gap) => gap.reasonCode)).toContain(
      "unresolved:account_entity_shared",
    );
  });

  it("does not count a cross-source identified pair of one entity twice", async () => {
    // Two direct banks' own deposit readings, both identified: v2 declared
    // them disjoint as identified accounts and as listed institutions.
    const shinsei = deposits("sbi-shinsei-bank", 2);
    await seedCapture({
      source: "sbi-shinsei-bank",
      dataset: "yen-deposit-account",
      parser: "sbi-shinsei-yen-deposit-account",
      metric: "yen_deposit_account_balance",
      status: "identified",
      accounts: shinsei,
    });
    await seedCapture({
      source: "mizuho-bank",
      parser: "mizuho-account-list",
      metric: "account_balance",
      status: "identified",
      accounts: [
        { rawAccount: "mizuho-bank:synthetic-ordinary-0", amount: amount(20) },
        {
          rawAccount: "mizuho-bank:synthetic-same-as-shinsei",
          amount: amount(1),
          entityOf: shinsei[1]!.rawAccount,
        },
      ],
    });
    await build();
    const fromShinsei = await latest("sbi-shinsei-bank");
    expect(fromShinsei.subtotals.knownAssetsSubtotal).toEqual([
      { unitRef: "JPY", coefficient: sum([0]), scale: 0, adoptedCount: 1 },
    ]);
    expect(stateOf(fromShinsei.items, shinsei[1]!.rawAccount)).toMatchObject({
      state: "unresolved",
      reasonCode: "account_entity_shared",
    });
    const fromMizuho = await latest("mizuho-bank");
    expect(fromMizuho.subtotals.knownAssetsSubtotal).toEqual([
      { unitRef: "JPY", coefficient: sum([20]), scale: 0, adoptedCount: 1 },
    ]);
    expect(stateOf(fromMizuho.items, "mizuho-bank:synthetic-same-as-shinsei")).toMatchObject({
      state: "unresolved",
      reasonCode: "account_entity_shared",
    });
    // The whole store: seven SMBC accounts, one at each other bank.
    const answer = await holdings();
    expect(answer.data.units).toEqual([
      {
        unitRef: "JPY",
        coefficient: String(Number(sum([0, 1, 2, 4, 5, 6, 7])) + amount(0) + amount(20)),
        scale: 0,
        adoptedCount: 9,
      },
    ]);
    expect(answer.completeness).toBe("partial");
  });
});
