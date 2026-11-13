import { SBI_VC_UNIT_POLICIES } from "./sbi-vc-policy-fixture.ts";

interface Policy {
  source_id: string;
  dataset: string;
  parser_name: string;
  policy_id: string;
  policy_version: number;
  required_parser_version: string | null;
  replaces_previous_on_complete_empty: number;
  unit_scope: string;
  snapshot_selection: number;
  updated_at_ms: number;
}

const policy = (
  source: string,
  dataset: string,
  parser: string,
  extra: Partial<Policy> = {},
): Policy => ({
  source_id: source,
  dataset,
  parser_name: parser,
  policy_id: "legacy-warning-compat-v1",
  policy_version: 1,
  required_parser_version: null,
  replaces_previous_on_complete_empty: 1,
  unit_scope: "unit",
  snapshot_selection: 1,
  updated_at_ms: 0,
  ...extra,
});

// The closed default opt-ins of migrations 0080, 0088, 0090, 0092, 0094, 0095, 0096,
// 0097, 0098, 0099, 0100 and 0101, plus Sony 0089.
// This expected catalogue is independent of the SQL read under test: an extra
// source, page, parser, scope, snapshot membership or policy still fails.
export const EXPECTED_UNIT_POLICIES: readonly Policy[] = [
  ...(["domestic-cash-positions", "account-assets-current", "foreign-cash-balances"] as const).map(
    (dataset) => policy("sbi-securities", dataset, `sbi-${dataset}`),
  ),
  policy("sbi-securities", "foreign-cash-positions", "sbi-foreign-cash-positions", {
    required_parser_version: "0.3.1",
    updated_at_ms: 1794096000000,
  }),
  ...(["income-payments", "realised-gains"] as const).map((dataset) =>
    policy("sbi-securities", dataset, `sbi-${dataset}`, {
      policy_id: "coverage-v1",
      required_parser_version: "0.1.2",
      updated_at_ms: 1794268800000,
    }),
  ),
  ...(
    [
      "domestic-trade-records",
      "foreign-trade-records",
      "yen-detail-history",
      "foreign-cash-history",
      "account-assets-history",
    ] as const
  ).map((dataset) =>
    policy("sbi-securities", dataset, `sbi-${dataset}`, {
      policy_id: "coverage-v1",
      replaces_previous_on_complete_empty: 0,
      snapshot_selection: 0,
    }),
  ),
  policy("sbi-securities", "delivered-document-pdf", "sbi-delivered-document-metadata", {
    policy_id: "coverage-v1",
    required_parser_version: "1.0.0",
    replaces_previous_on_complete_empty: 0,
    snapshot_selection: 0,
  }),
  ...(
    [
      ["credit-ledger", "myjcb-credit-ledger"],
      ["credit-detail", "myjcb-credit-statement-total"],
      ["credit-past-months", "myjcb-credit-past-month-balances"],
      ["credit-schedule", "myjcb-skip-payment-schedule"],
    ] as const
  ).map(([dataset, parser]) =>
    policy("myjcb", dataset, parser, { snapshot_selection: 0, updated_at_ms: 1794268800000 }),
  ),
  ...(["credit-csv", "credit-ofx", "credit-pdf"] as const).map((dataset) =>
    policy("myjcb", dataset, "myjcb-statement-document-metadata", {
      policy_id: "coverage-v1",
      required_parser_version: "1.0.1",
      replaces_previous_on_complete_empty: 0,
      snapshot_selection: 0,
    }),
  ),
  policy("myjcb", "jpoint-history", "myjcb-jpoint-history", {
    policy_id: "coverage-v1",
    required_parser_version: "1.0.1",
    replaces_previous_on_complete_empty: 0,
    updated_at_ms: 1794268800000,
  }),
  policy("vpass", "credit-snapshot", "vpass-credit-snapshot", {
    policy_id: "coverage-v1",
    required_parser_version: "1.0.1",
    replaces_previous_on_complete_empty: 0,
    updated_at_ms: 1794268800000,
  }),
  policy("myjcb", "debit-detail", "myjcb-debit-ledger", {
    snapshot_selection: 0,
    updated_at_ms: 1794268800000,
  }),
  policy("myjcb", "debit-other-detail", "myjcb-debit-other-statement", {
    snapshot_selection: 0,
    updated_at_ms: 1794268800000,
  }),
  policy("myjcb", "jpoint-balance", "myjcb-jpoint-balance", {
    snapshot_selection: 0,
    updated_at_ms: 1791590400000,
  }),
  policy("sbi-shinsei-bank", "monthly-report-pdf", "sbi-shinsei-monthly-report-metadata", {
    policy_id: "coverage-v1",
    required_parser_version: "1.0.0",
    replaces_previous_on_complete_empty: 0,
    snapshot_selection: 0,
  }),
  policy("sbi-shinsei-bank", "savings-activity", "sbi-shinsei-savings-activity", {
    policy_id: "coverage-v1",
    snapshot_selection: 0,
  }),
  policy("sony-bank", "delivered-document-pdf", "sony-bank-document-metadata", {
    policy_id: "coverage-v1",
    required_parser_version: "1.0.0",
    snapshot_selection: 0,
  }),
  ...SBI_VC_UNIT_POLICIES.map((row) =>
    policy(row.source_id, row.dataset, row.parser_name, {
      policy_id:
        row.parser_name === "sbi-vc-document-metadata" ? "coverage-v1" : "legacy-warning-compat-v1",
      required_parser_version: row.parser_name === "sbi-vc-document-metadata" ? "1.0.0" : null,
      snapshot_selection: row.snapshot_selection,
      replaces_previous_on_complete_empty: row.snapshot_selection === 1 ? 1 : 0,
    }),
  ),
  policy("smbc-bank", "balance-normalized", "smbc-direct-balance", {
    updated_at_ms: 1794268800000,
  }),
  policy("smbc-bank", "transactions-normalized", "smbc-direct-transactions", {
    policy_id: "coverage-v1",
    replaces_previous_on_complete_empty: 0,
    snapshot_selection: 0,
    updated_at_ms: 1794268800000,
  }),
  policy("smbc-bank", "foreign-ordinary-aud-balance", "smbc-foreign-ordinary-balance", {
    policy_id: "coverage-v1",
    required_parser_version: "0.1.2",
    replaces_previous_on_complete_empty: 0,
    updated_at_ms: 1794268800000,
  }),
  policy("smbc-bank", "foreign-ordinary-aud-history", "smbc-foreign-ordinary-history", {
    policy_id: "coverage-v1",
    replaces_previous_on_complete_empty: 0,
    snapshot_selection: 0,
    updated_at_ms: 1794268800000,
  }),
].sort((left, right) =>
  left.parser_name < right.parser_name
    ? -1
    : left.parser_name > right.parser_name
      ? 1
      : left.dataset < right.dataset
        ? -1
        : left.dataset > right.dataset
          ? 1
          : 0,
);
