// Frozen bounds of the classic collector: three snapshots, one recent page
// and two historical chains of at most 100 pages. No raw all-type dataset.
export const SBI_VC_UNIT_POLICIES = [
  ...[
    ["sbi-vc-account-margin", "account-margin"],
    ["sbi-vc-cash-balances", "cash-balances"],
    ["sbi-vc-position-summary", "position-summary"],
  ].map(([parser_name, dataset]) => ({
    source_id: "sbi-vc-trade",
    parser_name,
    dataset,
    unit_scope: "unit",
    snapshot_selection: 1,
  })),
  {
    source_id: "sbi-vc-trade",
    parser_name: "sbi-vc-executions",
    dataset: "executions-recent-page-0001",
    unit_scope: "unit",
    snapshot_selection: 0,
  },
  ...Array.from({ length: 100 }, (_, index) => String(index + 1).padStart(4, "0")).flatMap(
    (suffix) => [
      {
        source_id: "sbi-vc-trade",
        parser_name: "sbi-vc-executions",
        dataset: `executions-historical-page-${suffix}`,
        unit_scope: "unit",
        snapshot_selection: 0,
      },
      {
        source_id: "sbi-vc-trade",
        parser_name: "sbi-vc-cashflows",
        dataset: `cashflows-historical-page-${suffix}`,
        unit_scope: "unit",
        snapshot_selection: 0,
      },
    ],
  ),
].sort((left, right) =>
  `${left.parser_name}:${left.dataset}`.localeCompare(`${right.parser_name}:${right.dataset}`),
);
