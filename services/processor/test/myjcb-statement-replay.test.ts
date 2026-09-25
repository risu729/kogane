import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import { seedArtifact, startPipeline } from "./harness.ts";
import { sweep } from "../src/worker.ts";
import { myJcbCreditStatement } from "../../../packages/parsers/src/parsers/myjcb.ts";

let mf: Miniflare, env: Env;
beforeAll(async () => {
  ({ mf, env } = await startPipeline(undefined, { RELEASE_CANDIDATES_ENABLED: "true" }));
}, 60000);
afterAll(async () => {
  await mf?.dispose();
});

test("replay queues normalized MyJCB HTML and publishes an authoritative statement fact", async () => {
  const content = new TextEncoder().encode(
    '<!doctype html><html><body><h1>MyJCB</h1><h1>カードご利用代金明細(確定分)</h1><h2>2026年6月お支払い分のカードご利用明細</h2><div class="detail-list-01"></div><dl><dt>2026年6月15日(月)お支払い金額合計</dt><dd>1,234円</dd></dl></body></html>',
  );
  await seedArtifact(
    env,
    810,
    "myjcb",
    "credit-detail",
    "synthetic-card/credit-detail-03.html",
    content,
    false,
  );
  await env.DB.prepare(
    "UPDATE fetch_artifacts SET declared_media_type='text/html' WHERE id=810",
  ).run();
  await seedArtifact(
    env,
    811,
    "myjcb",
    "collector-manifest",
    "manifest.json",
    {
      artifacts: [
        {
          connectionId: "synthetic-card",
          filename: "credit-detail-03.html",
          dataset: "credit-detail",
        },
      ],
    },
    false,
  );
  await env.DB.prepare(
    "UPDATE fetch_artifacts SET fetch_run_id=810,artifact_role='collector_manifest' WHERE id=811",
  ).run();
  await env.DB.prepare("INSERT INTO fetch_run_seals(fetch_run_id,sealed_at_ms) VALUES(810,?)")
    .bind(Date.now())
    .run();
  expect(
    await env.DB.prepare("SELECT mime FROM observation_fetch_artifacts WHERE id=810").first<string>(
      "mime",
    ),
  ).toBe("text/html");
  // Reproduce a completed old ingestion notification: only explicit replay
  // should discover the newly deployed parser in this test.
  await env.DB.prepare(
    "UPDATE observation_work_items SET processed_at_ms=?,outcome='no_new_jobs' WHERE fetch_run_id=810",
  )
    .bind(Date.now())
    .run();
  const post = async (path: string, body: unknown) => {
    const response = await mf.dispatchFetch("https://pipeline.internal" + path, {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as { plan: { id: number; jobs_created: number } };
  };
  const planned = await post("/replay/plan", {
    source: "myjcb",
    dataset: "credit-detail",
    parser: myJcbCreditStatement.name,
    version: myJcbCreditStatement.version,
    reason: "Synthetic normalized HTML regression",
  });
  const started = await post("/replay/start", { planId: planned.plan.id });
  expect(started.plan.jobs_created).toBe(1);
  const result = await sweep(env, { lane: "replay", maxJobs: 4 });
  expect(
    await env.DB.prepare(
      "SELECT status,last_error_code FROM observation_parse_jobs WHERE fetch_artifact_id=810",
    ).first<Record<string, unknown>>(),
  ).toEqual({ status: "done", last_error_code: null });
  expect(result.lanes.replay?.parsed).toBe(1);
  expect(
    await env.DB.prepare(
      "SELECT p.parser_version FROM parse_runs p JOIN published_parse_runs published ON published.parse_run_id=p.id WHERE p.fetch_artifact_id=810",
    ).first<string>("parser_version"),
  ).toBe(myJcbCreditStatement.version);
  expect(
    await env.DB.prepare(
      "SELECT payment_date,period,value_status,coefficient,scale FROM card_statement_facts WHERE source_id='myjcb'",
    ).first<Record<string, unknown>>(),
  ).toEqual({
    payment_date: "2026-06-15",
    period: "2026-06",
    value_status: "exact",
    coefficient: "1234",
    scale: 0,
  });
  expect(
    await env.DB.prepare("SELECT count(*) AS n FROM card_settlement_decisions").first<number>("n"),
  ).toBe(0);
});

test("replay reads a closed position-1 page whose manifest says unconfirmed as confirmed", async () => {
  // A capture from before the collector decided the state from the page: the
  // page is a closed statement, the manifest (and so the artifact metadata)
  // says `unconfirmed`. 1.0.1 rejected it; 1.1.0 reads the page's own state
  // and leaves the stored evidence and its metadata as they are. Synthetic.
  const content = new TextEncoder().encode(
    '<!doctype html><html><body><h1>MyJCB</h1><h1>カードご利用代金明細(確定分)</h1><h2>2026年5月お支払い分のカードご利用明細</h2><div class="detail-list-01"><div class="head">ご利用日 ご利用先など 支払区分 今回のお支払い金額</div></div><dl><dt>2026年5月15日(金)お支払い金額合計</dt><dd>2,345円</dd></dl></body></html>',
  );
  await seedArtifact(
    env,
    820,
    "myjcb",
    "credit-detail",
    "synthetic-card/credit-detail-01.html",
    content,
    false,
  );
  await env.DB.prepare(
    "UPDATE fetch_artifacts SET declared_media_type='text/html; charset=utf-8' WHERE id=820",
  ).run();
  await seedArtifact(
    env,
    821,
    "myjcb",
    "collector-manifest",
    "manifest.json",
    {
      artifacts: [
        {
          connectionId: "synthetic-card",
          filename: "credit-detail-01.html",
          dataset: "credit-detail",
          statementState: "unconfirmed",
          period: "detailMonth-1",
        },
      ],
    },
    false,
  );
  await env.DB.prepare(
    "UPDATE fetch_artifacts SET fetch_run_id=820,artifact_role='collector_manifest' WHERE id=821",
  ).run();
  await env.DB.prepare("INSERT INTO fetch_run_seals(fetch_run_id,sealed_at_ms) VALUES(820,?)")
    .bind(Date.now())
    .run();
  await env.DB.prepare(
    "UPDATE observation_work_items SET processed_at_ms=?,outcome='no_new_jobs' WHERE fetch_run_id=820",
  )
    .bind(Date.now())
    .run();
  const post = async (path: string, body: unknown) => {
    const response = await mf.dispatchFetch("https://pipeline.internal" + path, {
      method: "POST",
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    return (await response.json()) as { plan: { id: number; jobs_created: number } };
  };
  const planned = await post("/replay/plan", {
    source: "myjcb",
    dataset: "credit-detail",
    parser: myJcbCreditStatement.name,
    version: myJcbCreditStatement.version,
    artifactIdFrom: 819,
    reason: "Synthetic MyJCB statement state from the page",
  });
  const started = await post("/replay/start", { planId: planned.plan.id });
  expect(started.plan.jobs_created).toBe(1);
  await sweep(env, { lane: "replay", maxJobs: 4 });
  expect(
    await env.DB.prepare(
      "SELECT status,last_error_code FROM observation_parse_jobs WHERE fetch_artifact_id=820",
    ).first<Record<string, unknown>>(),
  ).toEqual({ status: "done", last_error_code: null });
  // The evidence keeps the manifest's reading; the published parse records both.
  expect(
    await env.DB.prepare(
      "SELECT statement_state,period FROM observation_fetch_artifacts WHERE id=820",
    ).first<Record<string, unknown>>(),
  ).toEqual({ statement_state: "unconfirmed", period: "detailMonth-1" });
  expect(
    await env.DB.prepare(
      `SELECT json_extract(b.extra_json,'$._kogane.statementState') AS state,
              json_extract(b.extra_json,'$._kogane.manifestStatementState') AS manifest
         FROM balance_observations b
         JOIN published_parse_runs published ON published.parse_run_id=b.parse_run_id
        WHERE published.fetch_artifact_id=820`,
    ).first<Record<string, unknown>>(),
  ).toEqual({ state: "confirmed", manifest: "unconfirmed" });
  expect(
    await env.DB.prepare(
      "SELECT payment_date,period,coefficient FROM card_statement_facts WHERE source_id='myjcb' AND period='2026-05'",
    ).first<Record<string, unknown>>(),
  ).toEqual({ payment_date: "2026-05-15", period: "2026-05", coefficient: "2345" });
});
