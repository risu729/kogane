// The instrument candidate read on workerd's SQLite through Miniflare (ADR 0055,
// amendment 2026-10-09, Cost): the complete CORE migrations, no table
// statistics, Layer A through the real ingest path, identifiers written by the
// production identity writer. The store has the shape of
// packages/application/test/instrument-resolution-scale.test.ts: SBI
// Securities captured daily (domestic codes held on XTKS, trades on a venue
// the SBI rule does not map, foreign codes with a RIC) and a synthetic second
// broker holding some of the codes daily; every capture current.
//
// Opt-in for the measurement, like test/load.test.ts: a normal run builds two
// days and checks the read, the page and the observation bound against the
// store. Set KOGANE_LOAD_INSTRUMENT_DAYS (forwarded through
// KOGANE_LOAD_CONFIG) to build that many days at the full shape and print the
// timings the amendment quotes (run it with `--reporter=verbose`). Every code,
// name and account is synthetic.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { resolveIdentity } from "../../../packages/identity/src/index.ts";
import { currencyIdentity } from "../../../packages/identity/src/instruments.ts";
import type { IdentityInput, IdentityPlan } from "../../../packages/identity/src/types.ts";
import {
  CURRENT_IDENTITY_OBSERVATION_BOUND,
  reviewInstrumentCandidates,
} from "../../../packages/application/src/query/instrument-candidates-review.ts";
import { queryInstrumentResolution } from "../../../packages/application/src/query/instrument-resolution.ts";
import { d1Executor } from "../../../packages/read-model/src/d1.ts";
import {
  IDENTITY_OBSERVATION_COUNT_SQL,
  INSTRUMENT_FACTS_SQL,
} from "../../../packages/read-model/src/instrument-resolution.ts";
import { identifyParse } from "../../processor/src/identity-store";
import { publishParse, seedRegistry, seedRun } from "./fixtures";

const config = JSON.parse(env.KOGANE_LOAD_CONFIG || "{}") as Record<string, string | undefined>;
const FULL_DAYS = Number(config.KOGANE_LOAD_INSTRUMENT_DAYS ?? 0);
const FULL = FULL_DAYS > 0;
const SHAPE = FULL
  ? { days: FULL_DAYS, holdings: 150, trades: 10, foreign: 30, broker: 100 }
  : { days: 2, holdings: 6, trades: 2, foreign: 2, broker: 4 };
const BROKER_B = "synthetic-broker-b";
const TIMEOUT = FULL ? 7_200_000 : 120_000;
const code = (index: number): string => `SYN${String(1000 + index)}`;

/** The second broker's test policy: one provider code scoped to a country, one currency. */
function resolver(input: IdentityInput): IdentityPlan {
  if (input.sourceId !== BROKER_B) return resolveIdentity(input);
  const extra = input.extra as { country?: string };
  return {
    account: {
      key: [input.sourceAccount],
      label: "Synthetic broker B",
      role: "brokerage",
      status: "provider-local",
      reason: "synthetic-test-policy",
    },
    instruments: [
      currencyIdentity(input.currency ?? "JPY", "unit"),
      {
        role: "security",
        kind: "security",
        namespace: "synthetic-broker-b-code",
        scope: extra.country ?? "unknown-country",
        value: input.securityCode ?? "unknown",
        label: input.securityName ?? input.securityCode ?? "unknown",
        status: "provider-local",
        reason: "synthetic-test-policy",
        details: {
          securityCode: input.securityCode ?? "unknown",
          ...(extra.country ? { countryCode: extra.country } : {}),
        },
      },
    ],
    issues: [],
  };
}

interface Row {
  account: string;
  code: string;
  name: string;
  market: string | null;
  currency: string;
  extra: Record<string, unknown>;
}

async function capture(
  artifactId: number,
  positions: Row[],
  trades: { account: string; currency: string; extra: Record<string, unknown> }[],
): Promise<number> {
  const parse = await env.DB.prepare(`INSERT INTO parse_runs
    (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
    VALUES (?,'synthetic','1','2099-01-01','ok','[]') RETURNING id`)
    .bind(artifactId)
    .first<{ id: number }>();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO position_observations
      (parse_run_id,source_account,security_code,security_name,market,quantity_text,quantity_scale,currency,raw_locator,extra_json)
      SELECT ?1,json_extract(value,'$.account'),json_extract(value,'$.code'),json_extract(value,'$.name'),
       json_extract(value,'$.market'),'1',0,json_extract(value,'$.currency'),'$.positions['||key||']',
       json(json_extract(value,'$.extra'))
      FROM json_each(?2)`).bind(parse!.id, JSON.stringify(positions)),
    env.DB.prepare(`INSERT INTO transaction_observations
      (parse_run_id,source_account,currency,raw_locator,extra_json)
      SELECT ?1,json_extract(value,'$.account'),json_extract(value,'$.currency'),'$.trades['||key||']',
       json(json_extract(value,'$.extra'))
      FROM json_each(?2)`).bind(parse!.id, JSON.stringify(trades)),
  ]);
  await publishParse(parse!.id);
  const meta =
    await env.DB.prepare(`SELECT p.id,a.id artifact_id,a.source_id,r.producer_id,a.fetch_run_id
    FROM parse_runs p JOIN observation_fetch_artifacts a ON a.id=p.fetch_artifact_id
    JOIN financial_fetch_runs r ON r.id=a.fetch_run_id WHERE p.id=?`)
      .bind(parse!.id)
      .first<{
        id: number;
        artifact_id: number;
        source_id: string;
        producer_id: string;
        fetch_run_id: number;
      }>();
  while (await identifyParse(env.DB, meta!, resolver)) {
    // Resume the production writer's bounded pages until the run is sealed.
  }
  return positions.length + trades.length;
}

let observations = 0;

beforeAll(async () => {
  await seedRegistry();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sources (id,provider,display_name) VALUES ('${BROKER_B}','synthetic','Synthetic broker B')`,
    ),
    ...["sbi-securities", BROKER_B].flatMap((source) => [
      env.DB.prepare(
        "INSERT INTO producer_sources (producer_id,source_id) VALUES ('evidence-test',?)",
      ).bind(source),
      env.DB.prepare(
        "INSERT INTO ingest_client_routes (ingest_client_id,producer_id,source_id) VALUES ('evidence-test','evidence-test',?)",
      ).bind(source),
    ]),
  ]);
  // One sealed run per source with one artifact per captured day.
  const sbi = await seedRun({ source: "sbi-securities", count: SHAPE.days });
  const broker = await seedRun({ source: BROKER_B, count: SHAPE.days });
  for (let day = 0; day < SHAPE.days; day += 1) {
    observations += await capture(
      sbi.artifacts[day]!.id,
      [
        ...Array.from({ length: SHAPE.holdings }, (_, index) => ({
          account: "sbi-securities:domestic",
          code: code(index),
          name: `Synthetic ${code(index)}`,
          market: "TKY",
          currency: "JPY",
          extra: {},
        })),
        ...Array.from({ length: SHAPE.foreign }, (_, index) => ({
          account: "sbi-securities:foreign",
          code: `SYNF${String(index)}`,
          name: `Synthetic foreign ${String(index)}`,
          market: null,
          currency: "USD",
          extra: {
            specificAccountCode: "SYNTHETIC",
            securities: {
              securitiesCode: `SYNF${String(index)}`,
              ric: `SYNF${String(index)}.X`,
              countryCode: "US",
            },
          },
        })),
      ],
      Array.from({ length: SHAPE.trades }, (_, index) => {
        const traded = code((day * SHAPE.trades + index) % SHAPE.holdings);
        return {
          account: "sbi-securities:domestic",
          currency: "JPY",
          extra: {
            issueCode: traded,
            issueName: `Synthetic ${traded}`,
            marketLabel: "SYNTHETIC-VENUE",
            accountLabel: "synthetic",
          },
        };
      }),
    );
    observations += await capture(
      broker.artifacts[day]!.id,
      Array.from({ length: SHAPE.broker }, (_, index) => ({
        account: "synthetic-broker-b:custody",
        code: code(index),
        name: `SYNTHETIC ${code(index)}`,
        market: null,
        currency: "JPY",
        extra: { country: "JP" },
      })),
      [],
    );
  }
}, TIMEOUT);

/** Median wall time of `runs` executions, in milliseconds. */
async function timed(run: () => Promise<unknown>, runs = 5): Promise<number> {
  const times: number[] = [];
  for (let index = 0; index < runs; index += 1) {
    const start = performance.now();
    await run();
    times.push(performance.now() - start);
  }
  return Math.round(times.sort((left, right) => left - right)[Math.floor(runs / 2)]!);
}

const READER = {
  principal: "synthetic-reader",
  scopes: { sources: "*", accounts: "*" },
  capabilities: ["records.read"],
  budget: { maxRows: 1000, maxProposalTargets: 1, maxExplainDepth: 6 },
} as const;
const OPEN = { view: "open", offset: 0, identifierId: null } as const;

describe("the candidate read on workerd", () => {
  it(
    "answers on the built store, and the observation bound counts what the read walks",
    async () => {
      const sql = d1Executor(env.DB);
      const current = await env.DB.prepare(
        "SELECT count(*) AS n FROM current_identity_observations",
      ).first<number>("n");
      expect(current).toBe(observations);
      const bound = await env.DB.prepare(IDENTITY_OBSERVATION_COUNT_SQL).first<number>("n");
      expect(bound).toBe(observations);
      const resolution = await queryInstrumentResolution(sql);
      expect(resolution.identifiers.filter((row) => row.namespace === "mic-symbol")).toHaveLength(
        SHAPE.holdings,
      );
      const outcome = await reviewInstrumentCandidates({ grant: READER, sql, request: OPEN });
      // Within the bound the page answers; past it the service refuses before the walk.
      expect(outcome.ok).toBe(observations <= CURRENT_IDENTITY_OBSERVATION_BOUND);
      if (!FULL) return;
      const facts = await timed(() => sql.all(INSTRUMENT_FACTS_SQL, []));
      const count = await timed(() => env.DB.prepare(IDENTITY_OBSERVATION_COUNT_SQL).first());
      const whole = await timed(() => queryInstrumentResolution(sql));
      const page = await timed(() =>
        reviewInstrumentCandidates({ grant: READER, sql, request: OPEN }),
      );
      // Printed by `vitest run --reporter=verbose`.
      console.log(
        JSON.stringify({
          shape: SHAPE,
          identityObservations: observations,
          identifiers: resolution.summary.identifiers,
          candidates: resolution.candidates.length,
          medianMs: { facts, count, whole, page },
        }),
      );
    },
    TIMEOUT,
  );
});
