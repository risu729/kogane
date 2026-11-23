// ADR 0128 slice S6 adds `next` and `paging` to the two candidate reviews and
// changes nothing else. This runs the shipped readers beside their frozen
// pre-S6 text (`candidate-reviews-legacy.ts`) on the synthetic worlds, a
// scaled store and a seeded random one, over every view, a spread of offsets,
// both kinds of filter and grants whose `maxRows` falls on, before and after
// a page edge. Each shipped page must be accepted by the browser's validator
// (so `next` and `paging` agree with `nextOffset` and `total`), end with
// exactly those two fields, and be byte for byte the frozen answer without
// them; each refusal must be the frozen refusal. Every value is synthetic.
import { beforeAll, describe, expect, test } from "bun:test";
import type { Grant } from "../src/grants.ts";
import {
  ACCOUNT_CANDIDATE_VIEWS,
  reviewAccountCandidates,
  type AccountCandidatesRequest,
} from "../src/query/account-candidates.ts";
import {
  INSTRUMENT_CANDIDATE_VIEWS,
  reviewInstrumentCandidates,
  type InstrumentCandidatesRequest,
} from "../src/query/instrument-candidates-review.ts";
import { ACCOUNT_CANDIDATES_PATH } from "../../observation-shared/src/account-candidates-contract.ts";
import { INSTRUMENT_CANDIDATES_PATH } from "../../observation-shared/src/instrument-candidates-contract.ts";
import { validApiResponse } from "../../observation-shared/src/api-validation.ts";
import { validPagedFields } from "../../observation-shared/src/paging-contract.ts";
import { BANK, DIRECT_PRODUCER, Store, world as accountWorld } from "./account-candidates-world.ts";
import {
  legacyReviewAccountCandidates,
  legacyReviewInstrumentCandidates,
} from "./candidate-reviews-legacy.ts";
import {
  BROKER_B,
  heldWorld,
  stubDatabase,
  World,
  world as instrumentWorld,
} from "./instrument-resolution-world.ts";

const grant = (maxRows: number): Grant => ({
  principal: "synthetic-reader",
  scopes: { sources: "*", accounts: "*" },
  capabilities: ["records.read"],
  budget: { maxRows, maxProposalTargets: 1, maxExplainDepth: 6 },
});
/** On, before and after the edges of the first three pages of 50. */
const MAX_ROWS = [49, 50, 51, 99, 100, 101, 149, 150, 1000];
const OFFSETS = [0, 1, 25, 49, 50, 51, 99, 100, 150, 400];

/** A seeded generator, so a failing random store is the same store on the next run. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2 ** 31;
    return state / 2 ** 31;
  };
}

interface Tally {
  compared: number;
  refused: number;
  withheld: number;
  offered: number;
  last: number;
}
const tally = (): Tally => ({ compared: 0, refused: 0, withheld: 0, offered: 0, last: 0 });

/** One request through the shipped and the frozen reader, compared. */
function compare(
  path: string,
  label: string,
  shipped: { ok: boolean; review?: unknown; error?: unknown },
  legacy: { ok: boolean; review?: unknown; error?: unknown },
  counts: Tally,
): void {
  counts.compared += 1;
  if (!shipped.ok || !legacy.ok) {
    counts.refused += 1;
    expect(JSON.stringify(shipped), label).toBe(JSON.stringify(legacy));
    return;
  }
  const review = shipped.review as Record<string, unknown>;
  expect({ label, valid: validApiResponse(path, review), paged: validPagedFields(review) }).toEqual(
    { label, valid: true, paged: true },
  );
  expect(Object.keys(review).slice(-2), label).toEqual(["next", "paging"]);
  const {
    next: _next,
    paging,
    ...rest
  } = review as {
    next: unknown;
    paging: { stoppedBy: string | null };
  };
  expect(JSON.stringify(rest), label).toBe(JSON.stringify(legacy.review));
  if (paging.stoppedBy === "budget") counts.withheld += 1;
  else if (paging.stoppedBy === null) counts.last += 1;
  else counts.offered += 1;
}

async function accountsOn(store: Store, filters: (string | null)[], counts: Tally) {
  for (const view of ACCOUNT_CANDIDATE_VIEWS)
    for (const sourceAccountId of filters)
      for (const offset of OFFSETS)
        for (const maxRows of MAX_ROWS) {
          const request: AccountCandidatesRequest = { view, offset, sourceAccountId };
          const input = { grant: grant(maxRows), sql: store.sql, request };
          compare(
            ACCOUNT_CANDIDATES_PATH,
            JSON.stringify({ ...request, maxRows }),
            await reviewAccountCandidates(input),
            await legacyReviewAccountCandidates(input),
            counts,
          );
        }
}

async function instrumentsOn(w: World, filters: (string | null)[], counts: Tally) {
  for (const view of INSTRUMENT_CANDIDATE_VIEWS)
    for (const identifierId of filters)
      for (const offset of OFFSETS)
        for (const maxRows of MAX_ROWS) {
          const request: InstrumentCandidatesRequest = { view, offset, identifierId };
          const input = { grant: grant(maxRows), sql: w.sql, request };
          compare(
            INSTRUMENT_CANDIDATES_PATH,
            JSON.stringify({ ...request, maxRows }),
            await reviewInstrumentCandidates(input),
            await legacyReviewInstrumentCandidates(input),
            counts,
          );
        }
}

/** Confirmed reviews of random direct sets (some shared, so some are held) and unreviewed accounts. */
function randomAccountStore(seed: number): { store: Store; filters: string[] } {
  const next = random(seed);
  const s = new Store();
  const directs = Array.from(
    { length: 40 + Math.floor(next() * 80) },
    (_, i) => `sa-direct-${String(i).padStart(3, "0")}`,
  );
  for (const id of directs)
    s.sourceAccount(id, BANK, DIRECT_PRODUCER, [`${BANK}:${id}`], "Synthetic");
  const reviews = 1 + Math.floor(next() * 4);
  for (let r = 0; r < reviews; r++) {
    const key = `moneyforward-account-v2-${String(r).repeat(64).slice(0, 64)}`;
    s.aggregator(`sa-mf-${String(r)}`, key);
    const chosen = directs.filter(() => next() < 0.6).slice(0, 100);
    s.review(key, chosen.length > 0 ? chosen : [directs[0]!]);
  }
  const unreviewed = Math.floor(next() * 130);
  for (let u = 0; u < unreviewed; u++)
    s.aggregator(
      `sa-mf-unreviewed-${String(u).padStart(3, "0")}`,
      `moneyforward-account-v2-${(1000 + u).toString(16).padStart(64, "f")}`,
    );
  return { store: s, filters: [directs[0]!, "sa-mf-0"] };
}

/** `count` codes held at SBI on XTKS and at broker B: one open candidate each. */
async function pairs(count: number): Promise<World> {
  const w = new World();
  const codes = Array.from({ length: count }, (_, index) => `SYN${String(6000 + index)}`);
  await w.capture(
    "sbi-securities",
    codes.map((code) => ({
      account: "sbi-securities:domestic",
      code,
      name: `Synthetic ${code}`,
      market: "TKY",
      currency: "JPY",
    })),
  );
  await w.capture(
    BROKER_B,
    codes.map((code) => ({
      account: "synthetic-broker-b:custody",
      code,
      name: `Other ${code}`,
      currency: "JPY",
      extra: { country: "JP" },
    })),
  );
  return w;
}

beforeAll(() => {
  stubDatabase().close();
}, 60_000);

describe("the account candidate review beside its pre-S6 text", () => {
  test("the synthetic world: every view, filter, offset and budget", async () => {
    const counts = tally();
    await accountsOn(accountWorld(), [null, "sa-direct-ordinary", "sa-mf-a", "sa-nothing"], counts);
    expect(counts.compared).toBe(5 * 4 * OFFSETS.length * MAX_ROWS.length);
    expect(counts.refused).toBeGreaterThan(0);
  }, 120_000);

  test("scaled and random stores reach every stop: offered, withheld and last", async () => {
    const counts = tally();
    for (const seed of [1, 2, 3, 4]) {
      const { store, filters } = randomAccountStore(seed);
      await accountsOn(store, [null, ...filters], counts);
    }
    expect(counts.withheld).toBeGreaterThan(0);
    expect(counts.offered).toBeGreaterThan(0);
    expect(counts.last).toBeGreaterThan(0);
  }, 300_000);
});

describe("the instrument candidate review beside its pre-S6 text", () => {
  test("the synthetic worlds: every view, filter, offset and budget", async () => {
    const counts = tally();
    const w = await instrumentWorld();
    const identifier = (await legacyReviewInstrumentCandidates({
      grant: grant(1000),
      sql: w.sql,
      request: { view: "open", offset: 0, identifierId: null },
    })) as { ok: true; review: { identifiers: { identifierId: string }[] } };
    const named = identifier.review.identifiers[0]?.identifierId ?? null;
    await instrumentsOn(w, [null, named, "identifier-nothing"], counts);
    const held = await heldWorld();
    await instrumentsOn(held.w, [null], counts);
    expect(counts.refused).toBeGreaterThan(0);
  }, 300_000);

  test("scaled stores of 55 and 120 candidates reach every stop", async () => {
    const counts = tally();
    for (const count of [55, 120]) await instrumentsOn(await pairs(count), [null], counts);
    expect(counts.withheld).toBeGreaterThan(0);
    expect(counts.offered).toBeGreaterThan(0);
    expect(counts.last).toBeGreaterThan(0);
  }, 300_000);
});
