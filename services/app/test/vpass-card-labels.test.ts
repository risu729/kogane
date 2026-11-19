// The Vpass card label (#1357): `<cardName>（card-NNN）` from the newest bound
// credit observation of the card, resolved at read time in the shared
// organization step, the identity accounts page and the filter options, and
// the same over the routes and their MCP reads (ADR 0081). Every name, token
// and amount is invented; the credit rows are the real parser's output over
// the synthetic response fixtures, and each bound card carries a trusted
// importer binding (ADR 0023) as production identity requires.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { d1Executor } from "../../../packages/read-model/src/d1";
import { validIdentityResponse } from "../../../packages/observation-shared/src/identity-contract";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation.ts";
import { vpassCreditSnapshot } from "../../../packages/parsers/src/parsers/vpass-credit.ts";
import { authori, revo } from "../../../packages/parsers/test/fixtures/vpass-credit.ts";
import { observationOrganizations } from "../../../packages/application/src/query/observation-organization.ts";
import { organizedFilterOptions } from "../../../packages/application/src/query/organized-filter-options.ts";
import {
  VPASS_CARD_LABELS_SQL,
  vpassCardLabels,
} from "../../../packages/application/src/query/vpass-card-labels.ts";
import { runBalanceProjection } from "../../processor/src/balance-projection-job";
import { publishParse, seedRegistry, seedRun } from "./fixtures";
import { seedFixtureObject, seedFixturePost } from "./ingest-fixtures";
import { pageReadHarness } from "./page-read-harness";

const STORED = "Vpassカード明細";
/** The Revo holder name: it must reach no answer. */
const HOLDER = "テスト太郎";
const page = pageReadHarness("vpass-card-labels", { READ_PROJECTION_ENABLED: "true" });
type CreditFile = { key: "credit/authori.json" | "credit/revo.json"; value: unknown };
type Run = { unitId: number; artifacts: { id: number }[]; binding: number | null };

const token = (card: string) => `vpass-card-v1-${card.slice(-1).repeat(64)}`;
const references: string[] = [];
/** Each card's statement-like balance row, the one `balances.read` shows. */
const statementRows = new Map<string, number>();
/** The first Authori and Revo observation of each credit run, by `<card>/<run>`. */
const authoriRows = new Map<string, number>();
const revoRows = new Map<string, number>();

function withHolder(value: ReturnType<typeof revo>) {
  value.body.content.CustomizedRevoShokaiAnsPcDisplayServiceBean.userName = HOLDER;
  return value;
}
function hiddenAuthori(name: string) {
  const value = authori("123", name);
  const display = value.body.content.AuthoriShokaiDisplayServiceBean.authoriShokaiDisplayVo;
  display.hyoujiFlg = "1";
  for (const row of display.autoriShokaiDisplayList) row.hyoujiFlg = "1";
  return value;
}

const vpassPost = (path: string, body: unknown) =>
  seedFixturePost("collector-r2-vpass", path, body);
let blobs = 0;
/** One sealed, successful importer run with one card unit. */
async function importerRun(
  session: string,
  sourceRunKey: string,
  unitKey: string,
  artifacts: { key: string; dataset: string; binding?: boolean }[],
) {
  const { runId } = await vpassPost("/v1/runs", {
    producerId: "collector-r2-importer",
    sourceId: "vpass",
    externalIdNamespace: "vpass-worker-card-v1",
    externalSessionId: session,
    sourceRunKey,
  });
  const { unitId } = await vpassPost(`/v1/runs/${runId}/units`, {
    unitKind: "card",
    unitKey,
    terminalReportRequired: true,
  });
  const sealed = [];
  for (const artifact of artifacts) {
    const bytes = new TextEncoder().encode(JSON.stringify({ synthetic: true, blob: ++blobs }));
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    const sha256 = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join(
      "",
    );
    await seedFixtureObject("collector-r2-vpass", runId, sha256, bytes);
    const descriptor = await vpassPost(`/v1/runs/${runId}/artifacts`, {
      artifactKey: artifact.key,
      artifactRole: artifact.binding ? "collector_derived" : "collector_summary",
      payloadFidelity: artifact.binding ? "transformed" : "generated",
      containerKind: "single",
      lineageDisposition: artifact.binding ? "source_not_retained_for_security" : "not_applicable",
      fetchUnitId: unitId,
      sha256,
      byteSize: bytes.length,
      dataset: artifact.dataset,
      formatId: artifact.binding ? "vpass-card-identity-binding-json" : "synthetic",
      formatVersion: "1",
      declaredMediaType: "application/json",
      mediaTypeBasis: "operator",
      transformSteps: artifact.binding
        ? [
            {
              stepIndex: 0,
              stepKind: "extracted",
              transformerId: "synthetic",
              transformerVersion: "1",
            },
            {
              stepIndex: 1,
              stepKind: "redacted",
              transformerId: "synthetic",
              transformerVersion: "1",
            },
          ]
        : [],
    });
    sealed.push({
      artifactKey: artifact.key,
      sha256,
      descriptorSha256: descriptor.descriptorSha256,
    });
  }
  await vpassPost(`/v1/units/${unitId}/reports`, {
    reportKey: "terminal",
    reportKind: "terminal",
    normalizedOutcome: "success",
    declaredArtifactCount: artifacts.length,
    artifactCountScope: "direct",
  });
  await vpassPost(`/v1/runs/${runId}/reports`, {
    reportKey: "terminal",
    reportKind: "terminal",
    normalizedOutcome: "success",
    declaredArtifactCount: artifacts.length,
    artifactCountScope: "all_catalogued",
  });
  await vpassPost(`/v1/runs/${runId}/seal`, {
    artifacts: sealed,
    declarationBasis: "operator",
    externalAttemptId: crypto.randomUUID(),
    startedAtMs: 0,
  });
  const rows = await env.DB.prepare(
    "SELECT id FROM fetch_artifacts WHERE fetch_run_id=? ORDER BY id",
  )
    .bind(runId)
    .all<{ id: number }>();
  return { unitId: Number(unitId), artifacts: rows.results };
}

/** A bound card's financial run and the binding run of the same session. */
/**
 * A bound card's financial run. Every run of one card shares one session and
 * so the one binding run written the first time, as an importer session holds
 * one binding per card; runs of a card keep their order by run id.
 */
const sessions = new Map<string, { session: string; binding: number; runs: number }>();
async function boundRun(card: string, files: { key: string; dataset: string }[]): Promise<Run> {
  let held = sessions.get(card);
  if (!held) {
    const session = crypto.randomUUID();
    const binding = await importerRun(session, `${card}-vpass-card-binding-v1`, token(card), [
      { key: "card-identity-binding.json", dataset: "card-identity-binding", binding: true },
    ]);
    held = { session, binding: binding.artifacts[0]!.id, runs: 0 };
    sessions.set(card, held);
  }
  const financial = await importerRun(
    held.session,
    `${card}-vpass-r2-v2-${++held.runs}`,
    card,
    files,
  );
  return { ...financial, binding: held.binding };
}

/** A run-scoped (unbound) card's run, as an ordinal without a binding gives. */
async function unboundRun(card: string, count: number, dataset?: string): Promise<Run> {
  const acquisition = await seedRun({ source: "vpass", count, fetchUnitKey: card, dataset });
  return { unitId: 0, artifacts: acquisition.artifacts, binding: null };
}

/** One source account reference with its rule mapping and the stored label. */
async function reference(card: string, bound: boolean): Promise<string> {
  const id = `sa-${card}`;
  const key = bound ? ["vpass:card", token(card)] : [`vpass:${card}`, "fetch-run", "1"];
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO source_accounts VALUES (?,'vpass',?,?)`).bind(
      id,
      bound ? "collector-r2-importer" : "evidence-test",
      JSON.stringify(key),
    ),
    env.DB.prepare(`INSERT INTO accounts VALUES (?,?,'card-statement','provider-local')`).bind(
      `account-${id}`,
      STORED,
    ),
    env.DB.prepare(
      `INSERT INTO account_mappings VALUES (?,?,1,?,'rule','verified-importer-durable-card-binding',1,'2099',?,'provider-local')`,
    ).bind(`am-${id}`, id, `account-${id}`, STORED),
  ]);
  references.push(id);
  return id;
}

/** Identity-organize every balance row of one parse run to one reference, and seal it. */
async function identify(parseId: number, ref: string, rows: number[], run: Run, card: string) {
  const runId = `ir-${parseId}`;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO identity_runs VALUES (?,?,?,'2099')`).bind(
      runId,
      parseId,
      run.binding === null ? 1 : 2,
    ),
    ...(run.binding === null
      ? []
      : [
          env.DB.prepare(`INSERT INTO identity_vpass_bindings VALUES (?,?,?,?)`).bind(
            runId,
            run.unitId,
            run.binding,
            token(card),
          ),
        ]),
    ...rows.map((id) =>
      env.DB.prepare(`INSERT INTO identity_observations VALUES (?,?,'balance',?,?,?,'[]')`).bind(
        `io-${parseId}-${id}`,
        runId,
        id,
        ref,
        `am-${ref}`,
      ),
    ),
    env.DB.prepare(`INSERT INTO identity_run_seals VALUES (?,?,'2099')`).bind(runId, rows.length),
  ]);
}

/** One credit run of `card`: each file parsed by the real parser, published and identified. */
async function creditRun(
  card: string,
  ref: string,
  name: string,
  files: CreditFile[],
  bound = true,
) {
  const run = bound
    ? await boundRun(
        card,
        files.map((file) => ({ key: file.key, dataset: "credit-snapshot" })),
      )
    : await unboundRun(card, files.length, "credit-snapshot");
  for (const [index, file] of files.entries()) {
    const artifact = run.artifacts[index]!;
    const result = vpassCreditSnapshot.parse(new TextEncoder().encode(JSON.stringify(file.value)), {
      id: artifact.id,
      sourceId: "vpass",
      dataset: "credit-snapshot",
      artifactKey: file.key,
      fetchUnitKey: card,
      runStatus: "success",
      runFailureCount: 0,
      url: null,
      mime: "application/json",
      fetchedAt: "2099-01-01T10:00:00Z",
      sha256: "0".repeat(64),
    });
    const parse = await env.DB.prepare(
      `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
       VALUES (?,?,?,'2099','ok','[]') RETURNING id`,
    )
      .bind(artifact.id, vpassCreditSnapshot.name, vpassCreditSnapshot.version)
      .first<{ id: number }>();
    await publishParse(parse!.id);
    const rows: number[] = [];
    for (const observation of result.observations) {
      if (observation.kind !== "balance") throw new Error("unexpected kind");
      const row = await env.DB.prepare(
        `INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_text,amount_scale,instrument,as_of,raw_locator,extra_json)
         VALUES (?,?,?,?,?,?,?,?,?) RETURNING id`,
      )
        .bind(
          parse!.id,
          observation.sourceAccount,
          observation.metric,
          observation.amountText ?? null,
          observation.amountScale ?? null,
          observation.instrument,
          observation.asOf ?? null,
          observation.rawLocator,
          JSON.stringify(observation.extra),
        )
        .first<{ id: number }>();
      rows.push(row!.id);
    }
    await identify(parse!.id, ref, rows, run, card);
    if (rows.length)
      (file.key === "credit/authori.json" ? authoriRows : revoRows).set(
        `${card}/${name}`,
        rows[0]!,
      );
  }
}

/** A balance row of another parser on the same card, as a statement would give. */
async function statementRow(card: string, ref: string, bound = true) {
  const run = bound
    ? await boundRun(card, [{ key: "statement.json", dataset: "statement-page" }])
    : await unboundRun(card, 1);
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES (?,'vpass-label-fixture','1','2099','ok','[]') RETURNING id`,
  )
    .bind(run.artifacts[0]!.id)
    .first<{ id: number }>();
  await publishParse(parse!.id);
  const row = await env.DB.prepare(
    `INSERT INTO balance_observations(parse_run_id,source_account,metric,instrument,amount_minor,as_of,raw_locator,extra_json)
     VALUES (?,?,'available','JPY',1000,'2099-01-01','row','{}') RETURNING id`,
  )
    .bind(parse!.id, `vpass:${card}`)
    .first<{ id: number }>();
  await identify(parse!.id, ref, [row!.id], run, card);
  statementRows.set(card, row!.id);
}

beforeAll(async () => {
  await seedRegistry();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO producer_sources(producer_id,source_id) VALUES('evidence-test','vpass')",
    ),
    env.DB.prepare(
      "INSERT INTO ingest_client_routes(ingest_client_id,producer_id,source_id) VALUES('evidence-test','evidence-test','vpass')",
    ),
  ]);
  // card-001: Authori names the card; a newer run names it again, and
  // Authori wins over a differing Revo in the same run.
  const one = await reference("card-001", true);
  await statementRow("card-001", one);
  await creditRun("card-001", one, "old", [
    { key: "credit/authori.json", value: authori("100", "テストカードA") },
    { key: "credit/revo.json", value: withHolder(revo("+1", "テストカードA")) },
  ]);
  await creditRun("card-001", one, "new", [
    { key: "credit/authori.json", value: authori("100", "テストカードB") },
    { key: "credit/revo.json", value: withHolder(revo("+1", "テストカードX")) },
  ]);
  // card-002: Authori has no visible row, so Revo names the card.
  const two = await reference("card-002", true);
  await statementRow("card-002", two);
  await creditRun("card-002", two, "only", [
    { key: "credit/authori.json", value: hiddenAuthori("テストカードC") },
    { key: "credit/revo.json", value: withHolder(revo("+1", "テストカードC")) },
  ]);
  // card-003: the newest run's name holds a digit run, so the parser left it
  // out; the stored label stays and an older name is never reused.
  const three = await reference("card-003", true);
  await statementRow("card-003", three);
  await creditRun("card-003", three, "old", [
    { key: "credit/authori.json", value: authori("100", "テストカードD") },
  ]);
  await creditRun("card-003", three, "new", [
    { key: "credit/authori.json", value: authori("100", "テストカード1234") },
    { key: "credit/revo.json", value: withHolder(revo("+1", "テストカード1234")) },
  ]);
  // card-004: no credit observation at all.
  await statementRow("card-004", await reference("card-004", true));
  // card-005: a manual label wins over the card name.
  const five = await reference("card-005", true);
  await statementRow("card-005", five);
  await creditRun("card-005", five, "only", [
    { key: "credit/authori.json", value: authori("100", "テストカードE") },
  ]);
  await env.DB.prepare(
    `INSERT INTO account_mappings VALUES ('am-sa-card-005-manual','sa-card-005',2,'account-sa-card-005','manual','owner-named',1,'2100','手動ラベル','identified')`,
  ).run();
  // card-006: a run-scoped (unbound) reference is not a card a name may label.
  const six = await reference("card-006", false);
  await statementRow("card-006", six, false);
  await creditRun(
    "card-006",
    six,
    "only",
    [{ key: "credit/authori.json", value: authori("100", "テストカードF") }],
    false,
  );
  const built = await runBalanceProjection(
    { ...env, BALANCE_PROJECTION_ENABLED: "1", READ_PROJECTION_ENABLED: "true" } as never,
    { writeBudget: 20_000 },
  );
  expect(built.status).toBe("complete");
  // About sixty seeding requests through the ingest routes; a full parallel
  // suite run needs more than the default ten seconds for them.
}, 60_000);

const EXPECTED: Record<string, string> = {
  "card-001": "テストカードB（card-001）",
  "card-002": "テストカードC（card-002）",
  "card-003": STORED,
  "card-004": STORED,
  "card-005": "手動ラベル",
  "card-006": STORED,
};
const ORIGIN: Record<string, () => number | undefined> = {
  "card-001": () => authoriRows.get("card-001/new"),
  "card-002": () => revoRows.get("card-002/only"),
};

describe("Vpass card labels", () => {
  it("resolve from the newest bound credit observation, Authori first, else nothing", async () => {
    const labels = await vpassCardLabels(
      d1Executor(env.DB),
      references.map((referenceId) => ({ referenceId, source: "vpass" })),
    );
    expect(Object.fromEntries(labels)).toEqual({
      "sa-card-001": {
        label: "テストカードB（card-001）",
        origin: { kind: "balance", id: authoriRows.get("card-001/new") },
      },
      "sa-card-002": {
        label: "テストカードC（card-002）",
        origin: { kind: "balance", id: revoRows.get("card-002/only") },
      },
      // The helper does not read the mapping; the caller lets a manual label win.
      "sa-card-005": {
        label: "テストカードE（card-005）",
        origin: { kind: "balance", id: authoriRows.get("card-005/only") },
      },
    });
    // Another source's reference is never looked up.
    expect(
      await vpassCardLabels(d1Executor(env.DB), [{ referenceId: "sa-card-001", source: "x" }]),
    ).toEqual(new Map());
  });

  it("label every organized row of the card, statement rows included", async () => {
    const organizations = await observationOrganizations(
      d1Executor(env.DB),
      [...statementRows.values()].map((id) => ({ kind: "balance" as const, id })),
    );
    for (const [card, id] of statementRows) {
      const account = organizations.get(`balance:${id}`)!.account!;
      expect(account.label, card).toBe(EXPECTED[card]);
      const origin = ORIGIN[card]?.();
      if (origin === undefined) expect(account, card).not.toHaveProperty("labelEvidence");
      else
        expect(account.labelEvidence, card).toEqual({
          reason: "provider-card-name",
          origin: { kind: "balance", id: origin },
        });
    }
  });

  it("leave identity rules and stored labels unchanged", async () => {
    const stored = await env.DB.prepare(
      "SELECT label FROM account_mappings WHERE method='rule' UNION SELECT label FROM accounts",
    ).all<{ label: string }>();
    expect(stored.results.map((row) => row.label)).toEqual([STORED]);
  });

  it("are the same over the identity and balance routes and their MCP reads", async () => {
    const identity = await page.expectSameAnswer(
      "/api/identity/accounts?source=vpass",
      "kogane.identity.read",
      { collection: "accounts", source: "vpass" },
    );
    expect(identity.status).toBe(200);
    expect(validIdentityResponse("/api/identity/accounts", identity.body)).toBe(true);
    const rows = (
      identity.body as { rows: { referenceId: string; label: string; labelEvidence?: unknown }[] }
    ).rows;
    expect(Object.fromEntries(rows.map((row) => [row.referenceId, row.label]))).toEqual(
      Object.fromEntries(Object.entries(EXPECTED).map(([card, label]) => [`sa-${card}`, label])),
    );
    expect(rows.find((row) => row.referenceId === "sa-card-001")!.labelEvidence).toEqual({
      reason: "provider-card-name",
      origin: { kind: "balance", id: authoriRows.get("card-001/new") },
    });
    expect(JSON.stringify(identity.body)).not.toContain(HOLDER);
    for (const [query, args] of [
      ["/api/v2/balances/latest?source=vpass", { collection: "latest", source: "vpass" }],
      ["/api/v2/balances/history?source=vpass", { collection: "history", source: "vpass" }],
    ] as const) {
      const balances = await page.expectSameAnswer(query, "kogane.balances.read", args);
      expect(balances.status, query).toBe(200);
      expect(validApiResponse(query.split("?")[0]!, balances.body), query).toBe(true);
      const items = (
        balances.body as {
          items: {
            observationId?: number;
            row: { id: number; organization: { account: { label: string } } };
          }[];
        }
      ).items;
      for (const [card, id] of statementRows) {
        const item = items.find((entry) => (entry.observationId ?? entry.row.id) === id);
        expect(item, `${query} ${card}`).toBeDefined();
        expect(item!.row.organization.account.label, `${query} ${card}`).toBe(EXPECTED[card]);
      }
      expect(JSON.stringify(balances.body)).not.toContain(HOLDER);
    }
    const mcp = await page.mcp("kogane.identity.read", { collection: "accounts", source: "vpass" });
    expect(JSON.stringify(mcp.body.data)).toContain("テストカードB（card-001）");
  });

  it("name the filter option of a card", async () => {
    const options = await organizedFilterOptions(d1Executor(env.DB), "balances", {
      sources: [],
      instruments: [],
      metrics: [],
      accounts: [{ source_id: "vpass", source_account: "vpass:card-002" }],
    } as never);
    expect(options.accounts).toMatchObject([
      { display_name: "テストカードC（card-002）", organization_ambiguous: false },
    ]);
  });

  it("read only the requested references' own rows", async () => {
    const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN ${VPASS_CARD_LABELS_SQL}`)
      .bind(JSON.stringify(["sa-card-001"]))
      .all<{ detail: string }>();
    const details = plan.results.map((row) => row.detail);
    expect(details.join(" | ")).toContain("USING INDEX identity_observation_account");
    for (const table of [
      "identity_observations",
      "balance_observations",
      "parse_runs",
      "published_parse_runs",
      "source_accounts",
    ])
      expect(
        details.filter((detail) => new RegExp(`^SCAN ${table}\\b`, "u").test(detail)),
        `${table}: ${details.join(" | ")}`,
      ).toEqual([]);
  });
});
