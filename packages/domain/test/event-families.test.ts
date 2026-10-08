import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  classifyActivity,
  validActivityMeaning,
  type ActivityMeaning,
} from "../../../packages/observation-shared/src/activity-semantics.ts";
import {
  EXTERNAL_ID_BASES,
  FAMILY_SUPPORT,
  FAMILY_UNSUPPORTED_REASONS,
  familyUnsupportedReasons,
  PROVIDER_LINK_CODES,
  RECORDED_ORIGIN_KEYS,
  REGISTRY_OBSERVATION_KINDS,
  STAGE_A_ORIGIN_READINGS,
  TRANSACTION_FAMILIES,
  TRANSACTION_FAMILY_REGISTRY,
  TRANSACTION_FAMILY_REGISTRY_VERSION,
  transactionFamilyEntries,
  transactionFamilyEntry,
  validTransactionFamilyEntry,
  WRITER_STATUSES,
  type TransactionFamily,
  type TransactionFamilyEntry,
} from "../src/event-families.ts";
import * as domain from "../src/index.ts";

const key = (entry: Pick<TransactionFamilyEntry, "sourceId" | "parserName">) =>
  `${entry.sourceId}/${entry.parserName}`;
const clone = (entry: TransactionFamilyEntry) =>
  structuredClone(entry) as unknown as Record<string, any>;

describe("closed codes", () => {
  test("the lists are exactly the reviewed codes", () => {
    expect(TRANSACTION_FAMILY_REGISTRY_VERSION).toBe("transaction-family-registry-v1");
    expect(TRANSACTION_FAMILIES).toEqual([
      "bank-movement",
      "fx-exchange",
      "overseas-remittance",
      "securities-order",
      "securities-execution",
      "securities-settlement-cash",
      "crypto-execution",
      "crypto-fiat-remittance",
      "reward-exchange",
      "prepaid-funding",
      "prepaid-notification",
      "card-purchase",
      "card-settlement",
    ]);
    expect(FAMILY_UNSUPPORTED_REASONS).toEqual([
      "no_event_writer",
      "identity_fingerprint_only",
      "identity_evidence_digest",
      "identity_origin_unrecorded",
      "identity_absent",
      "direction_code_unmapped",
      "cash_amount_not_stated",
      "counterpart_not_stated",
      "not_collected",
      "semantics_unobserved",
      "snapshot_only",
      "writer_guard_pending",
    ]);
    expect(PROVIDER_LINK_CODES).toEqual([
      "execution_sub_number",
      "value_date",
      "settlement_amount",
      "commission_stated",
      "exchange_rate_stated",
      "none",
    ]);
    expect(EXTERNAL_ID_BASES).toEqual([
      "provider_id",
      "provider_id_tuple",
      "evidence_digest",
      "fingerprint_occurrence",
      "collector_fingerprint",
      "none",
    ]);
    expect(RECORDED_ORIGIN_KEYS).toEqual(["identityOrigin", "externalIdOrigin"]);
    expect(STAGE_A_ORIGIN_READINGS).toEqual(["provider", "fingerprint", "unknown"]);
    expect(REGISTRY_OBSERVATION_KINDS).toEqual(["transaction", "position"]);
    expect(WRITER_STATUSES).toEqual(["supported", "unsupported"]);
  });

  test("the package index exports the registry and its lookups", () => {
    expect(domain.TRANSACTION_FAMILY_REGISTRY).toBe(TRANSACTION_FAMILY_REGISTRY);
    expect(domain.transactionFamilyEntry).toBe(transactionFamilyEntry);
    expect(domain.transactionFamilyEntries).toBe(transactionFamilyEntries);
    expect(domain.familyUnsupportedReasons).toBe(familyUnsupportedReasons);
  });

  test("the registry holds codes only: no provider value, amount, account or merchant text", () => {
    const strings: string[] = [];
    const walk = (value: unknown): void => {
      if (typeof value === "string") strings.push(value);
      else if (Array.isArray(value)) value.forEach(walk);
      else if (value !== null && typeof value === "object")
        for (const [field, item] of Object.entries(value)) {
          strings.push(field);
          walk(item);
        }
    };
    walk(TRANSACTION_FAMILY_REGISTRY);
    walk(FAMILY_SUPPORT);
    expect(strings.length).toBeGreaterThan(300);
    for (const text of strings) expect(text).toMatch(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u);
  });
});

describe("registry entries", () => {
  test("every entry is valid, unique and in source/parser order", () => {
    expect(TRANSACTION_FAMILY_REGISTRY).toHaveLength(23);
    for (const entry of TRANSACTION_FAMILY_REGISTRY)
      expect(validTransactionFamilyEntry(entry)).toBe(true);
    const keys = TRANSACTION_FAMILY_REGISTRY.map(key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toEqual([...keys].sort());
  });

  test("every membership names a family of the closed list and carries its family-level reasons", () => {
    let memberships = 0;
    for (const entry of TRANSACTION_FAMILY_REGISTRY)
      for (const membership of entry.families) {
        expect(TRANSACTION_FAMILIES).toContain(membership.family);
        if (membership.writer === "unsupported")
          for (const reason of FAMILY_SUPPORT[membership.family].reasons)
            expect(membership.reasons).toContain(reason);
        // Reasons are kept in closed-list order, so equal sets compare equal.
        expect(membership.reasons).toEqual(
          FAMILY_UNSUPPORTED_REASONS.filter((reason) =>
            (membership.reasons as readonly string[]).includes(reason),
          ),
        );
        memberships += 1;
      }
    expect(memberships).toBe(35);
  });

  test("only Vpass/MyJCB card purchases and SMBC/SBI Shinsei card settlement debits have writers", () => {
    const supported = TRANSACTION_FAMILY_REGISTRY.flatMap((entry) =>
      entry.families
        .filter((membership) => membership.writer === "supported")
        .map((membership) => `${key(entry)}:${membership.family}`),
    );
    expect(supported).toEqual([
      "myjcb/myjcb-credit-ledger:card-purchase",
      "sbi-shinsei-bank/sbi-shinsei-top-balances-and-activity:card-settlement",
      "smbc-bank/smbc-direct-transactions:card-settlement",
      "vpass/vpass-statement-page:card-purchase",
    ]);
    const supportedFamilies = TRANSACTION_FAMILIES.filter(
      (family) => FAMILY_SUPPORT[family].writer === "supported",
    );
    expect(supportedFamilies).toEqual(["card-purchase", "card-settlement"]);
    for (const family of TRANSACTION_FAMILIES) {
      const support = FAMILY_SUPPORT[family];
      if (support.writer === "supported") expect(support.reasons).toEqual([]);
      else expect(support.reasons).toContain("no_event_writer");
    }
    expect(Object.keys(FAMILY_SUPPORT).sort()).toEqual([...TRANSACTION_FAMILIES].sort());
  });

  test("the recorded identity origins are the ones the parsers write", () => {
    const by = (predicate: (entry: TransactionFamilyEntry) => boolean) =>
      TRANSACTION_FAMILY_REGISTRY.filter(predicate).map(key);
    // Provider row ids whose parser records no origin: stage A reads them as unknown.
    expect(
      by(
        (entry) =>
          (entry.identity.externalId === "provider_id" ||
            entry.identity.externalId === "provider_id_tuple") &&
          entry.identity.originKey === null,
      ),
    ).toEqual([
      "paypay/paypay-csv",
      "sbi-securities/sbi-yen-detail-history",
      "sbi-shinsei-bank/sbi-shinsei-top-balances-and-activity",
      "sbi-vc-trade/sbi-vc-cashflows",
      "sbi-vc-trade/sbi-vc-executions",
    ]);
    expect(by((entry) => entry.identity.originKey === "externalIdOrigin")).toEqual([
      "sbi-securities/sbi-domestic-trade-records",
    ]);
    expect(by((entry) => entry.identity.stageAReads === "provider")).toEqual([
      "smbc-bank/smbc-direct-transactions",
      "v-point-pay/v-point-pay-notification-event",
    ]);
    expect(by((entry) => entry.identity.externalId === "none")).toEqual([
      "sbi-securities/sbi-domestic-cash-positions",
      "sbi-securities/sbi-foreign-cash-positions",
      "sbi-vc-trade/sbi-vc-position-summary",
      "v-point/v-point-history-page",
    ]);
    for (const entry of TRANSACTION_FAMILY_REGISTRY) {
      const fingerprint =
        entry.identity.externalId === "fingerprint_occurrence" ||
        entry.identity.externalId === "collector_fingerprint";
      const digest = entry.identity.externalId === "evidence_digest";
      // Stage A reads only identityOrigin; an origin under another key is unknown to it.
      expect(entry.identity.stageAReads === "fingerprint").toBe(
        fingerprint && entry.identity.originKey === "identityOrigin",
      );
      expect(entry.identity.stageAReads === "unknown").toBe(
        entry.identity.originKey !== "identityOrigin",
      );
      const unsupported = entry.families.filter((membership) => membership.writer !== "supported");
      for (const membership of unsupported) {
        // An identity reason is required exactly when the id is not the provider's.
        expect(
          membership.reasons.some(
            (reason) =>
              reason === "identity_fingerprint_only" || reason === "identity_evidence_digest",
          ),
        ).toBe(fingerprint || digest);
        expect(membership.reasons.includes("identity_fingerprint_only")).toBe(fingerprint);
        expect(membership.reasons.includes("identity_evidence_digest")).toBe(digest);
        expect(membership.reasons.includes("identity_origin_unrecorded")).toBe(
          entry.identity.externalId !== "none" && entry.identity.originKey !== "identityOrigin",
        );
        expect(membership.reasons.includes("identity_absent")).toBe(
          entry.identity.externalId === "none" && !entry.observationKinds.includes("position"),
        );
        expect(membership.reasons.includes("snapshot_only")).toBe(
          entry.observationKinds.includes("position"),
        );
      }
    }
  });

  test("the validator rejects unknown keys, unknown codes and contradictory shapes", () => {
    const base = TRANSACTION_FAMILY_REGISTRY.find(
      (entry) => entry.parserName === "sbi-vc-executions",
    )!;
    const mutations: ((entry: Record<string, any>) => void)[] = [
      (entry) => (entry.amount = "1"),
      (entry) => delete entry.statuses,
      (entry) => (entry.identity.extra = true),
      (entry) => (entry.identity.externalId = "provider"),
      (entry) => (entry.identity.originKey = "identityOrigin"),
      (entry) => (entry.identity.stageAReads = "provider"),
      (entry) => (entry.identity.stageAReads = "maybe"),
      (entry) => delete entry.identity.stageAReads,
      (entry) => {
        entry.identity.originKey = "externalIdOrigin";
        entry.identity.stageAReads = "fingerprint";
      },
      (entry) => (entry.observationKinds = ["balance"]),
      (entry) => (entry.observationKinds = []),
      (entry) => (entry.observationKinds = ["transaction", "transaction"]),
      (entry) => (entry.statuses = { kind: "closed", values: [] }),
      (entry) => (entry.statuses = { kind: "closed", values: ["posted", "posted"] }),
      (entry) => (entry.statuses = { kind: "absent", values: ["posted"] }),
      (entry) => (entry.statuses = { kind: "verbatim" }),
      (entry) => (entry.providerLinks = ["none", "value_date"]),
      (entry) => (entry.providerLinks = ["order_id"]),
      (entry) => (entry.providerLinks = []),
      (entry) => (entry.families = []),
      (entry) => (entry.families[0].family = "trade"),
      (entry) => (entry.families[0].reasons = ["held_contract"]),
      (entry) => (entry.families[0].reasons = ["cash_amount_not_stated"]),
      (entry) => (entry.families[0].reasons = []),
      (entry) => (entry.families[0].writer = "supported"),
      (entry) => (entry.families[0].writer = "partial"),
      (entry) => entry.families.push(structuredClone(entry.families[0])),
      (entry) => (entry.sourceId = ""),
    ];
    expect(validTransactionFamilyEntry(clone(base))).toBe(true);
    for (const mutate of mutations) {
      const entry = clone(base);
      mutate(entry);
      expect(validTransactionFamilyEntry(entry)).toBe(false);
    }
    const supported = clone(transactionFamilyEntry("vpass", "vpass-statement-page")!);
    supported.families[0].reasons = ["no_event_writer"];
    expect(validTransactionFamilyEntry(supported)).toBe(false);
    expect(validTransactionFamilyEntry(null)).toBe(false);
    expect(validTransactionFamilyEntry([])).toBe(false);
  });
});

describe("lookups", () => {
  test("by source and parser", () => {
    const entry = transactionFamilyEntry("sbi-vc-trade", "sbi-vc-executions");
    expect(entry?.families.map((membership) => membership.family)).toEqual(["crypto-execution"]);
    expect(entry?.providerLinks).toEqual([
      "execution_sub_number",
      "value_date",
      "commission_stated",
    ]);
    expect(transactionFamilyEntry("sbi-vc-trade", "sbi-vc-cash-balances")).toBeNull();
    expect(transactionFamilyEntry("myjcb", "sbi-vc-executions")).toBeNull();
  });

  test("by family", () => {
    const keysOf = (family: TransactionFamily) => transactionFamilyEntries(family).map(key);
    expect(keysOf("card-settlement")).toEqual([
      "sbi-shinsei-bank/sbi-shinsei-top-balances-and-activity",
      "smbc-bank/smbc-direct-transactions",
    ]);
    expect(keysOf("securities-execution")).toEqual([
      "sbi-securities/sbi-domestic-cash-positions",
      "sbi-securities/sbi-domestic-trade-records",
      "sbi-securities/sbi-foreign-cash-positions",
      "sbi-securities/sbi-foreign-trade-records",
    ]);
    expect(keysOf("fx-exchange")).toEqual([
      "global-pass/global-pass-activity",
      "paypay/paypay-csv",
      "sbi-shinsei-bank/sbi-shinsei-top-balances-and-activity",
      "sony-bank/sony-bank-history-csv",
      "sony-bank/sony-bank-history-json",
      "sony-bank/sony-bank-wallet-history",
      "vpass/vpass-statement-page",
    ]);
    // No parser identifies these rows today.
    expect(keysOf("securities-order")).toEqual([]);
    expect(keysOf("overseas-remittance")).toEqual([]);
    for (const family of TRANSACTION_FAMILIES)
      for (const entry of transactionFamilyEntries(family))
        expect(entry.families.some((membership) => membership.family === family)).toBe(true);
  });

  test("unsupported reasons per family", () => {
    expect(familyUnsupportedReasons("card-settlement")).toEqual([]);
    expect(familyUnsupportedReasons("securities-order")).toEqual([
      "no_event_writer",
      "not_collected",
    ]);
    expect(familyUnsupportedReasons("overseas-remittance")).toEqual([
      "no_event_writer",
      "semantics_unobserved",
      "writer_guard_pending",
    ]);
    expect(familyUnsupportedReasons("crypto-execution")).toEqual([
      "no_event_writer",
      "identity_origin_unrecorded",
      "cash_amount_not_stated",
      "snapshot_only",
      "writer_guard_pending",
    ]);
    // A supported family still lists why the sources its writer does not read are unsupported.
    expect(familyUnsupportedReasons("card-purchase")).toEqual([
      "no_event_writer",
      "identity_fingerprint_only",
      "counterpart_not_stated",
      "semantics_unobserved",
    ]);
    for (const family of TRANSACTION_FAMILIES) {
      const reasons = familyUnsupportedReasons(family);
      expect(reasons).toEqual(FAMILY_UNSUPPORTED_REASONS.filter((code) => reasons.includes(code)));
      if (FAMILY_SUPPORT[family].writer === "unsupported")
        expect(reasons).toContain("no_event_writer");
    }
  });
});

/**
 * The display kinds (`classifyActivity`) a family's rows may carry. A family
 * maps only onto kinds the classifier knows; `unknown` is never a mapping.
 */
const ACTIVITY_KINDS: Record<TransactionFamily, readonly ActivityMeaning["kind"][]> = {
  "bank-movement": ["cash_movement"],
  "fx-exchange": ["cash_movement", "card_activity"],
  "overseas-remittance": ["cash_movement"],
  "securities-order": ["trade"],
  "securities-execution": ["trade"],
  "securities-settlement-cash": ["cash_movement"],
  "crypto-execution": ["trade"],
  "crypto-fiat-remittance": ["cash_movement"],
  // The classifier has no kind for point history yet; its rows are `unknown`.
  "reward-exchange": [],
  "prepaid-funding": ["cash_movement", "notification"],
  "prepaid-notification": ["notification"],
  "card-purchase": ["card_activity", "statement_item"],
  "card-settlement": ["cash_movement"],
};
/** Transaction parsers `classifyActivity` does not classify yet (kind `unknown`). */
const UNCLASSIFIED = [
  "moneyforward-me/moneyforward-monthly-transactions",
  "paypay/paypay-csv",
  "st-george/st-george-transactions",
  "v-point/v-point-history-page",
];

describe("consistency with classifyActivity", () => {
  const base = classifyActivity({ sourceId: "x", parserName: "y", status: null });

  test("every family maps onto kinds the classifier knows", () => {
    expect(Object.keys(ACTIVITY_KINDS).sort()).toEqual([...TRANSACTION_FAMILIES].sort());
    expect(TRANSACTION_FAMILIES.filter((family) => ACTIVITY_KINDS[family].length === 0)).toEqual([
      "reward-exchange",
    ]);
    for (const kinds of Object.values(ACTIVITY_KINDS)) {
      for (const kind of kinds) {
        expect(kind).not.toBe("unknown");
        expect(validActivityMeaning({ ...base, kind })).toBe(true);
      }
    }
  });

  test("every transaction entry's classified kind fits each of its families", () => {
    const unclassified: string[] = [];
    let checked = 0;
    for (const entry of TRANSACTION_FAMILY_REGISTRY) {
      if (!entry.observationKinds.includes("transaction")) continue;
      const statuses =
        entry.statuses.kind === "closed" ? [...entry.statuses.values, null] : [null, "provider"];
      for (const status of statuses) {
        const { kind } = classifyActivity({
          sourceId: entry.sourceId,
          parserName: entry.parserName,
          status,
        });
        if (kind === "unknown") {
          if (status === null) unclassified.push(key(entry));
          continue;
        }
        for (const membership of entry.families)
          expect(ACTIVITY_KINDS[membership.family]).toContain(kind);
        checked += 1;
      }
    }
    expect(unclassified).toEqual(UNCLASSIFIED);
    expect(checked).toBeGreaterThanOrEqual(20);
  });
});

describe("documentation", () => {
  test("the economic-events family table states what the registry states", () => {
    const doc = readFileSync(new URL("../../../docs/economic-events.md", import.meta.url), "utf8");
    const cells = (line: string) =>
      line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim());
    const documented = doc
      .split("\n")
      .filter((line) => /^\| `[a-z-]+` +\| (?:un)?supported /u.test(line))
      .map(cells);
    const code = (text: string) => `\`${text}\``;
    expect(documented).toEqual(
      TRANSACTION_FAMILIES.map((family) => [
        code(family),
        FAMILY_SUPPORT[family].writer,
        transactionFamilyEntries(family)
          .map((entry) => {
            const membership = entry.families.find((item) => item.family === family)!;
            return `${code(entry.parserName)}${membership.writer === "supported" ? " (writer)" : ""}`;
          })
          .join(", ") || "none",
        familyUnsupportedReasons(family).map(code).join(", ") || "—",
      ]),
    );
  });
});
