// Property tests of the disjointness policy's entity rule (ADR 0001's
// amendment of 2026-11-20) over random relation graphs. Every scope, entity
// and amount is synthetic.
//
// The model: a scope is a non-empty set. An accepted `same` makes two scopes
// equal, an accepted containment makes its part a subset of its whole, and
// two references the current mapping gives one account entity are read as
// equal (they may be one measurement). Two scopes are then forced to overlap
// exactly when some scope lies at or below both: the first test checks that
// claim against every set assignment of small graphs, `disjoint` and proper
// containment included.
//
// The rule: the policy declares no pair disjoint that is forced to overlap
// with a mapped scope on the way (some walk from the common lower bound up to
// one of the two passes a scope the mapping maps to an entity). A pair forced
// to overlap with no mapped scope on any way is the decision-only nesting v2
// left to the policy, and keeps v2's answer. A pair a decision relates
// directly is read against its own entities. The oracle here walks scopes
// and their flags edge by edge; the build uses classes, lower sets and bits,
// so the two share no code.
import { describe, expect, test } from "bun:test";
import {
  buildBalanceProjection,
  type DerivedScopeRelation,
  type ProjectionBuild,
  type ProjectionCandidate,
} from "../src/balance-projection";
import { AUTHORITY_RANKS } from "../src/authority";
import { legacyV2Adoption } from "./balance-projection-policy-v2-legacy";

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("forced overlap is a common lower bound", () => {
  // Scopes 0..n-1 over n atoms: if no scope lies below both of a pair, the
  // assignment "every scope is the set of scopes at or below it" keeps them
  // apart, so n atoms are enough to find a separating assignment.
  type Kind = "same" | "subset" | "proper" | "disjoint";
  test("on every non-empty set assignment of small graphs", () => {
    const failures: string[] = [];
    let compared = 0;
    for (let seed = 1; seed <= 600; seed += 1) {
      const next = random(seed);
      const size = 2 + Math.floor(next() * 3);
      const relations: { left: number; right: number; kind: Kind }[] = [];
      for (let index = Math.floor(next() * (size + 2)); index > 0; index -= 1) {
        const [left, right] = [Math.floor(next() * size), Math.floor(next() * size)];
        const roll = next();
        if (left !== right)
          relations.push({
            left,
            right,
            kind:
              roll < 0.25 ? "same" : roll < 0.6 ? "subset" : roll < 0.75 ? "proper" : "disjoint",
          });
      }
      const below = Array.from({ length: size }, (_, row) =>
        Array.from({ length: size }, (_, column) => row === column),
      );
      for (const { left, right, kind } of relations) {
        if (kind === "same" || kind === "subset" || kind === "proper") below[left]![right] = true;
        if (kind === "same") below[right]![left] = true;
      }
      for (let middle = 0; middle < size; middle += 1)
        for (let row = 0; row < size; row += 1)
          for (let column = 0; column < size; column += 1)
            if (below[row]![middle] && below[middle]![column]) below[row]![column] = true;
      const commonLowerBound = (a: number, b: number) =>
        below.some((row) => row[a] === true && row[b] === true);
      const separable = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
      let consistent = false;
      const sets = new Array<number>(size).fill(1);
      const assign = (scope: number): void => {
        if (scope === size) {
          for (const { left, right, kind } of relations) {
            const [a, b] = [sets[left]!, sets[right]!];
            if (kind === "same" && a !== b) return;
            if ((kind === "subset" || kind === "proper") && (a & ~b) !== 0) return;
            if (kind === "proper" && a === b) return;
            if (kind === "disjoint" && (a & b) !== 0) return;
          }
          consistent = true;
          for (let a = 0; a < size; a += 1)
            for (let b = 0; b < size; b += 1)
              if ((sets[a]! & sets[b]!) === 0) separable[a]![b] = true;
          return;
        }
        for (let set = 1; set < 1 << size; set += 1) {
          sets[scope] = set;
          assign(scope + 1);
        }
      };
      assign(0);
      if (!consistent) continue;
      for (let a = 0; a < size; a += 1)
        for (let b = a + 1; b < size; b += 1) {
          compared += 1;
          if (commonLowerBound(a, b) === separable[a]![b])
            failures.push(`seed ${String(seed)}: ${String(a)} ${String(b)}`);
        }
    }
    expect(failures.slice(0, 10)).toEqual([]);
    expect(compared).toBeGreaterThan(1000);
  });
});

interface Graph {
  candidates: ProjectionCandidate[];
  relations: DerivedScopeRelation[];
}

const SOURCES = [
  { sourceId: "smbc-bank", parser: "smbc-direct-balance" },
  { sourceId: "sbi-shinsei-bank", parser: "sbi-shinsei-top-balances-and-activity" },
] as const;
const STATUSES = ["identified", "identified", "provider-local", "aggregate"] as const;

function candidate(
  scopeKey: string,
  subject: string,
  instrument: string,
  entity: string | null,
  next: () => number,
): ProjectionCandidate {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  const source = pick(SOURCES);
  const amount = pick(["1000", "2000", "3000"]);
  return {
    scopeKey,
    subjectScopeKey: subject,
    subjectStatus: pick(STATUSES),
    observationId: 1,
    parseRunId: 1,
    fetchArtifactId: 1,
    sourceId: source.sourceId,
    sourceAccount: `synthetic:${scopeKey}`,
    parser: `${source.parser}@1`,
    parserName: source.parser,
    metric: "account_balance",
    instrument,
    amountMinor: amount,
    amountText: null,
    asOf: "2026-09-08",
    observedAt: "2026-09-08T07:00:00Z",
    normalized: {
      policyVersion: "decimal-v1",
      status: "exact",
      coefficient: amount,
      scale: 0,
      basis: "minor_units",
    },
    memberEvidence: [],
    witnessConflict: false,
    coverage: { completeness: "complete", reasonCode: null },
    freshness: { state: "current", reasonCode: null },
    authorityRank: next() < 0.6 ? AUTHORITY_RANKS.direct : AUTHORITY_RANKS.aggregator,
    measureView: "balances",
    latestInGroup: true,
    accountEntity: entity,
  };
}

/**
 * Up to nine subjects in the yen target, some with a second witness mapped
 * elsewhere or a dollar candidate; scopes measured only in dollars; scopes
 * with no candidate at all; and accepted `same` and containment decisions
 * between any of them.
 */
function graph(seed: number): Graph {
  const next = random(seed);
  const size = 2 + Math.floor(next() * 8);
  const pool = 1 + Math.floor(next() * 4);
  const entity = () =>
    next() < 0.35 ? null : `account:synthetic:${String(Math.floor(next() * pool))}`;
  const candidates: ProjectionCandidate[] = [];
  const scopes: string[] = [];
  for (let index = 0; index < size; index += 1) {
    const subject = `source_account:synthetic:${String(index)}`;
    const own = entity();
    scopes.push(subject);
    candidates.push(candidate(`m-${String(index)}`, subject, "JPY", own, next));
    if (next() < 0.1)
      candidates.push(candidate(`m-${String(index)}-witness`, subject, "JPY", entity(), next));
    if (next() < 0.2)
      candidates.push(candidate(`m-${String(index)}-usd`, subject, "USD", own, next));
  }
  for (let index = Math.floor(next() * 3); index > 0; index -= 1) {
    const subject = `source_account:synthetic:usd-${String(index)}`;
    scopes.push(subject);
    candidates.push(candidate(`m-usd-${String(index)}`, subject, "USD", entity(), next));
  }
  for (let index = Math.floor(next() * 3); index > 0; index -= 1)
    scopes.push(`source_account:synthetic:outside-${String(index)}`);
  const relations: DerivedScopeRelation[] = [];
  for (let index = Math.floor(next() * (scopes.length + 2)); index > 0; index -= 1) {
    const from = scopes[Math.floor(next() * scopes.length)]!;
    const to = scopes[Math.floor(next() * scopes.length)]!;
    if (from === to) continue;
    relations.push({
      fromScopeKey: from,
      toScopeKey: to,
      relation: next() < 0.35 ? "same" : "subset",
      source: "decision",
      decisionRevisionId: `rev:synthetic:${String(index)}`,
      release: "scope-relations-v1",
    });
  }
  return { candidates, relations };
}

/**
 * The oracle. From each scope it walks up (part to whole, and both ways
 * along `same` and between two references of one entity), carrying whether
 * the walk has passed a mapped scope. Two scopes are forced to overlap when
 * one start reaches both; the mapping takes part when, from such a start, a
 * walk to one of them passed a mapped scope.
 */
function oracle({ candidates, relations }: Graph) {
  const entities = new Map<string, Set<string>>();
  for (const entry of candidates)
    if (entry.accountEntity !== null)
      entities.set(
        entry.subjectScopeKey,
        new Set([...(entities.get(entry.subjectScopeKey) ?? []), entry.accountEntity]),
      );
  const scopes = new Set([
    ...candidates.map((entry) => entry.subjectScopeKey),
    ...relations.flatMap((entry) => [entry.fromScopeKey, entry.toScopeKey]),
  ]);
  const up = new Map<string, string[]>();
  const step = (from: string, to: string) => up.set(from, [...(up.get(from) ?? []), to]);
  for (const entry of relations) {
    step(entry.fromScopeKey, entry.toScopeKey);
    if (entry.relation === "same") step(entry.toScopeKey, entry.fromScopeKey);
  }
  for (const left of scopes)
    for (const right of scopes)
      if (
        left !== right &&
        [...(entities.get(left) ?? [])].some((e) => entities.get(right)?.has(e))
      )
        step(left, right);
  const mapped = (scope: string) => (entities.get(scope)?.size ?? 0) > 0;
  const walks = new Map<string, Map<string, { flagged: boolean }>>();
  for (const start of scopes) {
    const reached = new Map<string, { flagged: boolean }>();
    const queue: [string, boolean][] = [[start, mapped(start)]];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const [scope, flagged] = queue.shift()!;
      const key = `${scope} ${String(flagged)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      reached.set(scope, { flagged: flagged || (reached.get(scope)?.flagged ?? false) });
      for (const to of up.get(scope) ?? []) queue.push([to, flagged || mapped(to)]);
    }
    walks.set(start, reached);
  }
  const forced = (a: string, b: string) =>
    [...walks.values()].some((reached) => reached.has(a) && reached.has(b));
  const mappingTakesPart = (a: string, b: string) =>
    [...walks.values()].some((reached) => {
      const [left, right] = [reached.get(a), reached.get(b)];
      return left !== undefined && right !== undefined && (left.flagged || right.flagged);
    });
  const related = (a: string, b: string) =>
    relations.some(
      (entry) =>
        (entry.fromScopeKey === a && entry.toScopeKey === b) ||
        (entry.fromScopeKey === b && entry.toScopeKey === a),
    );
  const ownShared = (a: string, b: string) =>
    [...(entities.get(a) ?? [])].some((entity) => entities.get(b)?.has(entity));
  return {
    forced,
    mappingTakesPart,
    withheld: (a: string, b: string) => (related(a, b) ? ownShared(a, b) : mappingTakesPart(a, b)),
  };
}

const policyPairs = (build: ProjectionBuild): Set<string> =>
  new Set(
    build.relations
      .filter((entry) => entry.source === "policy")
      .map((entry) => JSON.stringify([entry.fromScopeKey, entry.toScopeKey].sort())),
  );

const outcomes = (build: ProjectionBuild) =>
  new Map(
    build.rows.map((row) => [row.scopeKey, { state: row.state, reasonCode: row.reasonCode }]),
  );

const RUNS = 3000;

describe("the policy's entity rule over random decided graphs", () => {
  test("the policy withholds exactly the pairs the oracle withholds from v2's", () => {
    const misses: string[] = [];
    const falsePositives: string[] = [];
    let withheld = 0;
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const input = graph(seed);
      const actual = policyPairs(buildBalanceProjection(input.candidates, input.relations));
      const { withheld: shouldWithhold } = oracle(input);
      for (const pair of legacyV2Adoption(input.candidates, input.relations).policyPairs) {
        const [left, right] = JSON.parse(pair) as [string, string];
        const expected = !shouldWithhold(left, right);
        if (!expected) withheld += 1;
        if (expected && !actual.has(pair)) falsePositives.push(`seed ${String(seed)}: ${pair}`);
        if (!expected && actual.has(pair)) misses.push(`seed ${String(seed)}: ${pair}`);
        actual.delete(pair);
      }
      for (const pair of actual) misses.push(`seed ${String(seed)}: not in v2 ${pair}`);
    }
    expect(misses.slice(0, 10)).toEqual([]);
    expect(falsePositives.slice(0, 10)).toEqual([]);
    expect(withheld).toBeGreaterThan(RUNS);
  });

  test("no two adopted candidates overlap, but where v2 adopted both with no mapped scope on the way", () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const input = graph(seed);
      const { forced, mappingTakesPart } = oracle(input);
      const v2 = legacyV2Adoption(input.candidates, input.relations).outcomes;
      const adopted = buildBalanceProjection(input.candidates, input.relations).rows.filter(
        (row) => row.state === "adopted",
      );
      for (const [index, left] of adopted.entries())
        for (const right of adopted.slice(index + 1)) {
          const [l, r] = [left.subjectScopeKey, right.subjectScopeKey];
          if (left.unitRef !== right.unitRef || l === r || !forced(l, r)) continue;
          const olderLimit =
            !mappingTakesPart(l, r) &&
            v2.get(left.scopeKey)?.state === "adopted" &&
            v2.get(right.scopeKey)?.state === "adopted";
          if (!olderLimit)
            failures.push(`seed ${String(seed)}: ${left.scopeKey} ${right.scopeKey}`);
        }
    }
    expect(failures.slice(0, 10)).toEqual([]);
  });

  test("without entities the build equals v2, row by row", () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const input = graph(seed);
      for (const candidates of [
        input.candidates.map((entry) => ({ ...entry, accountEntity: null })),
        // An input captured before the field existed.
        input.candidates.map((entry) => {
          const { accountEntity: _omitted, ...rest } = entry;
          return rest as ProjectionCandidate;
        }),
      ]) {
        const build = buildBalanceProjection(candidates, input.relations);
        const v2 = legacyV2Adoption(candidates, input.relations);
        if (
          JSON.stringify([...policyPairs(build)].sort()) !==
          JSON.stringify([...v2.policyPairs].sort())
        )
          failures.push(`seed ${String(seed)}: policy`);
        const rows = outcomes(build);
        for (const [scopeKey, outcome] of v2.outcomes)
          if (JSON.stringify(rows.get(scopeKey)) !== JSON.stringify(outcome))
            failures.push(`seed ${String(seed)}: ${scopeKey}`);
      }
    }
    expect(failures.slice(0, 10)).toEqual([]);
  });

  test("with entities, a target no mapped scope reaches builds as v2", () => {
    // Entities only on scopes no decision touches and no other reference
    // shares: the mapping takes part in no forced overlap, so every row
    // equals v2's.
    const failures: string[] = [];
    let compared = 0;
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const input = graph(seed);
      const decided = new Set(
        input.relations.flatMap((entry) => [entry.fromScopeKey, entry.toScopeKey]),
      );
      const holders = new Map<string, Set<string>>();
      for (const entry of input.candidates)
        if (entry.accountEntity !== null)
          holders.set(
            entry.accountEntity,
            new Set([...(holders.get(entry.accountEntity) ?? []), entry.subjectScopeKey]),
          );
      if (
        input.candidates.some(
          (entry) =>
            entry.accountEntity !== null &&
            (decided.has(entry.subjectScopeKey) || holders.get(entry.accountEntity)!.size > 1),
        )
      )
        continue;
      compared += 1;
      const rows = outcomes(buildBalanceProjection(input.candidates, input.relations));
      for (const [scopeKey, outcome] of legacyV2Adoption(input.candidates, input.relations)
        .outcomes)
        if (JSON.stringify(rows.get(scopeKey)) !== JSON.stringify(outcome))
          failures.push(`seed ${String(seed)}: ${scopeKey}`);
    }
    expect(failures.slice(0, 10)).toEqual([]);
    expect(compared).toBeGreaterThan(100);
  });
});
