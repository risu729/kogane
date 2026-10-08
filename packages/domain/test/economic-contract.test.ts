// The economic consumption contract (src/economic-contract.ts, ADR 0054).
// Every id, key and date here is invented.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  BOOKS,
  IDENTITY_ORIGIN_BASES,
  IDENTITY_REFUSALS,
  admitIdentity,
  aliasClassText,
  validAliasClass,
  validIdentityAdmissionInput,
  ECONOMIC_GUARD_CODES,
  bookClaimsJson,
  commitMembersJson,
  consumptionKeyText,
  economicEventSubject,
  economicGuardCode,
  parseConsumptionKey,
  releasedBookClaims,
  sameBookClaims,
  sortedBookClaims,
  validBookClaimSet,
  validCommitLogRecord,
  validCommitMember,
  validConsumptionKey,
  validEconomicClaimRecord,
  validEventTimeRecord,
  validHeadRef,
  validIdentityPins,
  validKnowledgeCut,
  validLegEffectRecord,
  validRevisionSealRecord,
  type BookClaim,
  type CommitLogRecord,
  type ConsumptionKey,
} from "../src/economic-contract.ts";
import * as domain from "../src/index.ts";

const KEY_A: ConsumptionKey = ["bank-x", "producer-1", "ns-1", "account-1", "row-0001"];
const KEY_B: ConsumptionKey = ["bank-x", "producer-1", null, "account-1", "row-0002"];
const KEY_C: ConsumptionKey = ["card-y", "producer-2", "ns-2", "card:0001", "usage-0001"];
const claim = (book: BookClaim["book"], key: ConsumptionKey): BookClaim => ({ book, key });
const DIGEST = "a".repeat(64);
const ALIAS_A = {
  sourceId: "bank-x",
  components: ["meisai-0001"],
  accountId: "acct-bank-1",
  ruleVersion: "bank-x-identity-v1",
};
const SETTLED = {
  kind: "local-date",
  value: "2026-09-30",
  zone: "Asia/Tokyo",
  basis: "provider",
} as const;

describe("consumption keys", () => {
  test("the text form is SQLite's json_array of the same columns", () => {
    const db = new Database(":memory:");
    for (const key of [KEY_A, KEY_B, KEY_C, ["s", "p", null, "口座/1", 'id "2"'] as const]) {
      const sqlite = db.query("SELECT json_array(?,?,?,?,?) AS k").get(...key) as { k: string };
      expect(consumptionKeyText(key)).toBe(sqlite.k);
      expect(parseConsumptionKey(sqlite.k)).toEqual([...key]);
    }
    db.close();
  });

  test("only five-part keys with an external id are keys, and only in canonical text", () => {
    expect(validConsumptionKey(KEY_A)).toBe(true);
    expect(validConsumptionKey(KEY_B)).toBe(true);
    expect(validConsumptionKey(["bank-x", "producer-1", "ns", "account-1", ""])).toBe(false);
    expect(validConsumptionKey(["bank-x", "producer-1", "ns", "account-1", null])).toBe(false);
    expect(validConsumptionKey(["bank-x", "producer-1", "ns", "account-1"])).toBe(false);
    expect(validConsumptionKey(["bank-x", "p", "ns", "a", "x".repeat(2100)])).toBe(false);
    expect(parseConsumptionKey('["bank-x", "producer-1", "ns-1", "account-1", "row-0001"]')).toBe(
      null,
    );
    expect(parseConsumptionKey("not json")).toBe(null);
  });
});

describe("claim sets", () => {
  test("a set has no repeated (book, key), and the same key in two books is two claims", () => {
    expect(validBookClaimSet([claim("cash-movement", KEY_A), claim("card-usage", KEY_A)])).toBe(
      true,
    );
    expect(validBookClaimSet([claim("cash-movement", KEY_A), claim("cash-movement", KEY_A)])).toBe(
      false,
    );
    expect(validBookClaimSet([{ book: "ledger", key: KEY_A }])).toBe(false);
    expect(validBookClaimSet([{ ...claim("cash-movement", KEY_A), extra: 1 }])).toBe(false);
  });

  test("equality ignores order; the same count with another key is not equal", () => {
    const one = [claim("cash-movement", KEY_A), claim("cash-movement", KEY_B)];
    expect(sameBookClaims(one, [...one].reverse())).toBe(true);
    expect(sameBookClaims(one, [claim("cash-movement", KEY_A), claim("card-usage", KEY_B)])).toBe(
      false,
    );
    expect(sameBookClaims(one, [claim("cash-movement", KEY_A)])).toBe(false);
  });

  test("a correction releases every prior claim it does not restate, nothing else", () => {
    const prior = [claim("cash-movement", KEY_A), claim("cash-movement", KEY_B)];
    expect(releasedBookClaims(prior, [claim("cash-movement", KEY_A)])).toEqual([
      claim("cash-movement", KEY_B),
    ]);
    // A withdrawal restates nothing and releases everything.
    expect(releasedBookClaims(prior, [])).toEqual(sortedBookClaims(prior));
    expect(releasedBookClaims(prior, prior)).toEqual([]);
  });

  test("the stored JSON is a sorted set of [book, key text]", () => {
    const text = bookClaimsJson([claim("cash-movement", KEY_B), claim("card-usage", KEY_C)]);
    expect(JSON.parse(text)).toEqual([
      ["card-usage", consumptionKeyText(KEY_C)],
      ["cash-movement", consumptionKeyText(KEY_B)],
    ]);
    expect(bookClaimsJson([claim("card-usage", KEY_C), claim("cash-movement", KEY_B)])).toBe(text);
  });
});

describe("heads, commits and cuts", () => {
  test("head version 0 means the event never existed, and is never live", () => {
    expect(validHeadRef({ eventId: "event-1", version: 0, live: false })).toBe(true);
    expect(validHeadRef({ eventId: "event-1", version: 0, live: true })).toBe(false);
    expect(validHeadRef({ eventId: "event-1", version: 3, live: true })).toBe(true);
    expect(validHeadRef({ eventId: "event-1", version: -1, live: false })).toBe(false);
    expect(economicEventSubject("event-1")).toBe("economic-event:event-1");
  });

  test("a cut is a commit sequence or an instant inside one core epoch, never both", () => {
    expect(validKnowledgeCut({ coreEpoch: "core-epoch-1", commitSeq: 4 })).toBe(true);
    expect(validKnowledgeCut({ coreEpoch: "core-epoch-1", instant: "2026-10-01T00:00:00Z" })).toBe(
      true,
    );
    expect(validKnowledgeCut({ coreEpoch: "core-epoch-1", commitSeq: 0 })).toBe(false);
    expect(
      validKnowledgeCut({ coreEpoch: "core-epoch-1", commitSeq: 4, instant: "2026-10-01" }),
    ).toBe(false);
    expect(validKnowledgeCut({ commitSeq: 4 })).toBe(false);
  });

  test("a member supersedes distinct, earlier revisions; its own event only below it", () => {
    const member = {
      eventId: "event-x",
      revision: 3,
      supersedes: [
        { eventId: "event-x", revision: 2 },
        { eventId: "event-y", revision: 5 },
      ],
    };
    expect(validCommitMember(member)).toBe(true);
    expect(
      validCommitMember({ ...member, supersedes: [{ eventId: "event-x", revision: 3 }] }),
    ).toBe(false);
    expect(
      validCommitMember({ ...member, supersedes: [member.supersedes[0], member.supersedes[0]] }),
    ).toBe(false);
    expect(commitMembersJson([member])).toBe(
      '[{"eventId":"event-x","revision":3,"supersedes":[["event-x",2],["event-y",5]]}]',
    );
  });

  test("a commit row has exact keys, one member per event, and releases nothing it claims", () => {
    const record: CommitLogRecord = {
      commit: { coreEpoch: "core-epoch-1", commitSeq: 1 },
      decisionRevisionId: "dr-1",
      operationId: null,
      principal: "rule:synthetic-writer-v1",
      payloadDigest: DIGEST,
      kind: "card-settlement.accept",
      members: [{ eventId: "event-x", revision: 1, supersedes: [] }],
      claims: [claim("cash-movement", KEY_A)],
      released: [],
      knownAt: "2026-10-08T00:00:00.000Z",
    };
    expect(validCommitLogRecord(record)).toBe(true);
    expect(validCommitLogRecord({ ...record, extra: true })).toBe(false);
    expect(validCommitLogRecord({ ...record, members: [] })).toBe(false);
    expect(
      validCommitLogRecord({ ...record, members: [...record.members, ...record.members] }),
    ).toBe(false);
    expect(validCommitLogRecord({ ...record, released: record.claims })).toBe(false);
    expect(validCommitLogRecord({ ...record, kind: "Card Settlement" })).toBe(false);
  });
});

describe("child records", () => {
  const ref = { eventId: "event-x", revision: 2 };
  test("claims, times and effects carry exact keys and closed codes", () => {
    expect(
      validEconomicClaimRecord({
        ...ref,
        book: "cash-movement",
        key: KEY_A,
        aliasClass: ALIAS_A,
        identityEpoch: "identity-epoch-1",
        observationId: 1,
        parseRunId: 1,
      }),
    ).toBe(true);
    // A rule writer under retire-before-recognise records no alias class.
    expect(
      validEconomicClaimRecord({
        ...ref,
        book: "card-usage",
        key: KEY_C,
        aliasClass: null,
        identityEpoch: "identity-epoch-1",
        observationId: 1,
        parseRunId: 1,
      }),
    ).toBe(true);
    // An alias class names the key's own source.
    expect(
      validEconomicClaimRecord({
        ...ref,
        book: "card-usage",
        key: KEY_C,
        aliasClass: ALIAS_A,
        identityEpoch: "identity-epoch-1",
        observationId: 1,
        parseRunId: 1,
      }),
    ).toBe(false);
    expect(
      validEconomicClaimRecord({ ...ref, book: "cash-movement", key: KEY_A, observationId: 1 }),
    ).toBe(false);
    expect(
      validEventTimeRecord({
        ...ref,
        role: "settlement",
        time: SETTLED,
      }),
    ).toBe(true);
    expect(
      validEventTimeRecord({
        ...ref,
        role: "effective",
        time: SETTLED,
      }),
    ).toBe(false);
    expect(
      validLegEffectRecord({ ...ref, legIndex: 0, effect: "movement", ofLegIndex: null }),
    ).toBe(true);
    expect(validLegEffectRecord({ ...ref, legIndex: 2, effect: "breakdown", ofLegIndex: 0 })).toBe(
      true,
    );
    expect(validLegEffectRecord({ ...ref, legIndex: 0, effect: "movement", ofLegIndex: 1 })).toBe(
      false,
    );
    expect(validLegEffectRecord({ ...ref, legIndex: 1, effect: "breakdown", ofLegIndex: 1 })).toBe(
      false,
    );
  });

  test("a seal pins identity revisions as non-negative integers", () => {
    const seal = {
      ...ref,
      writerRelease: "synthetic-writer-v1",
      legCount: 2,
      claimCount: 1,
      timeCount: 0,
      effectCount: 0,
      contentDigest: DIGEST,
      identityPins: { "account_mapping:source-1": 3, "ownership:beneficial_owner|acct-1": 1 },
      identityEpoch: "identity-epoch-1",
      commit: { coreEpoch: "core-epoch-1", commitSeq: 2 },
    };
    expect(validRevisionSealRecord(seal)).toBe(true);
    expect(validRevisionSealRecord({ ...seal, writerRelease: "Writer V1" })).toBe(false);
    expect(validRevisionSealRecord({ ...seal, contentDigest: "A".repeat(64) })).toBe(false);
    expect(validIdentityPins({ "account_mapping:source-1": -1 })).toBe(false);
    expect(validIdentityPins({ "account_mapping:source-1": 1.5 })).toBe(false);
  });
});

describe("identity", () => {
  test("an alias class never carries the producer or namespace, so two producers share it", () => {
    // The same provider row collected under two producers: two keys, one fact.
    const underA: ConsumptionKey = ["bank-x", "producer-a", "ns-a", "account-1", "row-0001"];
    const underB: ConsumptionKey = ["bank-x", "producer-b", "ns-b", "account-1", "row-0001"];
    expect(consumptionKeyText(underA)).not.toBe(consumptionKeyText(underB));
    expect(aliasClassText(ALIAS_A)).toBe(
      '["bank-x",["meisai-0001"],"acct-bank-1","bank-x-identity-v1"]',
    );
    expect(validAliasClass(ALIAS_A)).toBe(true);
    expect(validAliasClass({ ...ALIAS_A, components: [] })).toBe(false);
    expect(validAliasClass({ ...ALIAS_A, producerId: "producer-a" })).toBe(false);
  });

  const human = {
    resolverDeclared: true,
    writerKind: "human",
    retireBeforeRecognise: false,
  } as const;
  test("T2a/T2b: occurrence fingerprints (Sony JSON vs CSV, a MoneyForward mirror) are refused", () => {
    expect(admitIdentity({ ...human, originBasis: "fingerprint-occurrence" })).toEqual({
      admitted: false,
      refusal: "identity_fingerprint_only",
    });
  });

  test("T6a: a digest of stored content (two V Point Pay deliveries) is not a provider id", () => {
    expect(admitIdentity({ ...human, originBasis: "evidence-digest" })).toEqual({
      admitted: false,
      refusal: "identity_digest_not_provider",
    });
  });

  test("T7: an id without a recorded origin (PayPay, yen detail, SBI VC cashflow) is refused", () => {
    expect(admitIdentity({ ...human, originBasis: "unrecorded" })).toEqual({
      admitted: false,
      refusal: "identity_origin_unrecorded",
    });
  });

  test("T8: a collector fingerprint under externalIdOrigin (SBI domestic) is refused", () => {
    expect(admitIdentity({ ...human, originBasis: "collector-fingerprint" })).toEqual({
      admitted: false,
      refusal: "identity_fingerprint_only",
    });
  });

  test("a provider id needs a declared resolver, and then an alias class", () => {
    expect(admitIdentity({ ...human, originBasis: "provider-id" })).toEqual({
      admitted: true,
      aliasClassRequired: true,
    });
    expect(
      admitIdentity({ ...human, originBasis: "provider-id", resolverDeclared: false }),
    ).toEqual({ admitted: false, refusal: "identity_resolver_missing" });
    expect(admitIdentity({ ...human, originBasis: "absent" })).toEqual({
      admitted: false,
      refusal: "identity_absent",
    });
  });

  test("a rule writer keeps the bare 5-tuple only under retire-before-recognise", () => {
    const rule = {
      originBasis: "fingerprint-occurrence",
      resolverDeclared: false,
      writerKind: "rule",
    } as const;
    expect(admitIdentity({ ...rule, retireBeforeRecognise: true })).toEqual({
      admitted: true,
      aliasClassRequired: false,
    });
    expect(admitIdentity({ ...rule, retireBeforeRecognise: false })).toEqual({
      admitted: false,
      refusal: "identity_fingerprint_only",
    });
    expect(admitIdentity({ ...rule, originBasis: "absent", retireBeforeRecognise: true })).toEqual({
      admitted: false,
      refusal: "identity_absent",
    });
  });

  test("every input of the closed shape has exactly one outcome from the closed lists", () => {
    let cases = 0;
    for (const originBasis of IDENTITY_ORIGIN_BASES)
      for (const resolverDeclared of [true, false])
        for (const writerKind of ["rule", "human"] as const)
          for (const retireBeforeRecognise of [true, false]) {
            const input = { originBasis, resolverDeclared, writerKind, retireBeforeRecognise };
            expect(validIdentityAdmissionInput(input)).toBe(true);
            const outcome = admitIdentity(input);
            if (outcome.admitted) {
              // Only a provider id with a resolver, or a proven rule writer.
              expect(
                (originBasis === "provider-id" && resolverDeclared) ||
                  (writerKind === "rule" && retireBeforeRecognise),
              ).toBe(true);
              expect(originBasis).not.toBe("absent");
            } else expect(IDENTITY_REFUSALS).toContain(outcome.refusal);
            cases += 1;
          }
    expect(cases).toBe(48);
    expect(
      validIdentityAdmissionInput({
        ...human,
        originBasis: "provider-id",
        possibleDuplicate: true,
      }),
    ).toBe(false);
    expect(IDENTITY_REFUSALS).toEqual([
      "identity_fingerprint_only",
      "identity_origin_unrecorded",
      "identity_digest_not_provider",
      "identity_resolver_missing",
      "identity_absent",
      "duplicate_unresolved",
      "alias_conflict",
      "identity_rekeyed",
      "identity_epoch_changed",
    ]);
  });
});

describe("closed codes", () => {
  test("a D1 error message maps to its code, and nothing else does", () => {
    expect(economicGuardCode("D1_ERROR: economic_claim_held: SQLITE_CONSTRAINT_TRIGGER")).toBe(
      "economic_claim_held",
    );
    expect(economicGuardCode("card_purchase_key_held")).toBe(null);
    expect(new Set(ECONOMIC_GUARD_CODES).size).toBe(ECONOMIC_GUARD_CODES.length);
    expect(BOOKS).toEqual(["card-usage", "cash-movement", "security-quantity"]);
  });

  test("the package index exports the contract", () => {
    expect(domain.ECONOMIC_CONTRACT_VERSION).toBe("economic-contract-v1");
    expect(domain.validConsumptionKey(KEY_A)).toBe(true);
  });
});
