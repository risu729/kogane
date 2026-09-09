// Candidate invisibility with real candidate rows (design review D03 step 4,
// A04). test/publication-gate.test.ts proves that an unadopted successful run
// is invisible; this file does the same with the rows the candidate lane
// actually writes - a registered `parser_releases` entry and a
// `parse_run_candidates` marker (migration 0028) - and adds what only exists
// once candidates are real: the operational gap view must stay empty, so no
// repair route can ever publish a candidate.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { evidenceReader } from "../src/observations";
import { identityApi } from "../src/identity-api";
import { observationApi } from "../src/observation-api";
import { observationOrganizations } from "../src/observation-organization";
import { publishParse, seedRegistry, seedRun } from "./fixtures";
import { CANDIDATE_LIMIT } from "../../../packages/read-model/src/index";

const SB = "sony-bank";
const PARSER = "sony-bank-gross-balance";
const RELEASE = "sony-bank-gross-balance-2.0.0-00112233445566aa";

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
       VALUES (?,'${account}','${tag}-metric','${tag === "adopted" ? "JPY" : "XCD"}',100,'2026-03-01','$','{}') RETURNING id`,
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

describe("release candidates are invisible to every reader", () => {
  let A1: number, P1: number, C1: number;
  let adopted: Awaited<ReturnType<typeof observations>>;
  let candidate: Awaited<ReturnType<typeof observations>>;
  beforeAll(async () => {
    await seedRegistry();
    const run = await seedRun({ source: SB, count: 1, dataset: "gross-balance" });
    A1 = run.artifacts[0]!.id;
    P1 = await parse(A1, "1.0.0", "2026-09-01T00:00:00Z");
    await publishParse(P1, "2026-09-01T00:00:00Z");
    adopted = await observations(P1, "acct", "adopted");
    // Exactly what the candidate lane writes: a successful run at the
    // candidate release's version, superseding nothing, never published, and
    // marked in parse_run_candidates.
    C1 = await parse(A1, "2.0.0", "2026-09-02T00:00:00Z");
    candidate = await observations(C1, "candidate-acct", "candidate");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO parser_releases (release_id,parser_name,semantic_version,code_digest,
          input_contract_version,output_contract_version,metadata_extractor_release,
          dependency_digests_json,registered_at)
         VALUES (?,?,'2.0.0','00'||?,'artifact-meta-v1','parse-result-v2','legacy-metadata-v1','{}','2026-09-02T00:00:00Z')`,
      ).bind(RELEASE, PARSER, "ff".repeat(31)),
      env.DB.prepare(
        "INSERT INTO parse_run_candidates (parse_run_id,release_id,fingerprint,state,created_at) VALUES (?,?,?,'candidate','2026-09-02T00:00:00Z')",
      ).bind(C1, RELEASE, "ab".repeat(32)),
    ]);
  });

  it("keeps a real candidate out of every reader path", async () => {
    const reader = evidenceReader(env.DB);
    expect((await reader.listTransactions({ offset: 0 })).map((row) => row.id)).toEqual([
      adopted.tx,
    ]);
    expect(
      (await reader.listLatestBalances({ offset: 0, limit: CANDIDATE_LIMIT })).map((row) => row.id),
    ).toEqual([adopted.bal]);
    expect((await reader.listBalanceHistory({ offset: 0 })).map((row) => row.id)).toEqual([
      adopted.bal,
    ]);
    const overview = await reader.overview();
    expect(Object.fromEntries(overview.counts.map((c) => [c.table, c.rows]))).toMatchObject({
      parse_runs: 1,
      transaction_observations: 1,
      balance_observations: 1,
    });
    expect(overview.parseRuns.map((run) => run.id)).toEqual([P1]);
    expect((await reader.getArtifact(A1))!.parseRuns.map((run) => run.id)).toEqual([P1]);
    for (const [kind, id] of [
      ["balance", candidate.bal],
      ["transaction", candidate.tx],
    ] as const)
      expect(await reader.getObservation({ kind, id }), `${kind} ${id}`).toBeUndefined();
    const balanceOptions = await reader.filterOptions({ kind: "balances" });
    expect(balanceOptions.metrics).toEqual(["adopted-metric"]);
    expect(balanceOptions.instruments).toEqual(["JPY"]);
    expect((await api("/api/balances")).latest.map((row: { id: number }) => row.id)).toEqual([
      adopted.bal,
    ]);
    expect((await api(`/api/identity/accounts?source=${SB}`)).rows).toEqual([]);
    const organization = await observationOrganizations(env.DB, [
      { kind: "transaction", id: candidate.tx },
    ]);
    expect([...organization.values()].map((o) => o.state)).toEqual(["unavailable"]);
  });

  it("is a candidate, not a publication gap: no repair can ever publish it", async () => {
    // The raw legacy comparison of migration 0026 still lists the candidate:
    // that is the audit path an operator inspects.
    expect(
      (
        await env.DB.prepare(
          "SELECT parse_run_id,mismatch FROM publication_gate_mismatches ORDER BY parse_run_id",
        ).all<{ parse_run_id: number; mismatch: string }>()
      ).results,
    ).toEqual([{ parse_run_id: C1, mismatch: "legacy_only" }]);
    // The operational view of migration 0028, which the repair route reads,
    // reports nothing at all.
    expect(
      (
        await env.DB.prepare("SELECT parse_run_id,mismatch FROM publication_gate_gaps").all<{
          parse_run_id: number;
          mismatch: string;
        }>()
      ).results,
    ).toEqual([]);
    // Adopting it is a pointer move, and only that flips the reader paths.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO publication_events (fetch_artifact_id,parser_name,previous_parse_run_id,new_parse_run_id,kind,actor,reason,occurred_at)
         VALUES (?,?,?,?,'activation','operator-1','adopt candidate','2026-09-03T00:00:00Z')`,
      ).bind(A1, PARSER, P1, C1),
      env.DB.prepare(
        `INSERT INTO published_parse_runs (fetch_artifact_id,parser_name,parse_run_id,parser_version,published_at,publication_kind,release_id)
         VALUES (?,?,?,'2.0.0','2026-09-03T00:00:00Z','activation',?)
         ON CONFLICT(fetch_artifact_id,parser_name) DO UPDATE SET parse_run_id=excluded.parse_run_id,
           parser_version=excluded.parser_version,published_at=excluded.published_at,
           publication_kind='activation',release_id=excluded.release_id`,
      ).bind(A1, PARSER, C1, RELEASE),
      env.DB.prepare("UPDATE parse_run_candidates SET state='adopted' WHERE parse_run_id=?").bind(
        C1,
      ),
    ]);
    const reader = evidenceReader(env.DB);
    expect((await reader.listTransactions({ offset: 0 })).map((row) => row.id)).toEqual([
      candidate.tx,
    ]);
    // The run the activation replaced was never superseded, so the gap view
    // must not report it either: it is a replaced publication, not a gap.
    expect(
      await env.DB.prepare("SELECT superseded_by_parse_run_id AS s FROM parse_runs WHERE id=?")
        .bind(P1)
        .first<number | null>("s"),
    ).toBeNull();
    expect(
      (
        await env.DB.prepare("SELECT parse_run_id FROM publication_gate_gaps").all<{
          parse_run_id: number;
        }>()
      ).results,
    ).toEqual([]);
  });
});
