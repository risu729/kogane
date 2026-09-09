// D13 / PR-14: what the reader says about a partial run whose independent
// units were parsed under `unit-independent-v1`. Two things must hold: the
// rescued unit's evidence is readable at all (the active-state projection uses
// the same eligibility scope the Worker used to parse it), and the response
// says "some units updated" instead of presenting the partial run as a
// complete refresh of the dataset. With every dataset on the seeded `run`
// scope neither the result set nor the response shape changes.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { boundedCollections } from "../src/observation-api";
import { evidenceReader } from "../src/observations";
import { publishParse, seedRegistry, seedRun } from "./fixtures";

const SOURCE = "sony-bank";
const DATASET = "gross-balance";
const PARSER = "sony-bank-gross-balance";

async function parseAndPublish(artifactId: number, account: string): Promise<void> {
  const run = await env.DB.prepare(
    `INSERT INTO parse_runs (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES (?,?,'1.0.0','2026-09-07T00:00:00Z','ok','[]') RETURNING id`,
  )
    .bind(artifactId, PARSER)
    .first<{ id: number }>();
  await publishParse(run!.id);
  await env.DB.prepare(
    `INSERT INTO balance_observations
       (parse_run_id,source_account,metric,amount_minor,instrument,as_of,raw_locator,extra_json)
     VALUES (?,?,'account_balance',1,'JPY','2026-09-07','$','{}')`,
  )
    .bind(run!.id, account)
    .run();
}

/** The operator step: one dataset named for the `unit` eligibility scope. */
async function setUnitScope(scope: "run" | "unit"): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO dataset_snapshot_policies(source_id,dataset,parser_name,policy_id,unit_scope,updated_at_ms)
     VALUES(?,?,?,'legacy-warning-compat-v1',?,1)
     ON CONFLICT(parser_name,dataset) DO UPDATE SET unit_scope=excluded.unit_scope,
       updated_at_ms=excluded.updated_at_ms`,
  )
    .bind(SOURCE, DATASET, PARSER, scope)
    .run();
}

describe("unit-scoped partial updates in the read model", () => {
  let partial: Awaited<ReturnType<typeof seedRun>>;
  beforeAll(async () => {
    await seedRegistry();
    // One sealed run the collector reported as partial: card A's own terminal
    // report succeeded, card B's failed.
    partial = await seedRun({
      source: SOURCE,
      dataset: DATASET,
      outcome: "partial",
      units: [
        { key: "card-a", outcome: "success", count: 1 },
        { key: "card-b", outcome: "failed", count: 1 },
      ],
    });
    await parseAndPublish(partial.artifacts[0]!.id, "card-a-account");
    await parseAndPublish(partial.artifacts[1]!.id, "card-b-account");
  });

  it("reports nothing and shows nothing while the dataset is on the seeded run scope", async () => {
    const reader = evidenceReader(env.DB);
    expect(await reader.unitUpdates()).toEqual([]);
    const overview = await reader.overview();
    expect(Object.hasOwn(overview, "unitUpdates")).toBe(false);
    // Neither unit of a partial run is current under the run scope.
    expect(
      (await reader.listLatestBalances({ offset: 0, limit: 501 })).map((row) => row.source_account),
    ).toEqual([]);
  });

  it("says some units updated, and shows only the proven unit, under the unit scope", async () => {
    await setUnitScope("unit");
    const reader = evidenceReader(env.DB);
    expect(await reader.unitUpdates()).toEqual([
      {
        source_id: SOURCE,
        dataset: DATASET,
        fetch_run_id: partial.id,
        fetched_at: expect.any(String),
        updated_units: 1,
        stale_units: 1,
      },
    ]);
    // The rescued unit is readable; the failed unit is not, so the partial run
    // is never presented as a refresh of the whole dataset.
    expect(
      (await reader.listLatestBalances({ offset: 0, limit: 501 })).map((row) => row.source_account),
    ).toEqual(["card-a-account"]);

    // The /api/overview body carries the signal next to the existing keys and
    // does not change any existing field.
    const overview = await reader.overview();
    const body = (await boundedCollections({ ...overview }).json()) as Record<string, unknown>;
    expect(body.unitUpdates).toEqual([
      expect.objectContaining({ updated_units: 1, stale_units: 1 }),
    ]);
    expect(body.coverage).toEqual({ limit: 500, truncated: false });
    expect(body.counts).toEqual(overview.counts);
  });

  it("goes back to silence when the policy row is set back to run", async () => {
    await setUnitScope("run");
    const reader = evidenceReader(env.DB);
    expect(await reader.unitUpdates()).toEqual([]);
    expect(Object.hasOwn(await reader.overview(), "unitUpdates")).toBe(false);
    expect(
      (await reader.listLatestBalances({ offset: 0, limit: 501 })).map((row) => row.source_account),
    ).toEqual([]);
  });
});
