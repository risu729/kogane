// The transaction-family registry (packages/domain/src/event-families.ts,
// ADR 0053) against the parsers it describes. Every PARSERS entry whose rows
// are transactions or positions has exactly one registry entry and no entry is
// extra; each such parser is run on the shared synthetic fixtures, and what the
// rows record (observation kinds, the identity-origin key and its stage A
// classification, the status vocabulary, the provider link fields) must be
// what the registry states. Only shapes and closed classifications are
// compared, never an id or a provider value.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TRANSACTION_FAMILY_REGISTRY,
  transactionFamilyEntry,
  type ProviderLinkCode,
  type StageAOriginReading,
  type TransactionFamilyEntry,
} from "../../domain/src/event-families.ts";
import { globalPassActivity } from "../src/parsers/global-pass-activity-parser.ts";
import { mizuhoOrdinaryHistory } from "../src/parsers/mizuho.ts";
import { mobileSuicaSfHistory } from "../src/parsers/mobile-suica-sf-history.ts";
import { moneyForwardMonthlyTransactions } from "../src/parsers/moneyforward-parser.ts";
import { myJcbCreditLedger } from "../src/parsers/myjcb.ts";
import { paypayCsv } from "../src/parsers/paypay-csv.ts";
import { PARSERS } from "../src/parsers/registry.ts";
import { sbiDomesticTradeRecords } from "../src/parsers/sbi-domestic-trade-records.ts";
import { sbiForeignCashPositions } from "../src/parsers/sbi-foreign-cash-positions.ts";
import { sbiForeignTradeRecords } from "../src/parsers/sbi-foreign-trade-records.ts";
import { sbiVcCashflows } from "../src/parsers/sbi-vc-cashflows.ts";
import { sbiVcExecutions } from "../src/parsers/sbi-vc-executions.ts";
import { sbiYenDetailHistory } from "../src/parsers/sbi-yen-detail-history.ts";
import { smbcDirectTransactions } from "../src/parsers/smbc-direct.ts";
import {
  sonyBankHistoryCsv,
  sonyBankHistoryJson,
  sonyBankWalletHistory,
} from "../src/parsers/sony-bank.ts";
import { stGeorgeTransactions } from "../src/parsers/st-george.ts";
import { vPointHistoryPage } from "../src/parsers/v-point.ts";
import { vPointPayNotificationEvent } from "../src/parsers/v-point-pay.ts";
import { vpassStatementPage } from "../src/parsers/vpass.ts";
import type { ArtifactMeta, Observation, Parser } from "../src/types.ts";
import { CONTRACT_PARSERS } from "./coverage-contract-cases.ts";
import { FIXTURES_ROOT } from "./fixture-root.ts";
import { mizuhoHistoryHtml, mizuhoHistoryRow } from "./mizuho-fixture.ts";

/** PARSERS entries whose rows are balances, valuations, scheduled payments or none. */
const NOT_IN_REGISTRY = [
  "mizuho-account-list",
  "moneyforward-canonical-evidence-boundary",
  "myjcb-canonical-evidence-boundary",
  "myjcb-credit-past-month-balances",
  "myjcb-credit-statement-total",
  "myjcb-skip-payment-schedule",
  "prestia-bank-balances",
  "sbi-account-assets-current",
  "sbi-foreign-cash-balances",
  "sbi-shinsei-balance-summary-and-stage",
  "sbi-shinsei-exchange-rate",
  "sbi-shinsei-yen-deposit-account",
  "sbi-vc-account-margin",
  "sbi-vc-cash-balances",
  "smbc-direct-balance",
  "sony-bank-gross-balance",
  "st-george-balances",
  "v-point-balance-info",
  "v-point-smfg-point",
];

interface Case {
  parser: Parser;
  name: string;
  meta: ArtifactMeta;
  bytes: Uint8Array;
  /** A coverage-contract case: it may be refused or have no rows by design. */
  contract?: true;
}

const read = (...path: string[]): Uint8Array => readFileSync(join(FIXTURES_ROOT, ...path));
const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value));
function meta(sourceId: string, dataset: string | null, extra: Partial<ArtifactMeta> = {}) {
  return {
    id: 1,
    sourceId,
    runStatus: "success",
    runFailureCount: 0,
    dataset,
    url: null,
    mime: "application/json",
    fetchedAt: "2026-09-07T00:00:00.000Z",
    sha256: "0".repeat(64),
    ...extra,
  } satisfies ArtifactMeta;
}
const one = (parser: Parser, name: string, artifact: ArtifactMeta, bytes: Uint8Array): Case => ({
  parser,
  name,
  meta: artifact,
  bytes,
});

const SBI_RUN = ["sbi-securities", "2026-08-20", "run-20260820-210000-poc01"] as const;
const VC_RUN = ["sbi-vc-trade", "2026-09-07", "run-20260907-synthetic01"] as const;
const MYJCB_RUN = ["myjcb", "2026-09-07", "run-synthetic", "connection-a"] as const;
const sonyWindow = { runWindow: { from: "2026-09-01", to: "2026-09-30" } };
const sonyForeignCsv = [
  "取引日,摘要,参考情報,通貨,預入額,引出額,差引残高,為替レート",
  "2026/09/03,匿名外貨入金,合成データ,USD,10.00,,10.00,150.25",
].join("\n");
const myJcbLedger = (detailMonth: string) =>
  JSON.parse(new TextDecoder().decode(read(...MYJCB_RUN, `credit-ledger-${detailMonth}.json`))) as {
    state: string;
    period: string;
  };
const stGeorgeSnapshot = {
  schema: "st-george-browser-v1",
  observedAt: "2026-09-13T00:00:00Z",
  currency: "AUD",
  currencyEvidence: "source-configured",
  accounts: [
    {
      accountKey: "a".repeat(64),
      label: "Synthetic account",
      currentBalanceText: "$1,234.56",
      availableBalanceText: "1,200.00",
      openingBalanceText: "1,246.90",
      closingBalanceText: "1,234.56",
      historyState: "observed",
      pendingState: "unknown",
      transactions: [
        {
          dateText: "12/09/2026",
          description: "Synthetic purchase",
          category: "Other",
          debitText: "12.34",
          creditText: "",
          balanceText: "1,234.56",
        },
      ],
    },
  ],
};

/** Registry parsers among the coverage-contract cases (SBI Shinsei, positions). */
const contractCases = (parserNames: readonly string[]): Case[] =>
  CONTRACT_PARSERS.filter(({ parser }) => parserNames.includes(parser.name)).flatMap(
    ({ parser, cases }) =>
      cases.map(({ name, artifact, bytes }) => ({
        ...one(parser, name, artifact, bytes),
        contract: true as const,
      })),
  );

const CASES: Case[] = [
  one(
    globalPassActivity,
    "activity",
    meta("global-pass", "globalpass-activity", {
      artifactKey: "activity-2099-02.html",
      mime: "text/html",
    }),
    read("global-pass", "activity-2099-02.html"),
  ),
  one(
    mizuhoOrdinaryHistory,
    "history",
    meta("mizuho-bank", "mizuho-ordinary-history-html", {
      artifactKey: "ordinary/001-1234567/history/1-2.html",
      fetchUnitKey: "ordinary:001:1234567:page:1:2",
      mime: "text/html",
    }),
    encode(
      mizuhoHistoryHtml(
        mizuhoHistoryRow("000", "+ 1", "1,234") + mizuhoHistoryRow("001", "- 1", "1,233"),
        "1&nbsp;-&nbsp;2&nbsp;件",
        "2",
      ),
    ),
  ),
  ...["sf-history.json", "sf-history-more-kinds.json"].map((file) =>
    one(
      mobileSuicaSfHistory,
      file,
      meta("mobile-suica", "sf-history"),
      read("mobile-suica-parser-boundaries", file),
    ),
  ),
  one(
    moneyForwardMonthlyTransactions,
    "month",
    meta("moneyforward-me", "monthly-transactions", {
      artifactKey: "account-01-month-2099-02.html",
      fetchUnitKey: `moneyforward-account-v1-${"a".repeat(64)}`,
      mime: "text/html",
      statementState: null,
      period: null,
    }),
    read("moneyforward", "account-01-month-2099-02.html"),
  ),
  ...["00", "02"].map((detailMonth) => {
    const ledger = myJcbLedger(detailMonth);
    return one(
      myJcbCreditLedger,
      `ledger-${detailMonth}`,
      meta("myjcb", "credit-ledger", {
        artifactKey: `connection-a/credit-ledger-${detailMonth}.json`,
        statementState: ledger.state,
        period: ledger.period,
      }),
      read(...MYJCB_RUN, `credit-ledger-${detailMonth}.json`),
    );
  }),
  one(
    paypayCsv,
    "csv",
    meta("paypay", null, { mime: "text/csv" }),
    read("paypay", "paypay-transactions-202608.csv"),
  ),
  ...contractCases([
    "sbi-domestic-cash-positions",
    "sbi-foreign-cash-positions",
    "sbi-shinsei-top-balances-and-activity",
    "sbi-vc-position-summary",
  ]),
  one(
    sbiForeignCashPositions,
    "run",
    meta("sbi-securities", "foreign-cash-positions"),
    read(...SBI_RUN, "foreign-cash-positions.json"),
  ),
  one(
    sbiDomesticTradeRecords,
    "run",
    meta("sbi-securities", "domestic-trade-records"),
    read(...SBI_RUN, "domestic-trade-records.json"),
  ),
  one(
    sbiForeignTradeRecords,
    "boundary",
    meta("sbi-securities", "foreign-trade-records"),
    read("sbi-parser-boundaries", "foreign-trade-records.json"),
  ),
  one(
    sbiYenDetailHistory,
    "run",
    meta("sbi-securities", "yen-detail-history"),
    read(...SBI_RUN, "yen-detail-history.json"),
  ),
  one(
    sbiYenDetailHistory,
    "boundary",
    meta("sbi-securities", "yen-detail-history"),
    read("sbi-parser-boundaries", "yen-detail-history.json"),
  ),
  one(
    sbiVcCashflows,
    "historical",
    meta("sbi-vc-trade", "cashflows-historical-page-0001"),
    read(...VC_RUN, "cashflows-historical-page-0001.json"),
  ),
  ...["executions-recent-page-0001", "executions-historical-page-0001"].map((dataset) =>
    one(
      sbiVcExecutions,
      dataset,
      meta("sbi-vc-trade", dataset),
      read(...VC_RUN, `${dataset}.json`),
    ),
  ),
  one(
    smbcDirectTransactions,
    "transactions",
    meta("smbc-bank", "transactions-normalized", {
      artifactKey: "transactions/20260801-20260831.normalized.json",
      fetchedAt: "2026-09-05T00:01:00.000Z",
    }),
    read("smbc-direct-parser-boundaries", "transactions-normalized.json"),
  ),
  one(
    sonyBankHistoryCsv,
    "yen",
    meta("sony-bank", "yen-history-csv", { mime: "text/csv; charset=UTF-8", ...sonyWindow }),
    read("sony-bank-parser-boundaries", "yen-history.csv"),
  ),
  one(
    sonyBankHistoryCsv,
    "foreign",
    meta("sony-bank", "foreign-history-usd-csv", {
      mime: "text/csv; charset=UTF-8",
      ...sonyWindow,
    }),
    encode(sonyForeignCsv),
  ),
  one(
    sonyBankHistoryJson,
    "yen",
    meta("sony-bank", "yen-history-page-0001", sonyWindow),
    read("sony-bank-parser-boundaries", "yen-history-page-0001.json"),
  ),
  one(
    sonyBankWalletHistory,
    "wallet",
    meta("sony-bank", "wallet-history-202609", { mime: "text/html; charset=UTF-8" }),
    read("sony-bank-parser-boundaries", "wallet-history-2026-09.html"),
  ),
  one(
    stGeorgeTransactions,
    "snapshot",
    meta("st-george", "account-snapshot", { artifactKey: "account-snapshot.json" }),
    encode(stGeorgeSnapshot),
  ),
  one(
    vPointHistoryPage,
    "page",
    meta("v-point", "history-page-0001"),
    read("v-point", "history-page-0001.json"),
  ),
  ...["usage", "charge", "declined", "balance-addition"].map((name) =>
    one(
      vPointPayNotificationEvent,
      name,
      meta("v-point-pay", "notification-event", { artifactKey: "normalized-event.json" }),
      read("v-point-pay-parser-boundaries", `${name}.json`),
    ),
  ),
  ...["web", "customized"].map((family) =>
    one(
      vpassStatementPage,
      family,
      meta("vpass", "statement-page", {
        artifactKey: "cards/card-001/months/202608/top-000.json",
        fetchUnitKey: "card-001",
        fetchedAt: "2026-08-30T00:00:00.000Z",
      }),
      read("vpass-parser-boundaries", `${family}.json`),
    ),
  ),
];

/**
 * Where a row states each provider link field, as a path into `extra`. The
 * test proves the field is on at least one fixture row of the parser.
 */
const LINK_FIELDS: Record<string, Partial<Record<ProviderLinkCode, readonly string[]>>> = {
  "global-pass/global-pass-activity": {
    settlement_amount: ["expandedFields", "Funded Currency and Amount"],
    commission_stated: ["expandedFields", "Transaction Fee"],
    exchange_rate_stated: ["expandedFields", "Applicable Rate"],
  },
  "paypay/paypay-csv": {
    settlement_amount: ["overseas", "amount"],
    exchange_rate_stated: ["overseas", "conversionRateJpy"],
  },
  "sbi-securities/sbi-domestic-trade-records": { value_date: ["valueDate"] },
  "sbi-securities/sbi-foreign-trade-records": {
    value_date: ["_kogane", "valueDate"],
    settlement_amount: ["settlementCurrencyCode"],
  },
  "sbi-vc-trade/sbi-vc-cashflows": { value_date: ["valueYmdDate"] },
  "sbi-vc-trade/sbi-vc-executions": {
    execution_sub_number: ["CExecutionIdSubNo"],
    value_date: ["valueYmdDate"],
    commission_stated: ["commissionAmount"],
  },
  "sony-bank/sony-bank-history-csv": { exchange_rate_stated: ["為替レート"] },
  "sony-bank/sony-bank-history-json": { exchange_rate_stated: ["applicationExchRt"] },
  "sony-bank/sony-bank-wallet-history": {
    value_date: ["primary", "確定日"],
    settlement_amount: ["primary", "お取引通貨 金額"],
    commission_stated: ["primary", "現地手数料"],
    exchange_rate_stated: ["supplement", "換算レート"],
  },
};

const RECORDED_KEYS = ["identityOrigin", "externalIdOrigin"] as const;
/**
 * The stage A rule (services/processor/src/reconciliation-job.ts `originOf`):
 * it reads only `$._kogane.identityOrigin`.
 */
const stageAReads = (kogane: Record<string, unknown>): StageAOriginReading => {
  const text = kogane["identityOrigin"];
  if (typeof text !== "string") return "unknown";
  return text.includes("fingerprint") || text.includes("occurrence") ? "fingerprint" : "provider";
};
const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const at = (extra: Record<string, unknown>, path: readonly string[]): unknown =>
  path.reduce<unknown>((value, step) => record(value)?.[step], extra);
const key = (entry: Pick<TransactionFamilyEntry, "sourceId" | "parserName">) =>
  `${entry.sourceId}/${entry.parserName}`;

type Row = Extract<Observation, { kind: "transaction" | "position" }>;
function rowsOf(parse: Case): Row[] {
  return parse.parser
    .parse(parse.bytes, parse.meta)
    .observations.filter(
      (row): row is Row => row.kind === "transaction" || row.kind === "position",
    );
}

describe("transaction-family registry against PARSERS", () => {
  test("every transaction/position parser has exactly one entry, and no entry is extra", () => {
    const names = PARSERS.map((parser) => parser.name);
    expect(new Set(names).size).toBe(names.length);
    const registered = TRANSACTION_FAMILY_REGISTRY.map((entry) => entry.parserName);
    expect(new Set(registered).size).toBe(registered.length);
    expect(registered.filter((name) => NOT_IN_REGISTRY.includes(name))).toEqual([]);
    expect([...registered, ...NOT_IN_REGISTRY].sort()).toEqual([...names].sort());
    for (const entry of TRANSACTION_FAMILY_REGISTRY) {
      const cases = CASES.filter((parse) => parse.parser.name === entry.parserName);
      expect(cases.length).toBeGreaterThan(0);
      for (const parse of cases) {
        // The entry's source is the one the parser accepts the fixture under
        // (St George's balance parser reads the same snapshot artifact).
        expect(parse.meta.sourceId).toBe(entry.sourceId);
        expect(PARSERS.filter((parser) => parser.accepts(parse.meta))).toContain(parse.parser);
      }
    }
  });

  test("parsers outside the registry emit no transaction or position rows", () => {
    let checked = 0;
    for (const { parser, cases } of CONTRACT_PARSERS) {
      if (!NOT_IN_REGISTRY.includes(parser.name)) continue;
      for (const parse of cases) {
        let rows: Row[];
        try {
          rows = rowsOf(one(parser, parse.name, parse.artifact, parse.bytes));
        } catch {
          continue;
        }
        expect(rows).toEqual([]);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(10);
  });

  test("the fixture rows record what each entry states", () => {
    const seenLinks = new Map<string, Set<ProviderLinkCode>>();
    const rowsByEntry = new Map<string, number>();
    let rowsChecked = 0;
    for (const parse of CASES) {
      const entry = transactionFamilyEntry(parse.meta.sourceId, parse.parser.name);
      if (entry === null) throw new Error(`${parse.parser.name}: no registry entry`);
      const label = `${key(entry)} ${parse.name}`;
      let rows: Row[];
      try {
        rows = rowsOf(parse);
      } catch (error) {
        if (parse.contract) continue;
        throw error;
      }
      if (rows.length === 0 && parse.contract) continue;
      expect({ label, rows: rows.length > 0 }).toEqual({ label, rows: true });
      for (const row of rows) {
        expect({ label, kind: entry.observationKinds.includes(row.kind) }).toEqual({
          label,
          kind: true,
        });
        const kogane = record(row.extra["_kogane"]) ?? {};
        // The identity origin: which key, and how stage A reads it, never its text.
        const recorded = RECORDED_KEYS.filter((name) => Object.hasOwn(kogane, name));
        expect({ label, recorded }).toEqual({
          label,
          recorded: entry.identity.originKey === null ? [] : [entry.identity.originKey],
        });
        if (entry.identity.originKey !== null)
          expect(typeof kogane[entry.identity.originKey]).toBe("string");
        expect({ label, reads: stageAReads(kogane) }).toEqual({
          label,
          reads: entry.identity.stageAReads,
        });
        // The external id: present exactly when the entry names a basis.
        const externalId = row.kind === "transaction" ? row.externalId : undefined;
        expect({ label, id: typeof externalId === "string" && externalId.length > 0 }).toEqual({
          label,
          id: entry.identity.externalId !== "none",
        });
        if (entry.identity.externalId === "provider_id_tuple")
          expect(at(row.extra, ["_kogane", "externalIdComponents"])).toHaveLength(2);
        // The status vocabulary.
        const status = row.kind === "transaction" ? row.status : undefined;
        if (entry.statuses.kind === "absent")
          expect({ label, status }).toEqual({ label, status: undefined });
        else if (entry.statuses.kind === "closed")
          expect(entry.statuses.values).toContain(status as string);
        else expect(typeof status === "string" && status.length > 0).toBe(true);
        // Provider link fields stated on the row.
        for (const [code, path] of Object.entries(LINK_FIELDS[key(entry)] ?? {}))
          if (at(row.extra, path!) !== undefined) {
            const seen = seenLinks.get(key(entry)) ?? new Set<ProviderLinkCode>();
            seen.add(code as ProviderLinkCode);
            seenLinks.set(key(entry), seen);
          }
        rowsByEntry.set(key(entry), (rowsByEntry.get(key(entry)) ?? 0) + 1);
        rowsChecked += 1;
      }
    }
    expect(rowsChecked).toBeGreaterThanOrEqual(50);
    // Every entry was proven on at least one row of its own parser.
    expect(TRANSACTION_FAMILY_REGISTRY.map(key).filter((name) => !rowsByEntry.has(name))).toEqual(
      [],
    );
    for (const entry of TRANSACTION_FAMILY_REGISTRY) {
      const stated = entry.providerLinks.filter((code) => code !== "none");
      expect({
        entry: key(entry),
        links: Object.keys(LINK_FIELDS[key(entry)] ?? {}).sort(),
      }).toEqual({
        entry: key(entry),
        links: [...stated].sort(),
      });
      expect({ entry: key(entry), seen: [...(seenLinks.get(key(entry)) ?? [])].sort() }).toEqual({
        entry: key(entry),
        seen: [...stated].sort(),
      });
    }
  });
});
