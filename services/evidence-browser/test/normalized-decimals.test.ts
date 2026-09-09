import { env } from "cloudflare:test";
import { beforeAll, expect, it } from "vitest";
import { publishParse, seedRegistry, seedRun } from "./fixtures";
import { decimalRows } from "../src/normalized-decimals";
import { validNormalizedDecimal } from "../../../poc/observation-pipeline/shared/normalized-decimal";
beforeAll(seedRegistry);
it("D1 insertion triggers persist text-only exact values and API reads only selected IDs", async () => {
  const run = await seedRun({ count: 1 });
  const parse = await env.DB.prepare(
    "INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status) VALUES (?,'synthetic','1','2099','ok') RETURNING id",
  )
    .bind(run.artifacts[0]!.id)
    .first<{ id: number }>();
  await publishParse(parse!.id);
  const ids: number[] = [];
  for (const [minor, text, unit] of [
    [null, "-0.000", "EUR"],
    [null, "0.00000001", "BTC"],
    [100, "0.00", "USD"],
    [null, null, "EUR"],
  ]) {
    const row = await env.DB.prepare(
      "INSERT INTO balance_observations(parse_run_id,source_account,metric,amount_minor,amount_text,instrument,raw_locator,extra_json) VALUES (?,'synthetic','balance',?,?,?,'json:$.balance','{}') RETURNING id",
    )
      .bind(parse!.id, minor, text, unit)
      .first<{ id: number }>();
    ids.push(row!.id);
  }
  const rows = await decimalRows(
    env.DB,
    "balance",
    ids.map((id) => ({ id })),
  );
  expect(rows.map((row) => row.normalized.status)).toEqual([
    "exact",
    "exact",
    "conflict",
    "missing",
  ]);
  expect(rows.map((row) => row.normalized.coefficient)).toEqual(["0", "1", null, null]);
  expect(rows[1]!.normalized.scale).toBe(8);
  expect(rows.every((row) => validNormalizedDecimal(row.normalized))).toBe(true);
  expect((await decimalRows(env.DB, "balance", [{ id: ids[1]! }])).map((row) => row.id)).toEqual([
    ids[1],
  ]);
  await expect(decimalRows(env.DB, "balance", [{ id: 99999999 }])).rejects.toThrow(
    "missing_db_decimal",
  );
});
