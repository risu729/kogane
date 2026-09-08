# UI review and column design

Reviewed 2026-09-08. Use the existing React / TanStack stack. Review changes with
the upstream [Vercel web-design-guidelines skill](https://github.com/vercel-labs/agent-skills/blob/main/skills/web-design-guidelines/SKILL.md)
and its [current rules](https://github.com/vercel-labs/web-interface-guidelines/blob/main/command.md).
This is a review workflow, not an executable dependency.

Primary design references:

- [GitHub Primer data table](https://github.com/primer/design/blob/main/content/components/data-table.mdx):
  deliberate column widths, limited columns, wrapping long content, numeric alignment.
- [IBM Carbon data table usage](https://github.com/carbon-design-system/carbon-website/blob/main/src/pages/components/data-table/usage.mdx):
  dedicate main-content space to tables and keep supplementary evidence on detail pages.
- [W3C sortable table](https://github.com/w3c/aria-practices/blob/main/content/patterns/table/examples/sortable-table.html):
  native table semantics, header buttons, a single active aria-sort, keyboard operation.

## Column contract

Transactions prioritize date, description, source/account context, amount, provider
state, and the detail link. Source/account is one identity context, with the source
primary and the full account identifier underneath; sorting this column uses the
source, not the account. Other headers retain their own sort key. Amounts are not
sorted across currencies. The description receives remaining width; identifiers
wrap within bounded cells. Identity values longer than 48 Unicode code points use
a 32-point preview and an explicit native disclosure containing the full, selectable
source/account values. Short values remain fully visible. This keeps unusually long
technical identifiers from making every row tall; the full values are never limited
to hover-only tips, and no financial amount is shortened by this rule.

Balances use source/account, balance kind/unit, amount, explicitly labeled dates,
and the detail link. The history table additionally includes parse lineage. The
date cell always identifies both the source basis date and source observation
time, including missing values; one is never substituted for the other. Date
labels share a column to leave space for comparing balance kinds and amounts.

Do not narrow columns until words become individual characters. On small screens,
keep a readable table and scroll only its labeled, keyboard-focusable region.
Keep numeric values right-aligned with tabular digits. A financial amount must
remain exact and readable without clipping or overlapping another column.

## Domain-specific choices

The generic guidelines do not override financial evidence semantics:

- Keep decimal strings and the exact amount formatter; converting to Number for
  Intl formatting can lose precision.
- Keep recorded dates and offsets. Do not infer a timezone or merge source date
  and collection time into a misleading single timestamp.
- Keep account/search filters in memory, not URLs or persistent browser storage.
- Preserve missing values, unknown provider states, separate currencies, and
  explicitly labeled current/superseded observations.
- Production server pagination/filtering is independent of local table paging.

## Review gate

For each small PR: independent subagent review, fix actionable findings, typecheck,
build both frontend modes, and browser checks for local and central-store modes.
Exercise long provider text, large exact amounts, missing values, keyboard sorting,
and 390px/1280px layouts. Enable auto-merge only after the review is addressed;
required CI remains the merge gate.
