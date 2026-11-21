// A property test of the disjointness policy's entity rule over random small
// relation graphs: accepted `same` and containment decisions, references that
// share an account entity or keep their own, at two sources and two authority
// ranks. Every scope, entity and amount is synthetic.
//
// The oracle walks scopes, transitively: a scope holds the money of every
// scope a decision makes the same as it or a part of it, and lies inside
// every scope it is decided the same as or a part of; two references of one
// entity may be one measurement, so the walk passes between them too. Two
// adopted candidates count one entity twice when an entity one of them holds
// is held by, or holds, the other. Two references inside one entity (two
// pockets of one account) do not overlap by that alone.
//
// Two adopted scopes that decisions alone make one measurement or nest
// through a scope outside the target, with no entity on the way, are a limit
// of the disjointness policy that predates the entity rule (it reads no
// decision but the pair's own): the first property only checks that the
// entity rule never adds one. A common part no entity marks is the same
// limit (ADR 0001), and this oracle does not count it as shared either.
import { describe, expect, test } from "bun:test";
import {
  buildBalanceProjection,
  type DerivedScopeRelation,
  type ProjectionCandidate,
} from "../src/balance-projection";
import { AUTHORITY_RANKS } from "../src/authority";

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

interface Graph {
  candidates: ProjectionCandidate[];
  relations: DerivedScopeRelation[];
}

const SOURCES = [
  { sourceId: "smbc-bank", parser: "smbc-direct-balance" },
  { sourceId: "sbi-shinsei-bank", parser: "sbi-shinsei-top-balances-and-activity" },
] as const;
const STATUSES = ["identified", "identified", "provider-local", "aggregate"] as const;

function candidate(index: number, next: () => number, entities: number): ProjectionCandidate {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  const source = pick(SOURCES);
  const amount = pick(["1000", "2000", "3000"]);
  const entity = Math.floor(next() * (entities + 1));
  return {
    scopeKey: `m-${String(index)}`,
    subjectScopeKey: `source_account:synthetic:${String(index)}`,
    subjectStatus: pick(STATUSES),
    observationId: index + 1,
    parseRunId: 1,
    fetchArtifactId: 1,
    sourceId: source.sourceId,
    sourceAccount: `synthetic:${String(index)}`,
    parser: `${source.parser}@1`,
    parserName: source.parser,
    metric: "account_balance",
    instrument: "JPY",
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
    accountEntity: entity === entities ? null : `account:synthetic:${String(entity)}`,
  };
}

/** Scopes outside the target (no candidate) can sit on a decided chain. */
function graph(seed: number): Graph {
  const next = random(seed);
  const size = 2 + Math.floor(next() * 5);
  const outsiders = Math.floor(next() * 3);
  const candidates = Array.from({ length: size }, (_, index) => candidate(index, next, 3));
  const scopes = [
    ...candidates.map((entry) => entry.subjectScopeKey),
    ...Array.from(
      { length: outsiders },
      (_, index) => `source_account:synthetic:outside-${String(index)}`,
    ),
  ];
  const relations: DerivedScopeRelation[] = [];
  const count = Math.floor(next() * (scopes.length + 1));
  for (let index = 0; index < count; index += 1) {
    const from = scopes[Math.floor(next() * scopes.length)]!;
    const to = scopes[Math.floor(next() * scopes.length)]!;
    if (from === to) continue;
    relations.push({
      fromScopeKey: from,
      toScopeKey: to,
      relation: next() < 0.4 ? "same" : "subset",
      source: "decision",
      decisionRevisionId: `rev:synthetic:${String(index)}`,
      release: "scope-relations-v1",
    });
  }
  return { candidates, relations };
}

/**
 * The scopes each scope holds (`down`) and lies inside (`up`), itself
 * included. With `candidates`, two references of one entity are read as one
 * (they may be one measurement), so a chain may pass through an entity.
 */
function closures(
  relations: readonly DerivedScopeRelation[],
  candidates: readonly ProjectionCandidate[] = [],
) {
  const edges = (direction: "down" | "up") => {
    const map = new Map<string, Set<string>>();
    const add = (from: string, to: string) => {
      const set = map.get(from) ?? new Set<string>();
      set.add(to);
      map.set(from, set);
    };
    for (const relation of relations) {
      if (relation.relation === "same") {
        add(relation.fromScopeKey, relation.toScopeKey);
        add(relation.toScopeKey, relation.fromScopeKey);
      } else if (relation.relation === "subset") {
        // fromScopeKey ⊂ toScopeKey: the whole holds the part.
        if (direction === "down") add(relation.toScopeKey, relation.fromScopeKey);
        else add(relation.fromScopeKey, relation.toScopeKey);
      }
    }
    for (const left of candidates)
      for (const right of candidates)
        if (left.accountEntity !== null && left.accountEntity === right.accountEntity)
          add(left.subjectScopeKey, right.subjectScopeKey);
    return (start: string): Set<string> => {
      const seen = new Set([start]);
      const stack = [start];
      while (stack.length > 0)
        for (const next of map.get(stack.pop()!) ?? [])
          if (!seen.has(next)) {
            seen.add(next);
            stack.push(next);
          }
      return seen;
    };
  };
  return { down: edges("down"), up: edges("up") };
}

function entitiesOf(scopes: Set<string>, candidates: readonly ProjectionCandidate[]): Set<string> {
  const entities = new Set<string>();
  for (const entry of candidates)
    if (scopes.has(entry.subjectScopeKey) && entry.accountEntity !== null)
      entities.add(entry.accountEntity);
  return entities;
}

const meets = (left: Set<string>, right: Set<string>): boolean =>
  [...left].some((entity) => right.has(entity));

/** Whether the decided closures of two scopes put one entity on both sides. */
function closureShares(left: string, right: string, { candidates, relations }: Graph): boolean {
  const { down, up } = closures(relations, candidates);
  const [leftDown, rightDown] = [down(left), down(right)].map((scopes) =>
    entitiesOf(scopes, candidates),
  ) as [Set<string>, Set<string>];
  const [leftUp, rightUp] = [up(left), up(right)].map((scopes) =>
    entitiesOf(scopes, candidates),
  ) as [Set<string>, Set<string>];
  return meets(leftDown, rightDown) || meets(leftUp, rightDown) || meets(leftDown, rightUp);
}

/** Whether two scopes are decided the same or one inside the other, transitively. */
function decidedOverlap(left: string, right: string, relations: readonly DerivedScopeRelation[]) {
  const { down } = closures(relations);
  return down(left).has(right) || down(right).has(left);
}

const policyPairs = (build: ReturnType<typeof buildBalanceProjection>): Set<string> =>
  new Set(
    build.relations
      .filter((entry) => entry.source === "policy")
      .map((entry) => JSON.stringify([entry.fromScopeKey, entry.toScopeKey].sort())),
  );

const RUNS = 4000;

describe("the policy's entity rule over random decided graphs", () => {
  test("no adopted set counts one entity twice", () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const input = graph(seed);
      const build = buildBalanceProjection(input.candidates, input.relations);
      const adopted = build.rows.filter((row) => row.state === "adopted");
      const adoptedWithout = new Set(
        buildBalanceProjection(
          input.candidates.map((entry) => ({ ...entry, accountEntity: null })),
          input.relations,
        )
          .rows.filter((row) => row.state === "adopted")
          .map((row) => row.scopeKey),
      );
      for (const [index, left] of adopted.entries())
        for (const right of adopted.slice(index + 1)) {
          const [l, r] = [left.subjectScopeKey, right.subjectScopeKey];
          // A pair decisions alone make one or nest is the older limit (see
          // the top): entities must not add one, so both sides were adopted
          // without them too.
          const failed = decidedOverlap(l, r, input.relations)
            ? !adoptedWithout.has(left.scopeKey) || !adoptedWithout.has(right.scopeKey)
            : closureShares(l, r, input);
          if (failed) failures.push(`seed ${String(seed)}: ${left.scopeKey} and ${right.scopeKey}`);
        }
    }
    expect(failures.slice(0, 10)).toEqual([]);
  });

  test("a pair whose decided closures share no entity keeps the policy's disjointness", () => {
    const failures: string[] = [];
    for (let seed = 1; seed <= RUNS; seed += 1) {
      const input = graph(seed);
      const withEntities = policyPairs(buildBalanceProjection(input.candidates, input.relations));
      // Without entities the policy builds as v2 did.
      const withoutEntities = policyPairs(
        buildBalanceProjection(
          input.candidates.map((entry) => ({ ...entry, accountEntity: null })),
          input.relations,
        ),
      );
      const related = new Set(
        input.relations.map((entry) =>
          JSON.stringify([entry.fromScopeKey, entry.toScopeKey].sort()),
        ),
      );
      for (const pair of withoutEntities) {
        const [left, right] = JSON.parse(pair) as [string, string];
        const shared = related.has(pair)
          ? meets(
              entitiesOf(new Set([left]), input.candidates),
              entitiesOf(new Set([right]), input.candidates),
            )
          : closureShares(left, right, input);
        if (withEntities.has(pair) === shared)
          failures.push(`seed ${String(seed)}: ${pair} shared=${String(shared)}`);
      }
      for (const pair of withEntities)
        if (!withoutEntities.has(pair)) failures.push(`seed ${String(seed)}: new ${pair}`);
    }
    expect(failures.slice(0, 10)).toEqual([]);
  });
});
