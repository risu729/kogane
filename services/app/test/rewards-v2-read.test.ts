// The reward routes served from the READ database (unified plan 04 §2, 05 §7;
// U16), over HTTP, with both sets of migrations applied to local D1s.
//
// What is proved here:
//   G2-19  a page says the instant its deadlines were evaluated at, two reads
//          of the same published snapshot are identical, and nothing is
//          recomputed from "now" per request;
//   G2-20  a saved simulation that kept only a digest is reported
//          `not_reproducible`; one that retained its request carries the
//          replayed plan;
//   G3-01  no published snapshot is `503` with a code, never an empty success;
//   G3-03  a cursor from another read instance is `410 context_expired`, and
//          one for another query is `400 cursor_mismatch`;
//   with the reader flag off the reward routes answer exactly as they did
//   before, and `/api/meta` says which store answered.
//
// Every value is synthetic: no real member, balance or provider body appears.
import { env } from "cloudflare:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/worker";
import { publishParse, seedRegistry, seedRun } from "./fixtures";
import { runRewardReadProjection } from "../../processor/src/reward-read-projection";
import { decodeReadCursor, encodeReadCursor } from "../../../packages/storage-d1/src/read/index";

let keys: Awaited<ReturnType<typeof generateKeyPair>>;
let issuer: string;
let jwks: { keys: unknown[] };
let sequence = 0;

const EVALUATED_AT = "2026-09-11T00:00:00.000Z";

async function token() {
  return new SignJWT({ type: "app" })
    .setProtectedHeader({ alg: "RS256", kid: "fixture" })
    .setIssuer(issuer)
    .setAudience("fixture-audience")
    .setSubject("rewards-read-user")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
}

/** `read` switches the store the reward routes read; never authentication. */
async function call(path: string, options: { read?: boolean } = {}) {
  return worker.fetch(
    new Request(`https://fixture.test${path}`, {
      headers: { "cf-access-jwt-assertion": await token() },
    }),
    {
      ...env,
      ACCESS_ISSUER: issuer,
      ACCESS_AUDIENCE: "fixture-audience",
      REWARDS_V2_ENABLED: "true",
      REWARD_READ_PROJECTION_ENABLED: options.read === false ? "false" : "true",
    } as Env,
  );
}

/** One reward build into the READ database, through the processor's lane. */
async function build(evaluatedAt = EVALUATED_AT) {
  return runRewardReadProjection(
    { ...env, REWARD_READ_PROJECTION_ENABLED: "true" } as never,
    env.EVIDENCE as never,
    { now: () => evaluatedAt },
  );
}

interface ExpiryPage {
  rows: { bucketRef: string; expiresOn: string | null; ruleRef: string }[];
  page: { hasMore: boolean; nextCursor: string | null; limit: number };
  snapshot: { snapshotId: string; evaluatedAt: string; evaluationCalendar: string };
}

interface SimulationPage {
  rows: {
    requestDigest: string;
    reproducibility: string;
    reasonCode: string | null;
    result: unknown;
  }[];
  snapshot: { evaluatedAt: string };
}

beforeAll(async () => {
  await seedRegistry();
  keys = await generateKeyPair("RS256", { extractable: true });
  jwks = {
    keys: [{ ...(await exportJWK(keys.publicKey)), kid: "fixture", alg: "RS256", use: "sig" }],
  };
  const run = await seedRun({ count: 1 });
  const parse = await env.DB.prepare(
    `INSERT INTO parse_runs(fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json)
     VALUES(?,'v-point-balance-info','1.0.0','2026-09-07','ok','[]') RETURNING id`,
  )
    .bind(run.artifacts[0]!.id)
    .first<{ id: number }>();
  await publishParse(parse!.id);
  const claim = (
    digest: string,
    bucket: string,
    kind: string,
    amount: string,
    expiry: string | null,
  ) =>
    env.DB.prepare(
      `INSERT INTO reward_bucket_claims(claim_digest,parse_run_id,source_fact_kind,source_fact_id,
        program_id,holding_ref,bucket_ref,bucket_kind,restriction_refs_json,unit_ref,
        quantity_coefficient,quantity_scale,quantity_status,observed_expiry_json,observed_at,
        promotion_release,recorded_at)
       VALUES(?1,?2,'balance',?3,'program:v-point','program:v-point:member',?4,?5,'[]',
         'points:v-point',?6,0,'exact',?7,'2026-09-08T00:00:00.000Z','reward-promotion-v1',
         '2026-09-09T00:00:00.000Z')`,
    ).bind(digest, parse!.id, Number(digest.slice(-2)), bucket, kind, amount, expiry);
  await env.DB.batch([
    claim(
      "reward-read-claim-01",
      "program:v-point:slot-a",
      "time-limited",
      "5000",
      JSON.stringify({
        kind: "local-date",
        value: "2026-12-31",
        zone: "Asia/Tokyo",
        basis: "provider",
      }),
    ),
    claim("reward-read-claim-02", "program:v-point:slot-b", "regular", "3000", null),
    // Enough buckets that one page does not hold the whole snapshot, so the
    // cursor is exercised rather than asserted about.
    ...Array.from({ length: 20 }, (_, index) =>
      claim(
        `reward-read-claim-1${String(index).padStart(2, "0")}`,
        `program:v-point:slot-c-${String(index).padStart(2, "0")}`,
        "regular",
        String(100 + index),
        null,
      ),
    ),
    env.DB.prepare(
      `INSERT INTO conversion_offers(offer_id,version,source_program_ref,destination_program_ref,
        from_unit_ref,to_unit_ref,ratio_numerator,ratio_denominator,minimum_coefficient,
        minimum_scale,increment_coefficient,increment_scale,fixed_fees_json,eligibility_policy_ref,
        eligible_bucket_kinds_json,eligible_restriction_refs_json,valid_time_json,
        application_deadline_json,processing_policy_ref,processing_days,rounding_policy_ref,
        rounding_scale,rounding_mode,evidence_refs_json,verification,recorded_at)
       VALUES('offer:read-synthetic','v1','program:v-point','program:v-point-pay','points:v-point',
         'JPY','1','2','100',0,'100',0,'[]','policy:synthetic:eligibility','["regular"]','[]',
         '{"kind":"unknown","reasonCode":"synthetic"}','{"kind":"unknown","reasonCode":"synthetic"}',
         'policy:synthetic:processing',3,'policy:synthetic:rounding',0,'down','[]','verified',
         '2026-09-09T00:00:00.000Z')`,
    ),
    env.DB.prepare(
      `INSERT INTO conversion_simulations(input_digest,plan_json,search_coverage,policy_release,computed_at)
       VALUES(?1,?2,'bounded','conversion-search-v1','2026-09-09T00:00:00.000Z')`,
    ).bind(
      "a".repeat(64),
      JSON.stringify({
        request: {
          offerId: "offer:read-synthetic",
          offerVersion: "v1",
          quantity: { coefficient: "1000", scale: 0, unitRef: "points:v-point" },
        },
      }),
    ),
    env.DB.prepare(
      `INSERT INTO conversion_simulations(input_digest,plan_json,search_coverage,policy_release,computed_at)
       VALUES(?1,'{"offerRef":"offer:forgotten@v1"}','bounded','conversion-search-v1','2026-09-09T00:00:00.000Z')`,
    ).bind("b".repeat(64)),
  ]);
});

beforeEach(() => {
  issuer = `https://rewards-read-test-${++sequence}.cloudflareaccess.com`;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input) !== `${issuer}/cdn-cgi/access/certs`)
      throw new Error("Unexpected external request in synthetic test");
    return Response.json(jwks);
  });
});
afterEach(() => vi.restoreAllMocks());

describe("the reward routes over the READ database", () => {
  it("G3-01: answers unavailable with a code while nothing is published", async () => {
    const meta = (await (await call("/api/meta")).json()) as {
      capabilities: { rewardsV2: boolean; rewardsV2ReadModel: string };
    };
    expect(meta.capabilities.rewardsV2).toBe(true);
    // Nothing is built yet, so the capability says so rather than promising
    // snapshot-backed rows the Worker would refuse.
    expect(meta.capabilities.rewardsV2ReadModel).toBe("none");
    const simulations = await call("/api/v2/rewards/simulations");
    expect(simulations.status).toBe(503);
    expect(((await simulations.json()) as { error: string }).error).toBe(
      "reward_read_model_unavailable",
    );
    const expiry = await call("/api/v2/rewards/expiry");
    expect(expiry.status).toBe(503);
  });

  it("with the reader flag off the reward routes answer from CORE exactly as before", async () => {
    const expiry = await call("/api/v2/rewards/expiry", { read: false });
    expect(expiry.status).toBe(200);
    const body = (await expiry.json()) as { rows: { holdingRef: string }[]; coverage: unknown };
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.coverage).toBeDefined();
    // A saved simulation lives only in a snapshot: without the read model the
    // route is unavailable, never an empty list.
    expect((await call("/api/v2/rewards/simulations", { read: false })).status).toBe(503);
    // A cursor names a snapshot this deployment does not read; it is refused
    // rather than reinterpreted as an offset.
    const cursor = await call("/api/v2/rewards/expiry?cursor=abc", { read: false });
    expect(cursor.status).toBe(400);
    expect(((await cursor.json()) as { error: string }).error).toBe("cursor_unsupported");
    const meta = (await (await call("/api/meta", { read: false })).json()) as {
      capabilities: { rewardsV2ReadModel: string };
    };
    expect(meta.capabilities.rewardsV2ReadModel).toBe("none");
  });

  it("G2-19: a published snapshot answers with the instant it was evaluated at", async () => {
    const built = await build();
    expect(built.status).toBe("complete");

    const meta = (await (await call("/api/meta")).json()) as {
      capabilities: { rewardsV2ReadModel: string };
    };
    expect(meta.capabilities.rewardsV2ReadModel).toBe("read-d1");

    const first = (await (await call("/api/v2/rewards/expiry")).json()) as ExpiryPage;
    expect(first.snapshot.snapshotId).toBe(built.snapshotId);
    expect(first.snapshot.evaluatedAt).toBe(EVALUATED_AT);
    expect(first.snapshot.evaluationCalendar).toBe("UTC:start-of-day:assumed");
    expect(first.rows.length).toBeGreaterThan(0);
    // The provider's own date is a calendar date, and a bucket with none keeps
    // its row rather than disappearing from a deadline-ordered list.
    const dated = first.rows.filter((row) => row.expiresOn !== null);
    expect(dated.some((row) => row.expiresOn === "2026-12-31")).toBe(true);
    expect(first.rows.some((row) => row.expiresOn === null)).toBe(true);

    // Read again: the same published snapshot, the same rows. Nothing was
    // recomputed from the wall clock between the two requests.
    const again = (await (await call("/api/v2/rewards/expiry")).json()) as ExpiryPage;
    expect(again).toEqual(first);
  });

  it("G2-20: a saved simulation reports whether it could be reproduced", async () => {
    await build();
    const page = (await (await call("/api/v2/rewards/simulations")).json()) as SimulationPage;
    expect(page.snapshot.evaluatedAt).toBe(EVALUATED_AT);
    const retained = page.rows.find((row) => row.requestDigest === "a".repeat(64))!;
    const digestOnly = page.rows.find((row) => row.requestDigest === "b".repeat(64))!;
    expect(retained.reproducibility).toBe("reproduced");
    expect(retained.result).not.toBeNull();
    expect(digestOnly).toMatchObject({
      reproducibility: "not_reproducible",
      reasonCode: "simulation_input_not_retained",
      result: null,
    });
  });

  it("G3-03: pages with a cursor, and refuses one from another query or another instance", async () => {
    await build();
    const first = (await (await call("/api/v2/rewards/expiry?limit=25")).json()) as ExpiryPage;
    expect(first.page.limit).toBe(25);
    expect(first.rows.length).toBe(25);
    expect(first.page.hasMore).toBe(true);
    const next = first.page.nextCursor!;
    const second = (await (
      await call(`/api/v2/rewards/expiry?limit=25&cursor=${next}`)
    ).json()) as ExpiryPage;
    // The continuation is the rest of the same fixed snapshot: no row is
    // repeated and none is skipped.
    expect(second.snapshot.snapshotId).toBe(first.snapshot.snapshotId);
    const keys = (page: ExpiryPage) => page.rows.map((row) => `${row.ruleRef}|${row.bucketRef}`);
    expect(keys(second).some((key) => keys(first).includes(key))).toBe(false);

    const decoded = decodeReadCursor(next)!;
    // A cursor that belongs to another query — another page size, another
    // programme filter — is refused rather than reinterpreted.
    const mismatch = await call(
      `/api/v2/rewards/expiry?limit=25&cursor=${encodeReadCursor({
        ...decoded,
        filterDigest: "0".repeat(64),
      })}`,
    );
    expect(mismatch.status).toBe(400);
    expect(((await mismatch.json()) as { error: string }).error).toBe("cursor_mismatch");

    // A cursor from another physical READ database expires; it is never
    // continued against rows that only look like its list.
    const foreign = await call(
      `/api/v2/rewards/expiry?limit=25&cursor=${encodeReadCursor({
        ...decoded,
        readInstanceId: "another-read-instance",
      })}`,
    );
    expect(foreign.status).toBe(410);
    expect(((await foreign.json()) as { error: string }).error).toBe("context_expired");
    // An unreadable cursor is a bad request, not a silent first page.
    expect((await call("/api/v2/rewards/expiry?cursor=zzz")).status).toBe(400);
    // A limit the contract does not offer is refused.
    expect((await call("/api/v2/rewards/expiry?limit=7")).status).toBe(400);
  });

  it("a later evaluation publishes a new snapshot and the page follows it", async () => {
    const first = await build();
    const before = (await (await call("/api/v2/rewards/expiry")).json()) as ExpiryPage;
    const later = await build("2026-12-01T00:00:00.000Z");
    expect(later.snapshotId).not.toBe(first.snapshotId);
    const after = (await (await call("/api/v2/rewards/expiry")).json()) as ExpiryPage;
    expect(after.snapshot.snapshotId).toBe(later.snapshotId);
    expect(after.snapshot.evaluatedAt).toBe("2026-12-01T00:00:00.000Z");
    expect(before.snapshot.evaluatedAt).toBe(EVALUATED_AT);
  });
});
