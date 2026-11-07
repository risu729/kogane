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

## Accessibility

Every routed page is audited in Chromium by the browser tests, with no added
dependency: `apps/web/test/a11y-audit.ts` measures the rendered DOM and prints
every finding on the page at once. `auditView` runs it at 1280px with a
keyboard walk, at 390px with target sizes, and at 390px again with every
disclosure open. The feature tests in `apps/web/test` call it on their
rendered views; `experiments/observation-pipeline-local` calls it on the
local and central-store routes (rewards with empty responses), the identity
page and the not-found view, and
checks that every navigation entry moves focus to the new view's `h1`. A
page passes when:

- The document is `lang="ja"`, it has one visible `h1` inside `main`, and no
  heading skips a level below the one before it.
- Every visible control, link and `summary` has an accessible name, from its
  label, text or `aria-label`.
- A link has a destination and a button acts; no generic element plays
  either, and no `tabindex` is positive. Tabbing from the top of the page
  reaches the controls in document order (a radio group is one stop).
- No two landmarks, regions or named groups of one role share a name, and no
  two non-empty alerts or status messages share their text. A table's scroll
  region never repeats its panel's name (panel 取引の記録, region
  取引の記録の表); a table repeated per account carries the account, and a
  card repeated per candidate carries what tells the candidates apart (a
  settlement candidate is named by its billing month and creation time). A pager is
  `Pagination`: a named group whose status speaks its label before the count,
  and a page with two pagers gives each its own label. Retry buttons inside
  alerts are distinct by name.
- Loading and error states carry `role="status"` or `role="alert"`.
- Every visible table has a caption (visually hidden when the panel title
  already says it) and every header cell a `scope`; every `.table-scroll` is
  a named `role="region"` with `tabIndex={0}` at every width. Anything else
  that scrolls is focusable and named, except a landmark whose own links
  reach its content (the sidebar on a short window).
- A badge has words; an icon or graphic is `aria-hidden` or named.
- At 390px the page does not scroll sideways, and every button, form
  control, `summary`, `.button` link and navigation link is at least 24px
  or has no other target within its 24px circle (WCAG 2.5.8). Text links in a
  sentence, cell or breadcrumb are the inline exception.

## Review gate

For each small PR: independent subagent review, fix actionable findings, typecheck,
build both frontend modes, and browser checks for local and central-store modes.
Exercise long provider text, large exact amounts, missing values, keyboard sorting,
and 390px/1280px layouts. Enable auto-merge only after the review is addressed;
required CI remains the merge gate.
