import { describe, expect, test } from "bun:test";
import type { CommandStore } from "../src/command/contract.ts";
import { cardSettlementDebitEvidence } from "../src/operations/card-settlement-target.ts";
import { settlementFacts } from "./card-settlement-fixture.ts";

const bank = {
  source_id: "sbi-shinsei-bank",
  parser_name: "sbi-shinsei-top-balances-and-activity",
  source_account: "sbi-shinsei:synthetic-bank",
  external_id: "synthetic-provider-id",
  extra_json: JSON.stringify({
    txnReferenceNo: "synthetic-provider-id",
    _kogane: { identityOrigin: "provider-id" },
  }),
  as_of: "2026-09-10",
};

async function evidence(
  row = bank,
  change: (facts: ReturnType<typeof settlementFacts>) => void = () => {},
) {
  const facts = settlementFacts();
  facts.bankDebit.sourceId = "sbi-shinsei-bank";
  change(facts);
  const store: Pick<CommandStore, "first"> = { first: async <T>() => row as T };
  return cardSettlementDebitEvidence(store, "candidate", facts);
}

describe("the cited settlement debit's posting meaning", () => {
  test("preserves only the exact admitted parser's provider civil date", async () => {
    expect(await evidence()).toMatchObject({
      identity: { admitted: true },
      posting: { kind: "local-date", value: "2026-09-10", zone: "Asia/Tokyo", basis: "provider" },
    });
  });

  test("another admitted Shinsei parser does not establish this posting contract", async () => {
    expect(await evidence({ ...bank, parser_name: "sbi-shinsei-savings-activity" })).toMatchObject({
      identity: { admitted: true },
      posting: null,
    });
  });

  test("SMBC's admitted midnight-shaped date is never promoted to a posting role", async () => {
    expect(
      await evidence(
        {
          ...bank,
          source_id: "smbc-bank",
          parser_name: "smbc-direct-transactions",
          as_of: "2026-09-10T00:00:00+09:00",
          extra_json: JSON.stringify({
            id: "synthetic-provider-id",
            _kogane: { identityOrigin: "provider-id" },
          }),
        },
        (facts) => {
          facts.bankDebit.sourceId = "smbc-bank";
        },
      ),
    ).toMatchObject({ identity: { admitted: true }, posting: null });
  });

  test("missing origin and unsupported source or parser preserve identity refusals", async () => {
    for (const row of [
      { ...bank, extra_json: JSON.stringify({ txnReferenceNo: "synthetic-provider-id" }) },
      { ...bank, extra_json: "invalid-json" },
      { ...bank, parser_name: "unsupported-parser" },
      { ...bank, source_id: "unsupported-source" },
    ])
      expect(await evidence(row)).toMatchObject({ identity: { admitted: false }, posting: null });
  });

  test("a different date, role precision, zone, basis or source is not invented from the facts", async () => {
    for (const change of [
      (facts: ReturnType<typeof settlementFacts>) => {
        facts.bankDebit.sourceId = "smbc-bank";
      },
      (facts: ReturnType<typeof settlementFacts>) => {
        facts.bankDebit.occurred = {
          kind: "local-date",
          value: "2026-09-11",
          zone: "Asia/Tokyo",
          basis: "provider",
        };
      },
      (facts: ReturnType<typeof settlementFacts>) => {
        facts.bankDebit.occurred = {
          kind: "local-date",
          value: "2026-02-30",
          zone: "Asia/Tokyo",
          basis: "provider",
        };
      },
      (facts: ReturnType<typeof settlementFacts>) => {
        facts.bankDebit.occurred = {
          kind: "instant",
          value: "2026-09-10T00:00:00+09:00",
          zone: "Asia/Tokyo",
          basis: "provider",
        };
      },
      (facts: ReturnType<typeof settlementFacts>) => {
        facts.bankDebit.occurred = {
          kind: "local-date",
          value: "2026-09-10",
          zone: "UTC",
          basis: "provider",
        };
      },
      (facts: ReturnType<typeof settlementFacts>) => {
        facts.bankDebit.occurred = {
          kind: "local-date",
          value: "2026-09-10",
          zone: "Asia/Tokyo",
          basis: "derived",
        };
      },
    ])
      expect(await evidence(bank, change)).toMatchObject({ posting: null });
  });
});
