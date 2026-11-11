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

// The closed default opt-ins of migrations 0080, 0088, 0090, 0095 and 0096.
// This expected catalogue is independent of the SQL read under test: an extra
// source, page, parser, scope, snapshot membership or policy still fails.
export const EXPECTED_UNIT_POLICIES: readonly Policy[] = [
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
  ...SBI_VC_UNIT_POLICIES.map((row) =>
    policy(row.source_id, row.dataset, row.parser_name, {
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
