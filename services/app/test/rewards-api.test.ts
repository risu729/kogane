import { seedRewardCapture } from "./reward-capture-fixture";
import { validApiResponse } from "../../../packages/observation-shared/src/api-validation.ts";
// /api/v2/rewards behind the rewardsV2 capability (A11). Synthetic data only.
// The simulation route is a query: these tests prove it writes nothing and
// performs no exchange, and that the route group is absent while the flag is
// off.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { publishParse, seedRegistry } from "./fixtures";

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let issuer: string;
let jwks: { keys: unknown[] };
let sequence = 0;

const OFFER = {
  offer_id: "offer:synthetic-a-to-b",
  version: "v1",
  source_program_ref: "program:v-point",
  destination_program_ref: "program:v-point-pay",
  from_unit_ref: "points:v-point",
  to_unit_ref: "JPY",
  ratio_numerator: "1",
  ratio_denominator: "2",
  minimum_coefficient: "1000",
  minimum_scale: 0,
  increment_coefficient: "1000",
  increment_scale: 0,
  maximum_per_request_coefficient: "3000",
  maximum_per_request_scale: 0,
  shared_quota_ref: null,
  fixed_fees_json: JSON.stringify([
    {
      unitRef: "JPY",
      value: {
        status: "exact",
        value: { coefficient: "100", scale: 0 },
        normalizationVersion: "decimal-v1",
      },
    },
  ]),
  variable_fee_policy_ref: null,
  eligibility_policy_ref: "policy:synthetic:eligibility:v1",
  eligible_bucket_kinds_json: JSON.stringify(["regular"]),
  eligible_restriction_refs_json: "[]",
  eligible_tiers_json: null,
  valid_time_json: JSON.stringify({
    kind: "period",
    start: "2026-01-01",
    end: "2027-12-31",
    endExclusive: false,
    zone: "Asia/Tokyo",
    granularity: "day",
  }),
  application_deadline_json: JSON.stringify({
    kind: "local-date",
    value: "2027-12-31",
    zone: "Asia/Tokyo",
    basis: "provider",
  }),
  processing_policy_ref: "policy:synthetic:processing:v1",
  processing_days: 3,
  rounding_policy_ref: "policy:synthetic:rounding:v1",
  rounding_scale: 0,
  rounding_mode: "down",
  cancellation_policy_ref: "policy:synthetic:cancellation:v1",
  evidence_refs_json: JSON.stringify(["evidence:synthetic-offer"]),
  verification: "verified",
  recorded_at: "2026-09-09T00:00:00.000Z",
};

beforeAll(async () => {
  await seedRegistry();
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
  const run = await seedRewardCapture();
  const parse = await env.DB.prepare(`INSERT INTO parse_runs
    (fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
    VALUES (?,'v-point-balance-info','1.0.0','2026-09-07','ok','[]') RETURNING id`)
    .bind(run.artifacts[0]!.id)
    .first<{ id: number }>();
  await publishParse(parse!.id);
  const claim = (
    digest: string,
    bucket: string,
    kind: string,
    coefficient: string,
    restrictions: string,
    expiry: string | null,
  ) =>
    env.DB.prepare(
      `INSERT INTO reward_bucket_claims_v2(claim_digest,parse_run_id,source_fact_kind,source_fact_id,
       program_id,holding_ref,bucket_ref,bucket_kind,restriction_refs_json,unit_ref,
       quantity_coefficient,quantity_scale,quantity_status,observed_expiry_json,observed_at,
       promotion_release,recorded_at)
       VALUES(?1,?2,'balance',?3,'program:v-point','program:v-point:member',?4,?5,?6,'points:v-point',
       ?7,0,'exact',?8,'2026-09-08T00:00:00.000Z','reward-promotion-v2','2026-09-09T00:00:00.000Z')`,
    ).bind(
      digest,
      parse!.id,
      Number(digest.slice(-2)),
      bucket,
      kind,
      restrictions,
      coefficient,
      expiry,
    );
  await env.DB.batch([
    claim(
      "reward-claim-01",
      "program:v-point:v-point:common:bucket-0",
      "regular",
      "5000",
      "[]",
      null,
    ),
    claim(
      "reward-claim-02",
      "program:v-point:v-point:store-limited:group-0:item-0",
      "restricted",
      "3000",
      JSON.stringify(["restriction:v-point:store-limited"]),
      JSON.stringify({
        kind: "local-date",
        value: "2026-11-30",
        zone: "Asia/Tokyo",
        basis: "provider",
      }),
    ),
    claim(
      "reward-claim-03",
      "program:v-point:v-point:smfg:smbc",
      "qualification",
      "120",
      JSON.stringify(["measure:v-point:previous-month-earned"]),
      null,
    ),
    env.DB.prepare(
      `INSERT INTO membership_state_claims(claim_digest,parse_run_id,program_id,holding_ref,tier,
       valid_json,source,evidence_refs_json,recorded_at)
       VALUES('membership-01',NULL,'program:v-point','program:v-point:member','synthetic-tier',
       ?1,'self-reported','["evidence:self-report"]','2026-09-09T00:00:00.000Z')`,
    ).bind(
      JSON.stringify({
        kind: "period",
        start: "2026-04-01",
        end: "2027-03-31",
        endExclusive: false,
        zone: "Asia/Tokyo",
        granularity: "day",
      }),
    ),
    env.DB.prepare(
      `INSERT INTO conversion_offers(${Object.keys(OFFER).join(",")})
       VALUES(${Object.keys(OFFER)
         .map((_, index) => `?${index + 1}`)
         .join(",")})`,
    ).bind(...Object.values(OFFER)),
  ]);
});

beforeEach(() => {
  issuer = `https://rewards-test-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected external request in synthetic test");
    return Response.json(jwks);
  });
});
afterEach(() => vi.restoreAllMocks());

async function token() {
  return new SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(issuer)
    .setAudience("fixture-audience")
    .setSubject("rewards-fixture-user")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
}

/** Appends synthetic offers; conversion_offers rejects updates and deletes. */
async function storeOffers(rows: readonly (typeof OFFER)[]) {
  await env.DB.batch(
    rows.map((row) =>
      env.DB.prepare(
        `INSERT INTO conversion_offers(${Object.keys(row).join(",")})
         VALUES(${Object.keys(row)
           .map((_, index) => `?${index + 1}`)
           .join(",")})`,
      ).bind(...Object.values(row)),
    ),
  );
}

async function get(path: string, enabled = true, method = "GET") {
  return worker.fetch(
    new Request(`https://fixture.test${path}`, {
      method,
      headers: { "cf-access-jwt-assertion": await token() },
    }),
    {
      ...env,
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: "fixture-audience",
      REWARDS_V2_ENABLED: enabled ? "true" : "false",
    } as unknown as Env,
  );
}

it("serves holdings in the browser's validated contract", async () => {
  for (const path of ["/api/v2/rewards/holdings"]) {
    const response = await get(path);
    expect(response.status).toBe(200);
    expect(validApiResponse(path, await response.json())).toBe(true);
  }
});

describe("reward reads", () => {
  it("stays available when the retired flag is off, and expiry still needs a snapshot", async () => {
    expect((await get("/api/v2/rewards/holdings", false)).status).toBe(200);
    const expiry = await get("/api/v2/rewards/expiry", false);
    expect(expiry.status).toBe(503);
    expect(await expiry.json()).toMatchObject({ error: "reward_read_model_unavailable" });
    for (const enabled of [false, true]) {
      const meta = (await (await get("/api/meta", enabled)).json()) as {
        capabilities: { rewardsV2: boolean };
      };
      expect(meta.capabilities.rewardsV2).toBe(true);
    }
  });

  it("requires authentication before any capability applies", async () => {
    const response = await worker.fetch(
      new Request("https://fixture.test/api/v2/rewards/holdings"),
      {
        ...env,
        ACCESS_ISSUER: issuer,
        ACCESS_AUDIENCE: "fixture-audience",
        REWARDS_V2_ENABLED: "true",
      } as unknown as Env,
    );
    expect(response.status).toBe(401);
  });

  it("refuses writes and unknown parameters", async () => {
    expect((await get("/api/v2/rewards/holdings", true, "POST")).status).toBe(405);
    expect((await get("/api/v2/rewards/holdings?unexpected=1")).status).toBe(400);
    expect((await get("/api/v2/rewards/nonsense")).status).toBe(404);
    expect((await get("/api/v2/rewards/holdings?offset=-1")).status).toBe(400);
  });

  it("reports buckets, restrictions and observed expiry in the programme's own unit", async () => {
    const body = (await (await get("/api/v2/rewards/holdings?program=program:v-point")).json()) as {
      rows: {
        unitRef: string;
        holdingKind: string;
        consumable: { unitRef: string; value: { value: { coefficient: string } } };
        byKind: { kind: string; quantity: { value: { value: { coefficient: string } } } }[];
        buckets: { bucketRef: string; kind: string; observedExpiry: unknown }[];
        qualificationMeasures: { consumable: boolean; quantity: unknown }[];
        membership: { tier: string; source: string }[];
        valueModel: { netAssetEligible: boolean; cashLikeRedemptionEstimate: unknown };
      }[];
      coverage: { limit: number; truncated: boolean; nextOffset: number | null };
    };
    expect(body.rows).toHaveLength(1);
    const holding = body.rows[0]!;
    expect(holding.unitRef).toBe("points:v-point");
    // 5,000 regular + 3,000 restricted; the 120 qualification points are not
    // in the consumable subtotal and never become yen.
    expect(holding.consumable.value.value.coefficient).toBe("8000");
    expect(
      holding.byKind.map((entry) => [entry.kind, entry.quantity.value.value.coefficient]),
    ).toEqual([
      ["regular", "5000"],
      ["restricted", "3000"],
    ]);
    expect(holding.qualificationMeasures).toHaveLength(1);
    expect(holding.qualificationMeasures[0]!.consumable).toBe(false);
    expect(holding.membership).toEqual([
      {
        tier: "synthetic-tier",
        valid: expect.anything(),
        source: "self-reported",
        evidenceRefs: ["evidence:self-report"],
      },
    ]);
    expect(holding.valueModel).toEqual({
      netAssetEligible: false,
      cashLikeRedemptionEstimate: null,
      reasonCode: "no_offer_named",
    });
    expect(holding.buckets.find((b) => b.kind === "restricted")!.observedExpiry).toEqual({
      kind: "local-date",
      value: "2026-11-30",
      zone: "Asia/Tokyo",
      basis: "provider",
    });
    expect(body.coverage).toEqual({ limit: 200, truncated: false, nextOffset: null });
  });

  it("requires a published READ snapshot for expiry even when CORE has holdings", async () => {
    const response = await get("/api/v2/rewards/expiry?program=program:v-point");
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "reward_read_model_unavailable" });
  });

  it("simulates a conversion as a pure query: 2,500 uses 2,000 and receives 1,000", async () => {
    const before = await env.DB.prepare(
      "SELECT count(*) AS n FROM reward_bucket_claims_v2",
    ).first<number>("n");
    const body = (await (
      await get(
        "/api/v2/rewards/offers/simulate?offer=offer:synthetic-a-to-b&quantity=2500&unit=points:v-point",
      )
    ).json()) as {
      simulation: {
        use: { value: { value: { coefficient: string } } };
        receive: { value: { value: { coefficient: string } } };
        remainder: { value: { value: { coefficient: string } } };
        fees: { unitRef: string }[];
        reasonCodes: string[];
        basis: string;
        performsExchange: boolean;
        cashLikeRedemptionEstimate: { netAssetEligible: boolean; conditionRefs: string[] };
      };
    };
    expect(body.simulation.use.value.value.coefficient).toBe("2000");
    expect(body.simulation.receive.value.value.coefficient).toBe("1000");
    expect(body.simulation.remainder.value.value.coefficient).toBe("500");
    expect(body.simulation.fees[0]!.unitRef).toBe("JPY");
    expect(body.simulation.basis).toBe("policy-estimated");
    expect(body.simulation.reasonCodes).toContain("credit_is_not_the_application");
    expect(body.simulation.performsExchange).toBe(false);
    expect(body.simulation.cashLikeRedemptionEstimate.netAssetEligible).toBe(false);
    expect(body.simulation.cashLikeRedemptionEstimate.conditionRefs).toContain(
      "policy:synthetic:rounding:v1",
    );
    // The query wrote nothing.
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM reward_bucket_claims_v2").first<number>("n"),
    ).toBe(before);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name='conversion_simulations'",
      ).first<number>("n"),
    ).toBe(0);
  });

  it("returns a bounded route search that never claims to be optimal", async () => {
    const body = (await (
      await get("/api/v2/rewards/offers/simulate?goal=JPY&quantity=2500&unit=points:v-point")
    ).json()) as {
      paths: { optimality: string; hops: { offerRef: string }[] }[];
      searchCoverage: string;
      budget: { maxDepth: number; maxExpansions: number };
      expansions: number;
      stoppedBy: string[];
      basis: string;
    };
    expect(body.searchCoverage).toBe("bounded");
    // One stored offer, examined at the start and again from JPY: no cap ended
    // the search, so the single path is all the stored offers give.
    expect(body.expansions).toBe(2);
    expect(body.budget.maxExpansions).toBe(500);
    expect(body.stoppedBy).toEqual([]);
    expect(body.basis).toBe("policy-estimated");
    expect(body.budget.maxDepth).toBe(2);
    expect(body.paths).toHaveLength(1);
    expect(body.paths[0]!.optimality).toBe("not-determined");
    expect(body.paths[0]!.hops[0]!.offerRef).toBe("offer:synthetic-a-to-b@v1");
  });

  it("refuses a malformed quantity and a request naming neither an offer nor a goal", async () => {
    expect(
      (await get("/api/v2/rewards/offers/simulate?offer=offer:synthetic-a-to-b&quantity=abc"))
        .status,
    ).toBe(400);
    expect((await get("/api/v2/rewards/offers/simulate?quantity=1000")).status).toBe(400);
  });

  it("reports the offer bound on every simulate answer", async () => {
    const named = (await (
      await get("/api/v2/rewards/offers/simulate?offer=offer:synthetic-a-to-b&quantity=2500")
    ).json()) as { offerCoverage: unknown };
    expect(named.offerCoverage).toEqual({ limit: 200, truncated: false });
    const search = (await (
      await get("/api/v2/rewards/offers/simulate?goal=JPY&quantity=2500&unit=points:v-point")
    ).json()) as { offerCoverage: unknown };
    expect(search.offerCoverage).toEqual({ limit: 200, truncated: false });
    const none = (await (
      await get("/api/v2/rewards/offers/simulate?offer=offer:synthetic-absent&quantity=2500")
    ).json()) as { offerCoverage: unknown; reasonCodes: string[] };
    expect(none.reasonCodes).toEqual(["no_stored_offer"]);
    expect(none.offerCoverage).toEqual({ limit: 200, truncated: false });
  });

  it("never picks one stored version of a named offer on the caller's behalf", async () => {
    // Two versions of one synthetic offer with different rates, on units no
    // other test converts. No adoption pointer exists and version text has no
    // defined order, so neither version is "the" offer.
    const versioned = {
      ...OFFER,
      offer_id: "offer:synthetic-versioned",
      from_unit_ref: "points:synthetic-versioned",
      to_unit_ref: "points:synthetic-versioned-out",
      fixed_fees_json: "[]",
    };
    await storeOffers([
      { ...versioned, version: "v1", ratio_numerator: "1", ratio_denominator: "2" },
      { ...versioned, version: "v2", ratio_numerator: "1", ratio_denominator: "4" },
    ]);
    const unnamed = await get(
      "/api/v2/rewards/offers/simulate?offer=offer:synthetic-versioned&quantity=2000",
    );
    expect(unnamed.status).toBe(200);
    expect(await unnamed.json()).toEqual({
      simulation: null,
      offerCoverage: { limit: 200, truncated: false },
      offerVersions: ["offer:synthetic-versioned@v1", "offer:synthetic-versioned@v2"],
      reasonCodes: ["offer_version_not_selected"],
      release: "conversion-search-v1",
    });
    const receive = async (version: string) =>
      (
        (await (
          await get(
            `/api/v2/rewards/offers/simulate?offer=offer:synthetic-versioned&version=${version}&quantity=2000`,
          )
        ).json()) as {
          simulation: { offerRef: string; receive: { value: { value: { coefficient: string } } } };
        }
      ).simulation;
    expect(await receive("v1")).toMatchObject({
      offerRef: "offer:synthetic-versioned@v1",
      receive: { value: { value: { coefficient: "1000" } } },
    });
    expect(await receive("v2")).toMatchObject({
      offerRef: "offer:synthetic-versioned@v2",
      receive: { value: { value: { coefficient: "500" } } },
    });
    const absent = (await (
      await get(
        "/api/v2/rewards/offers/simulate?offer=offer:synthetic-versioned&version=v3&quantity=2000",
      )
    ).json()) as { simulation: unknown; reasonCodes: string[] };
    expect(absent.simulation).toBeNull();
    expect(absent.reasonCodes).toEqual(["no_stored_offer"]);
    // A version names a version of an offer; without the offer it means nothing.
    expect(
      (await get("/api/v2/rewards/offers/simulate?goal=JPY&version=v1&quantity=2000")).status,
    ).toBe(400);
  });

  it("never picks a goal search's starting unit on the caller's behalf", async () => {
    // Two synthetic offers from different source units that both reach one
    // goal, on units no other test converts. The offer ids sort the opposite
    // way to the units, so a first-row pick and a first-unit pick differ.
    const goal = "points:synthetic-goal";
    await storeOffers([
      {
        ...OFFER,
        offer_id: "offer:synthetic-goal-from-y",
        from_unit_ref: "points:synthetic-goal-source-y",
        to_unit_ref: goal,
        fixed_fees_json: "[]",
      },
      {
        ...OFFER,
        offer_id: "offer:synthetic-goal-from-z",
        from_unit_ref: "points:synthetic-goal-source-x",
        to_unit_ref: goal,
        ratio_denominator: "4",
        fixed_fees_json: "[]",
      },
    ]);
    // Naming the unit gives a different path for each source: an answer
    // without one would be one of these, chosen by row order.
    const pathFrom = async (unit: string) =>
      (
        (await (
          await get(`/api/v2/rewards/offers/simulate?goal=${goal}&quantity=2000&unit=${unit}`)
        ).json()) as { paths: { hops: { offerRef: string }[] }[] }
      ).paths.map((path) => path.hops.map((hop) => hop.offerRef));
    expect(await pathFrom("points:synthetic-goal-source-y")).toEqual([
      ["offer:synthetic-goal-from-y@v1"],
    ]);
    expect(await pathFrom("points:synthetic-goal-source-x")).toEqual([
      ["offer:synthetic-goal-from-z@v1"],
    ]);

    const response = await get(`/api/v2/rewards/offers/simulate?goal=${goal}&quantity=2000`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    // Every distinct source unit of the stored offers, in code-unit order
    // rather than reader order, so the list does not depend on row order.
    const stored = (
      await env.DB.prepare(
        "SELECT DISTINCT from_unit_ref AS unit FROM conversion_offers ORDER BY from_unit_ref",
      ).all<{ unit: string }>()
    ).results.map((row) => row.unit);
    expect(stored).toEqual(
      expect.arrayContaining(["points:synthetic-goal-source-x", "points:synthetic-goal-source-y"]),
    );
    expect(body).toEqual({
      simulation: null,
      searchCoverage: "bounded",
      offerCoverage: { limit: 200, truncated: false },
      sourceUnits: stored,
      reasonCodes: ["source_unit_not_selected"],
      release: "conversion-search-v1",
    });
    expect(body).not.toHaveProperty("paths");
    expect(body).not.toHaveProperty("rejected");

    // A named offer has one source unit, so its goal search needs no `unit`.
    const named = (await (
      await get(
        `/api/v2/rewards/offers/simulate?offer=offer:synthetic-goal-from-y&goal=${goal}&quantity=2000`,
      )
    ).json()) as { paths: { hops: { offerRef: string }[] }[] };
    expect(named.paths.map((path) => path.hops.map((hop) => hop.offerRef))).toEqual([
      ["offer:synthetic-goal-from-y@v1"],
    ]);
  });

  // Last in the file: it stores 200 more offers, and conversion_offers is
  // append-only, so nothing after it may assume the single fixture offer.
  it("refuses a goal search over an offer set larger than its bound instead of answering from part of it", async () => {
    // 200 synthetic offers whose ids sort before the fixture offer, so the only
    // offer that reaches JPY is the 201st row in the reader's order.
    const filler = Array.from({ length: 200 }, (_, index) => ({
      ...OFFER,
      offer_id: `offer:synthetic-0-filler-${String(index).padStart(3, "0")}`,
      from_unit_ref: "points:synthetic-filler",
      to_unit_ref: "points:synthetic-filler-out",
    }));
    await storeOffers(filler);
    const response = await get(
      "/api/v2/rewards/offers/simulate?goal=JPY&quantity=2500&unit=points:v-point",
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    // Not "no path": the search did not run over a partial offer set, so the
    // answer is a closed reason with the bound it hit, and no path list at all.
    expect(body).not.toHaveProperty("paths");
    expect(body).not.toHaveProperty("rejected");
    expect(body.simulation).toBeNull();
    expect(body.searchCoverage).toBe("bounded");
    expect(body.offerCoverage).toEqual({ limit: 200, truncated: true });
    expect(body.reasonCodes).toEqual(["offer_set_too_large"]);
    // A named offer reads that offer's own versions, which stay within the bound.
    const named = (await (
      await get("/api/v2/rewards/offers/simulate?offer=offer:synthetic-a-to-b&quantity=2500")
    ).json()) as {
      offerCoverage: unknown;
      simulation: { receive: { value: { value: { coefficient: string } } } };
    };
    expect(named.offerCoverage).toEqual({ limit: 200, truncated: false });
    expect(named.simulation.receive.value.value.coefficient).toBe("1000");
  });
});
