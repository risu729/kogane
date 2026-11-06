// Account correspondence candidates (src/account-candidates.ts, ADR 0077).
// Every producer, connection key, source account id and label here is
// synthetic; the connection keys only mirror the shape of a MoneyForward
// account identity (`moneyforward-account-v2-<64 hex>`).
import { describe, expect, test } from "bun:test";
import {
  ACCOUNT_CANDIDATE_POLICY,
  ACCOUNT_CONNECTION_REVIEW_LIMIT,
  ACCOUNT_RELATION_LIMIT,
  AccountCandidateLimitError,
  accountCandidates,
  AGGREGATOR_ACCOUNT_LIMIT,
  connectionRef,
  type AccountCandidate,
  type AccountCandidateInput,
  type AccountRelationFact,
  type AggregatorAccountFact,
  type ConnectionReviewFact,
} from "../src/account-candidates.ts";

const key = (digit: string): string => `moneyforward-account-v2-${digit.repeat(64)}`;
const KEY_A = key("a");
const KEY_B = key("b");
const MF_IMPORTER = "synthetic-mf-importer";
const MF_COLLECTOR = "synthetic-mf-collector";
const DIRECT = "synthetic-direct";

function review(overrides: Partial<ConnectionReviewFact> = {}): ConnectionReviewFact {
  return {
    producerId: MF_COLLECTOR,
    connectionKey: KEY_A,
    revision: 1,
    status: "confirmed",
    evidenceEligible: true,
    label: "Synthetic bank (aggregator)",
    relatedSourceId: "synthetic-bank",
    directProducerId: DIRECT,
    directSourceAccountIds: ["sa-direct-ordinary"],
    artifactIds: [11, 12, 13],
    ...overrides,
  };
}

function aggregator(id: string, connectionKey: string | null, producerId = MF_COLLECTOR) {
  return { sourceAccountId: id, producerId, connectionKey } satisfies AggregatorAccountFact;
}

function relation(
  kind: AccountRelationFact["kind"],
  fromRef: string,
  toRef: string,
  status: AccountRelationFact["status"],
): AccountRelationFact {
  return { kind, fromRef, toRef, status };
}

function run(input: Partial<AccountCandidateInput>) {
  return accountCandidates({ reviews: [], aggregatorAccounts: [], relations: [], ...input });
}

function pair(set: ReturnType<typeof run>, direct: string, producer = MF_COLLECTOR, k = KEY_A) {
  const found = set.candidates.find(
    (candidate) =>
      candidate.directSourceAccountId === direct &&
      candidate.connectionRef === connectionRef(producer, k),
  );
  if (!found) throw new Error(`no candidate for ${direct}`);
  return found;
}

describe("candidates from a confirmed connection review", () => {
  test("one direct account: a proposed connection_contains pair with both commands, no same-account candidate", () => {
    const set = run({
      reviews: [review()],
      aggregatorAccounts: [aggregator("sa-mf-collector", KEY_A)],
    });
    expect(set.policy).toBe(ACCOUNT_CANDIDATE_POLICY);
    const candidate = pair(set, "sa-direct-ordinary");
    const ref = `connection:${MF_COLLECTOR}/${KEY_A}`;
    expect(candidate).toMatchObject({
      candidateId: `account-candidate:${ref}|source_account:sa-direct-ordinary`,
      connectionRef: ref,
      relation: "connection_contains",
      evidence: ["connection-review-confirmed"],
      evidenceEligible: true,
      status: "proposed",
      hold: null,
      aggregatorSourceAccountIds: ["sa-mf-collector"],
      sameAccount: {
        proposed: false,
        reasons: ["aggregator-account-connection-scoped"],
        recorded: [],
      },
    });
    const evidenceRefs = [
      `account-connection-review:${MF_COLLECTOR}/${KEY_A}@1`,
      "fetch_artifact:11",
      "fetch_artifact:12",
      "fetch_artifact:13",
    ];
    expect(candidate.evidenceRefs).toEqual(evidenceRefs);
    const payload = {
      relationKind: "connection_contains" as const,
      fromRef: ref,
      toRef: "source_account:sa-direct-ordinary",
      validFrom: null,
      validTo: null,
      evidenceRefs,
    };
    expect(candidate.commands).toEqual({
      accept: { kind: "relation.accept", payload },
      reject: { kind: "relation.reject", payload },
    });
    expect(set.summary).toEqual({
      connections: { confirmed: 1, unresolved: 0, "evidence-ineligible": 0 },
      candidates: { proposed: 1, accepted: 0, rejected: 0 },
      held: 0,
      unreviewedAggregatorAccounts: 0,
      sameAccountProposed: 0,
      sameAccountRecorded: 0,
    });
  });

  test("one aggregator account matching two direct accounts chooses neither as the same account", () => {
    // The aggregator lists two products under one registered connection
    // (an ordinary and a time deposit, say); the direct overview lists two
    // leaf accounts. Containment is proposed for each, equivalence for none.
    const set = run({
      reviews: [review({ directSourceAccountIds: ["sa-direct-time", "sa-direct-ordinary"] })],
      aggregatorAccounts: [aggregator("sa-mf-collector", KEY_A)],
    });
    expect(set.candidates.map((candidate) => candidate.directSourceAccountId)).toEqual([
      "sa-direct-ordinary",
      "sa-direct-time",
    ]);
    for (const candidate of set.candidates) {
      expect(candidate.status).toBe("proposed");
      expect(candidate.hold).toBeNull();
      expect(candidate.sameAccount).toEqual({
        proposed: false,
        reasons: ["aggregator-account-connection-scoped", "several-direct-accounts"],
        recorded: [],
      });
    }
    expect(set.summary.sameAccountProposed).toBe(0);
  });

  test("a direct account claimed by two aggregator connections (a colliding displayed number) is held on both", () => {
    // Two registrations whose displayed branch and number both equal one
    // direct reference: the shared fragment cannot say which one it is.
    const set = run({
      reviews: [review(), review({ connectionKey: KEY_B, artifactIds: [21, 22, 23] })],
      aggregatorAccounts: [aggregator("sa-mf-a", KEY_A), aggregator("sa-mf-b", KEY_B)],
    });
    for (const k of [KEY_A, KEY_B]) {
      const candidate = pair(set, "sa-direct-ordinary", MF_COLLECTOR, k);
      expect(candidate.hold).toBe("direct-account-in-several-connections");
      expect(candidate.commands.accept).toBeNull();
      expect(candidate.commands.reject?.kind).toBe("relation.reject");
    }
    expect(set.summary.held).toBe(2);
  });

  test("two producers' reviews of one identity value are one connection, not a collision", () => {
    const set = run({
      reviews: [review(), review({ producerId: MF_IMPORTER })],
      aggregatorAccounts: [
        aggregator("sa-mf-collector", KEY_A),
        aggregator("sa-mf-importer", KEY_A, MF_IMPORTER),
      ],
    });
    expect(set.candidates).toHaveLength(2);
    for (const candidate of set.candidates) {
      expect(candidate.hold).toBeNull();
      expect(candidate.aggregatorSourceAccountIds).toEqual(["sa-mf-collector", "sa-mf-importer"]);
    }
  });

  test("an ineligible review holds its pairs and claims nothing against another connection", () => {
    const set = run({
      reviews: [
        review({ evidenceEligible: false }),
        review({ connectionKey: KEY_B, artifactIds: [21, 22, 23] }),
      ],
    });
    expect(pair(set, "sa-direct-ordinary").hold).toBe("evidence-ineligible");
    expect(pair(set, "sa-direct-ordinary").commands.accept).toBeNull();
    expect(pair(set, "sa-direct-ordinary", MF_COLLECTOR, KEY_B).hold).toBeNull();
    expect(set.connections.map((entry) => entry.state)).toEqual([
      "evidence-ineligible",
      "confirmed",
    ]);
  });
});

describe("names are never evidence", () => {
  test("an unresolved review whose label equals a direct account's label proposes nothing", () => {
    const set = run({
      reviews: [
        review({
          status: "unresolved",
          label: "Synthetic bank ordinary",
          relatedSourceId: null,
          directProducerId: null,
          directSourceAccountIds: [],
          artifactIds: [11],
        }),
      ],
      aggregatorAccounts: [aggregator("sa-mf-collector", KEY_A)],
    });
    expect(set.candidates).toEqual([]);
    expect(set.connections).toMatchObject([
      {
        state: "unresolved",
        directSourceAccountIds: [],
        aggregatorSourceAccountIds: ["sa-mf-collector"],
      },
    ]);
  });

  test("an aggregator account without a review is listed, never paired, whatever it is called", () => {
    const set = run({
      aggregatorAccounts: [aggregator("sa-mf-unreviewed", KEY_B), aggregator("sa-mf-odd", null)],
    });
    expect(set.candidates).toEqual([]);
    expect(set.unreviewed).toEqual([
      {
        sourceAccountId: "sa-mf-odd",
        producerId: MF_COLLECTOR,
        connectionKey: null,
        reason: "reference-unrecognized",
      },
      {
        sourceAccountId: "sa-mf-unreviewed",
        producerId: MF_COLLECTOR,
        connectionKey: KEY_B,
        reason: "no-connection-review",
      },
    ]);
  });
});

describe("status comes from stored relations only", () => {
  const ref = connectionRef(MF_COLLECTOR, KEY_A);
  const to = "source_account:sa-direct-ordinary";
  const statusOf = (stored: AccountRelationFact["status"]): AccountCandidate =>
    pair(
      run({ reviews: [review()], relations: [relation("connection_contains", ref, to, stored)] }),
      "sa-direct-ordinary",
    );

  test("accepted: withdrawing is offered, accepting again is not", () => {
    const candidate = statusOf("accepted");
    expect(candidate.status).toBe("accepted");
    expect(candidate.commands.accept).toBeNull();
    expect(candidate.commands.reject?.kind).toBe("relation.reject");
  });
  test("rejected: accepting is offered, rejecting again is not", () => {
    const candidate = statusOf("rejected");
    expect(candidate.status).toBe("rejected");
    expect(candidate.commands.reject).toBeNull();
    expect(candidate.commands.accept?.kind).toBe("relation.accept");
  });
  test("released and proposed relations leave the pair proposed", () => {
    expect(statusOf("released").status).toBe("proposed");
    expect(statusOf("proposed").status).toBe("proposed");
  });
  test("a relation from another producer's connection reference does not decide this pair", () => {
    const set = run({
      reviews: [review()],
      relations: [
        relation("connection_contains", connectionRef(MF_IMPORTER, KEY_A), to, "accepted"),
      ],
    });
    expect(pair(set, "sa-direct-ordinary").status).toBe("proposed");
  });
  test("a stored same_account relation is reported in either orientation and never proposed", () => {
    const set = run({
      reviews: [review()],
      aggregatorAccounts: [aggregator("sa-mf-collector", KEY_A)],
      relations: [
        relation("same_account", to, "source_account:sa-mf-collector", "rejected"),
        relation(
          "same_account",
          "source_account:sa-mf-collector",
          "source_account:other",
          "accepted",
        ),
      ],
    });
    const candidate = pair(set, "sa-direct-ordinary");
    expect(candidate.sameAccount).toEqual({
      proposed: false,
      reasons: ["aggregator-account-connection-scoped"],
      recorded: [{ fromRef: to, toRef: "source_account:sa-mf-collector", status: "rejected" }],
    });
    expect(set.summary.sameAccountRecorded).toBe(1);
    expect(set.summary.sameAccountProposed).toBe(0);
  });
});

describe("bounds and determinism", () => {
  test("past each bound the answer is refused whole", () => {
    const reviews = Array.from({ length: ACCOUNT_CONNECTION_REVIEW_LIMIT + 1 }, (_, i) =>
      review({ connectionKey: `synthetic-key-${String(i)}` }),
    );
    expect(() => run({ reviews })).toThrow(AccountCandidateLimitError);
    expect(() =>
      run({
        aggregatorAccounts: Array.from({ length: AGGREGATOR_ACCOUNT_LIMIT + 1 }, (_, i) =>
          aggregator(`sa-${String(i)}`, KEY_A),
        ),
      }),
    ).toThrow(AccountCandidateLimitError);
    expect(() =>
      run({
        relations: Array.from({ length: ACCOUNT_RELATION_LIMIT + 1 }, (_, i) =>
          relation("same_account", `source_account:a${String(i)}`, "source_account:b", "accepted"),
        ),
      }),
    ).toThrow(AccountCandidateLimitError);
    expect(() => run({ reviews: [review(), review()] })).toThrow("duplicate");
  });

  test("the answer does not depend on input order", () => {
    const input: AccountCandidateInput = {
      reviews: [
        review({ directSourceAccountIds: ["sa-2", "sa-1"] }),
        review({ connectionKey: KEY_B, directSourceAccountIds: ["sa-1"] }),
        review({ producerId: MF_IMPORTER, status: "unresolved", directSourceAccountIds: [] }),
      ],
      aggregatorAccounts: [aggregator("sa-mf-b", KEY_B), aggregator("sa-mf-a", KEY_A)],
      relations: [
        relation(
          "connection_contains",
          connectionRef(MF_COLLECTOR, KEY_A),
          "source_account:sa-2",
          "accepted",
        ),
      ],
    };
    const reversed: AccountCandidateInput = {
      reviews: [...input.reviews].reverse(),
      aggregatorAccounts: [...input.aggregatorAccounts].reverse(),
      relations: [...input.relations].reverse(),
    };
    expect(accountCandidates(reversed)).toEqual(accountCandidates(input));
  });
});
