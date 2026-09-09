// Read-only production coverage counters. Never emit observation values.
import { getPlatformProxy } from "wrangler";
const proxy = await getPlatformProxy<{ DB: D1Database }>({
  configPath: new URL("../wrangler.diagnostic.jsonc", import.meta.url).pathname,
  persist: false,
  remoteBindings: true,
});
try {
  const queries = {
    jobs: `SELECT parser_name,parser_version,status,last_error_code,count(*) AS count FROM observation_parse_jobs GROUP BY 1,2,3,4 ORDER BY 1,2,3`,
    observations: `SELECT 'transactions' AS kind,count(*) AS count FROM transaction_observations UNION ALL SELECT 'balances',count(*) FROM balance_observations UNION ALL SELECT 'positions',count(*) FROM position_observations UNION ALL SELECT 'valuations',count(*) FROM valuation_observations`,
    coverage: `SELECT a.source_id,count(DISTINCT a.id) AS parsed_artifacts,count(DISTINCT a.fetch_run_id) AS parsed_runs FROM observation_fetch_artifacts a JOIN published_parse_runs p ON p.fetch_artifact_id=a.id GROUP BY a.source_id`,
    publication: `SELECT mismatch,count(*) AS count FROM publication_gate_mismatches GROUP BY mismatch`,
  };
  for (const [name, sql] of Object.entries(queries)) {
    console.log(JSON.stringify({ name, rows: (await proxy.env.DB.prepare(sql).all()).results }));
  }
} finally {
  await proxy.dispose();
}
