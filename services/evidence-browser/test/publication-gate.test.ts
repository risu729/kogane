// Candidate invisibility proof (D03, PR-05 step 4 preparation). A successful
// parse run that is not in the publication projection, and that superseded
// nothing, is what a future candidate result looks like. Every reader path
// of the evidence browser must leave it out, while the consistency view of
// migration 0026 lists it for the audit path. Publishing it through the same
// pointer move the writer performs is what makes it visible, and only that.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { evidenceReader } from "../src/observations";
import { identityApi } from "../src/identity-api";
import { observationApi } from "../src/observation-api";
import { observationOrganizations } from "../src/observation-organization";
import { publishParse, seedRegistry, seedRun, supersedeParse } from "./fixtures";
import { CANDIDATE_LIMIT } from "../../../packages/read-model/src/index";

const SB = "sony-bank";
const PARSER = "sony-bank-gross-balance";

async function parse(artifactId: number, version: string, parsedAt: string): Promise<number> {
  const row = await env.DB.prepare(
    "INSERT INTO parse_runs (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES (?,?,?,?,'ok','[]') RETURNING id",
  )
    .bind(artifactId, PARSER, version, parsedAt)
    .first<{ id: number }>();
  return row!.id;
}
async function observations(parseRunId: number, account: string, tag: string) {
  const first = async (sql: string) =>
    (await env.DB.prepare(sql).bind(parseRunId).first<{ id: number }>())!.id;
  return {
    tx: await first(
      `INSERT INTO transaction_observations (parse_run_id,source_account,as_of,amount_minor,currency,description,raw_locator,extra_json)
       VALUES (?,'${account}','2026-03-01',100,'JPY','${tag}','$','{}') RETURNING id`,
    ),
    bal: await first(
      `INSERT INTO balance_observations (parse_run_id,source_account,metric,instrument,amount_minor,as_of,raw_locator,extra_json)
       VALUES (?,'${account}','${tag}-metric','${tag === "published" ? "JPY" : "XCD"}',100,'2026-03-01','$','{}') RETURNING id`,
    ),
    pos: await first(
      `INSERT INTO position_observations (parse_run_id,source_account,security_code,quantity_text,quantity_scale,raw_locator,extra_json)
       VALUES (?,'${account}','${tag}-code','1',0,'$','{}') RETURNING id`,
    ),
    val: await first(
      `INSERT INTO valuation_observations (parse_run_id,source_account,subject,metric,amount_minor,currency,raw_locator,extra_json)
       VALUES (?,'${account}','${tag}-code','value',100,'JPY','$','{}') RETURNING id`,
    ),
  };
}
async function api(path: string) {
  const request = new Request(`https://fixture.test${path}`);
  const url = new URL(request.url);
  const response =
    (await observationApi(request, env, url)) ?? (await identityApi(request, env, url));
  return response!.json() as Promise<Record<string, any>>;
}
const status = (path: string) =>
  api(path).then(
    () => 200,
    (error: { status?: number }) => error.status,
  );

describe("publication gate: candidate invisibility", () => {
  let A1: number, A2: number, P1: number, C1: number, C2: number;
  let published: Awaited<ReturnType<typeof observations>>;
  let candidate: Awaited<ReturnType<typeof observations>>;
  let later: Awaited<ReturnType<typeof observations>>;
  beforeAll(async () => {
    await seedRegistry();
    const R1 = await seedRun({ source: SB, count: 1, dataset: "gross-balance" });
    A1 = R1.artifacts[0]!.id;
    P1 = await parse(A1, "1", "2026-09-01T00:00:00Z");
    await publishParse(P1, "2026-09-01T00:00:00Z");
    published = await observations(P1, "acct", "published");
    // Same artifact and parser, newer version, ok, superseding nothing, not
    // published: a candidate as the gate will see it.
    C1 = await parse(A1, "2", "2026-09-02T00:00:00Z");
    candidate = await observations(C1, "candidate-acct", "candidate");
    // A later capture of the same snapshot dataset whose only parse is a
    // candidate: it must not become the current snapshot.
    const R2 = await seedRun({ source: SB, count: 1, dataset: "gross-balance" });
    A2 = R2.artifacts[0]!.id;
    C2 = await parse(A2, "1", "2026-09-03T00:00:00Z");
    later = await observations(C2, "acct", "later");
    // The candidate even has a sealed identity interpretation.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO source_accounts VALUES ('gate-ref','sony-bank','evidence-test','["candidate-acct"]')`,
      ),
      env.DB.prepare(
        `INSERT INTO accounts VALUES ('gate-account','Candidate','cash','identified')`,
      ),
      env.DB.prepare(
        `INSERT INTO account_mappings VALUES ('gate-am','gate-ref',1,'gate-account','rule','initial',1,'2099','Candidate','identified')`,
      ),
      env.DB.prepare(`INSERT INTO identity_runs VALUES ('gate-ir',?,1,'2099')`).bind(C1),
      ...(
        [
          ["transaction", candidate.tx],
          ["balance", candidate.bal],
          ["position", candidate.pos],
          ["valuation", candidate.val],
        ] as const
      ).map(([kind, id]) =>
        env.DB.prepare(
          `INSERT INTO identity_observations VALUES (?,'gate-ir',?,?,'gate-ref','gate-am','[]')`,
        ).bind(`gate-io-${kind}`, kind, id),
      ),
      // A seal covers every B observation of the parse run (four kinds).
      env.DB.prepare(`INSERT INTO identity_run_seals VALUES ('gate-ir',4,'2099')`),
    ]);
  });

  it("keeps the candidate out of every reader path and lists it on the audit path", async () => {
    const reader = evidenceReader(env.DB);
    const ids = (rows: { id: number }[]) => rows.map((row) => row.id);
    // Current lists.
    expect(ids(await reader.listTransactions({ offset: 0 }))).toEqual([published.tx]);
    expect(ids(await reader.listLatestBalances({ offset: 0, limit: CANDIDATE_LIMIT }))).toEqual([
      published.bal,
    ]);
    const positions = await reader.listPositions({ offset: 0 });
    expect(positions.map((row) => row.position.id)).toEqual([published.pos]);
    expect(positions[0]!.valuations.map((v) => v.id)).toEqual([published.val]);
    // Recorded history and detail: the candidate is not a visible result at all.
    expect(ids(await reader.listBalanceHistory({ offset: 0 }))).toEqual([published.bal]);
    const overview = await reader.overview();
    expect(Object.fromEntries(overview.counts.map((c) => [c.table, c.rows]))).toMatchObject({
      parse_runs: 1,
      transaction_observations: 1,
      balance_observations: 1,
      position_observations: 1,
      valuation_observations: 1,
    });
    expect(overview.parseRuns.map((run) => run.id)).toEqual([P1]);
    expect((await reader.getArtifact(A1))!.parseRuns.map((run) => run.id)).toEqual([P1]);
    expect((await reader.getArtifact(A2))!.parseRuns).toEqual([]);
    expect(
      (await reader.listArtifacts({ before: Number.MAX_SAFE_INTEGER })).map((a) => [
        a.id,
        a.parse_run_count,
      ]),
    ).toEqual([
      [A2, 0],
      [A1, 1],
    ]);
    for (const [kind, id] of [
      ["balance", candidate.bal],
      ["balance", later.bal],
      ["transaction", candidate.tx],
      ["position", candidate.pos],
      ["valuation", candidate.val],
    ] as const)
      expect(await reader.getObservation({ kind, id }), `${kind} ${id}`).toBeUndefined();
    expect(await reader.getObservation({ kind: "balance", id: published.bal })).toBeDefined();
    // Filter options never name the candidate's account, metric or unit.
    const transactionOptions = await reader.filterOptions({ kind: "transactions" });
    expect(transactionOptions.accounts.map((a) => a.source_account)).toEqual(["acct"]);
    const balanceOptions = await reader.filterOptions({ kind: "balances" });
    expect(balanceOptions.metrics).toEqual(["published-metric"]);
    expect(balanceOptions.instruments).toEqual(["JPY"]);
    // The routes see the same.
    expect(await status(`/api/observations/balance/${candidate.bal}`)).toBe(404);
    expect(await status(`/api/observations/transaction/${candidate.tx}`)).toBe(404);
    expect((await api(`/api/artifacts/${A2}`)).parseRuns).toEqual([]);
    expect((await api("/api/balances")).latest.map((r: { id: number }) => r.id)).toEqual([
      published.bal,
    ]);
    // Identity eligibility and organization follow the same gate.
    expect(await api(`/api/identity/coverage?source=${SB}`)).toMatchObject({
      rows: [{ eligible: 4, organized: 0 }],
    });
    expect((await api(`/api/identity/accounts?source=${SB}`)).rows).toEqual([]);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM current_identity_observations WHERE parse_run_id=?",
      )
        .bind(C1)
        .first<number>("n"),
    ).toBe(0);
    const organization = await observationOrganizations(env.DB, [
      { kind: "transaction", id: candidate.tx },
    ]);
    expect([...organization.values()].map((o) => o.state)).toEqual(["unavailable"]);
    // The audit path is the one place the candidate shows.
    const mismatches = await env.DB.prepare(
      "SELECT parse_run_id,mismatch FROM publication_gate_mismatches ORDER BY parse_run_id",
    ).all<{ parse_run_id: number; mismatch: string }>();
    expect(mismatches.results).toEqual([
      { parse_run_id: C1, mismatch: "legacy_only" },
      { parse_run_id: C2, mismatch: "legacy_only" },
    ]);
  });

  it("adopting the candidate through the pointer flips exactly the same paths", async () => {
    await supersedeParse(P1, C1);
    const reader = evidenceReader(env.DB);
    expect((await reader.listTransactions({ offset: 0 })).map((r) => r.id)).toEqual([candidate.tx]);
    expect(
      (await reader.listLatestBalances({ offset: 0, limit: CANDIDATE_LIMIT })).map((r) => r.id),
    ).toEqual([candidate.bal]);
    // History keeps the replaced run, marked, and still hides the later candidate.
    expect(
      (await reader.listBalanceHistory({ offset: 0 })).map((r) => [
        r.id,
        r.superseded_by_parse_run_id,
      ]),
    ).toEqual([
      [candidate.bal, null],
      [published.bal, C1],
    ]);
    expect((await reader.getArtifact(A1))!.parseRuns.map((run) => run.id)).toEqual([P1, C1]);
    expect(await reader.getObservation({ kind: "balance", id: later.bal })).toBeUndefined();
    expect(await api(`/api/identity/coverage?source=${SB}`)).toMatchObject({
      rows: [{ eligible: 4, organized: 4, identified: 4 }],
    });
    const organization = await observationOrganizations(env.DB, [
      { kind: "transaction", id: candidate.tx },
      { kind: "transaction", id: published.tx },
    ]);
    expect(organization.get(`transaction:${candidate.tx}`)).toMatchObject({
      state: "organized",
      lineage: "current",
    });
    expect(organization.get(`transaction:${published.tx}`)?.state).toBe("unavailable");
    const mismatches = await env.DB.prepare(
      "SELECT parse_run_id FROM publication_gate_mismatches",
    ).all<{ parse_run_id: number }>();
    expect(mismatches.results).toEqual([{ parse_run_id: C2 }]);
  });
});
