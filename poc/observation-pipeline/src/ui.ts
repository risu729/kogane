// Read-only evidence browser for the observation-pipeline PoC.
//
// This is a validation tool, not a product UI. Its two jobs are checking that
// parsers produce the observations we think they produce, and walking
// provenance from any observation back to the bytes it came from:
//   observation -> parse run -> fetch artifact -> raw object -> fetch run.
//
// It never writes. Everything above layer B is derived and disposable
// (docs/design.md), so every "latest" / "current" view here is recomputed with
// SQL on each request and nothing is cached, materialized or stored.
//
// Every string that reaches the page — descriptions, counterparties, security
// names, extra_json — was written by a financial institution, not by us. All
// of it is untrusted text and goes through escapeHtml. There is no client-side
// JavaScript, so there is nothing on the page that could act on it either.

import { minorUnitExponent } from "./parsers/util.ts";
import { openStore, readRawObject, type Store } from "./store.ts";

// ── observation kinds ──────────────────────────────────────────────────

// The only place a table name is chosen from request input. The mapping is a
// closed whitelist; the request never reaches SQL as text.
const OBSERVATION_TABLES = {
  transaction: "transaction_observations",
  balance: "balance_observations",
  position: "position_observations",
  valuation: "valuation_observations",
} as const;

type ObservationKind = keyof typeof OBSERVATION_TABLES;

const OBSERVATION_KINDS = Object.keys(OBSERVATION_TABLES) as ObservationKind[];

function isObservationKind(value: string): value is ObservationKind {
  return Object.hasOwn(OBSERVATION_TABLES, value);
}

const COUNTED_TABLES = [
  "sources",
  "fetch_runs",
  "raw_objects",
  "fetch_artifacts",
  "parse_runs",
  "transaction_observations",
  "balance_observations",
  "position_observations",
  "valuation_observations",
] as const;

// ── HTML helpers ───────────────────────────────────────────────────────

export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** Escaped cell text, with an explicit marker for an absent value. */
function cell(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  return escapeHtml(value);
}

function link(href: string, label: unknown): string {
  return `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`;
}

/** Rows carry HTML fragments; every caller escapes provider text itself. */
function htmlTable(headers: readonly string[], rows: readonly string[][]): string {
  if (rows.length === 0) return `<p class="note">No rows.</p>`;
  const head = headers.map((header) => `<th>${escapeHtml(header)}</th>`).join("");
  const body = rows
    .map((row) => `<tr>${row.map((value) => `<td>${value}</td>`).join("")}</tr>`)
    .join("\n");
  return `<table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>`;
}

const NAV = [
  { href: "/", label: "Overview" },
  { href: "/transactions", label: "Transactions" },
  { href: "/balances", label: "Balances" },
  { href: "/positions", label: "Positions" },
  { href: "/artifacts", label: "Artifacts" },
] as const;

const STYLE = `
body { margin: 0 auto; max-width: 74rem; padding: 1.5rem 1rem 4rem;
  background: #fff; color: #16181d;
  font: 14px/1.5 ui-sans-serif, system-ui, "Helvetica Neue", sans-serif; }
h1 { font-size: 1.25rem; margin: 0 0 .25rem; }
h2 { font-size: 1.05rem; margin: 2rem 0 .5rem; }
h3 { font-size: .95rem; margin: 1.25rem 0 .35rem; }
nav { margin: 0 0 .25rem; }
nav a { margin-right: 1rem; }
nav .here { font-weight: 600; }
a { color: #14507d; }
p.note { color: #5b6068; margin: .25rem 0 1rem; }
table { border-collapse: collapse; width: 100%; margin: .5rem 0 1rem;
  font-variant-numeric: tabular-nums; }
th, td { border-bottom: 1px solid #dcdfe4; padding: .3rem .5rem;
  text-align: left; vertical-align: top; }
th { background: #f4f5f7; font-weight: 600; white-space: nowrap; }
td.num { text-align: right; white-space: nowrap; }
td.mono, pre, code { font-family: ui-monospace, "SFMono-Regular", Menlo, monospace; }
pre { background: #f4f5f7; border: 1px solid #dcdfe4; padding: .6rem;
  overflow-x: auto; font-size: 12px; }
.mark { color: #8a4b00; white-space: nowrap; }
.trail li { margin-bottom: .35rem; }
`;

function page(title: string, activeHref: string, body: string): Response {
  const nav = NAV.map((item) =>
    item.href === activeHref
      ? `<a class="here" href="${item.href}">${item.label}</a>`
      : `<a href="${item.href}">${item.label}</a>`,
  ).join("");
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} — Kogane evidence browser</title>
<style>${STYLE}</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
<nav>${nav}</nav>
<p class="note">Read-only evidence browser. Every current-state view is derived
on request and disposable; observations and raw evidence are append-only.</p>
${body}
</body>
</html>
`;
  return new Response(html, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// ── amount formatting ──────────────────────────────────────────────────

function groupDigits(digits: string): string {
  let grouped = "";
  for (let end = digits.length; end > 0; end -= 3) {
    const start = Math.max(0, end - 3);
    grouped = digits.slice(start, end) + (grouped === "" ? "" : `,${grouped}`);
  }
  return grouped === "" ? "0" : grouped;
}

/**
 * Format an amount for display. Minor units are formatted by string and BigInt
 * manipulation only: an amount never passes through floating point, not even
 * on its way to a screen. When the instrument has no known minor-unit exponent
 * the integer is shown as-is and labelled, rather than guessing a scale. When
 * amount_minor is NULL the stored decimal string is shown verbatim.
 */
export function formatAmount(
  amountMinor: number | bigint | null | undefined,
  unit: string | null | undefined,
  amountText?: string | null,
): string {
  const suffix = unit ? ` ${unit}` : "";
  if (amountMinor === null || amountMinor === undefined) {
    if (amountText === null || amountText === undefined || amountText === "") return "";
    return `${amountText}${suffix}`;
  }
  if (typeof amountMinor === "number" && !Number.isInteger(amountMinor)) {
    return `${String(amountMinor)}${suffix}`; // not a minor-unit integer; show as stored
  }
  const value = BigInt(amountMinor);
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString();
  const exponent = unit ? minorUnitExponent(unit) : undefined;
  if (exponent === undefined) {
    return `${negative ? "-" : ""}${groupDigits(digits)}${suffix} (minor units)`;
  }
  const padded = digits.padStart(exponent + 1, "0");
  const whole = padded.slice(0, padded.length - exponent);
  const fraction = exponent > 0 ? padded.slice(padded.length - exponent) : "";
  const body = fraction === "" ? groupDigits(whole) : `${groupDigits(whole)}.${fraction}`;
  return `${negative ? "-" : ""}${body}${suffix}`;
}

function warningCount(warningsJson: string | null): number {
  if (!warningsJson) return 0;
  try {
    const parsed: unknown = JSON.parse(warningsJson);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

function warningList(warningsJson: string | null): string[] {
  if (!warningsJson) return [];
  try {
    const parsed: unknown = JSON.parse(warningsJson);
    return Array.isArray(parsed) ? parsed.map((item) => String(item)) : [];
  } catch {
    return [warningsJson];
  }
}

function supersededMark(supersededBy: number | null): string {
  return supersededBy === null
    ? ""
    : ` <span class="mark">superseded by run ${supersededBy}</span>`;
}

function shortSha(sha256: string): string {
  return sha256.slice(0, 12);
}

// ── row shapes ─────────────────────────────────────────────────────────

interface ParseRunRow {
  id: number;
  fetch_artifact_id: number;
  parser_name: string;
  parser_version: string;
  parsed_at: string;
  status: string;
  error: string | null;
  warnings_json: string | null;
  superseded_by_parse_run_id: number | null;
}

interface ObservationSummary {
  kind: ObservationKind;
  id: number;
  sourceAccount: string;
  asOf: string | null;
  amount: string;
  label: string;
}

/**
 * Every observation of one parse run, normalized to a common display shape so
 * a re-parse can be compared against the run it superseded. Four queries per
 * parse run: fine at PoC scale, and it keeps each kind's own columns visible.
 */
function observationsForParseRun(store: Store, parseRunId: number): ObservationSummary[] {
  const summaries: ObservationSummary[] = [];

  const transactions = store.db
    .query(
      `SELECT id, source_account, as_of, amount_minor, currency, description
       FROM transaction_observations WHERE parse_run_id = ?1 ORDER BY id`,
    )
    .all(parseRunId) as {
    id: number;
    source_account: string;
    as_of: string | null;
    amount_minor: number | null;
    currency: string | null;
    description: string | null;
  }[];
  for (const row of transactions) {
    summaries.push({
      kind: "transaction",
      id: row.id,
      sourceAccount: row.source_account,
      asOf: row.as_of,
      amount: formatAmount(row.amount_minor, row.currency),
      label: row.description ?? "",
    });
  }

  const balances = store.db
    .query(
      `SELECT id, source_account, metric, amount_minor, amount_text, instrument, as_of
       FROM balance_observations WHERE parse_run_id = ?1 ORDER BY id`,
    )
    .all(parseRunId) as {
    id: number;
    source_account: string;
    metric: string;
    amount_minor: number | null;
    amount_text: string | null;
    instrument: string;
    as_of: string | null;
  }[];
  for (const row of balances) {
    summaries.push({
      kind: "balance",
      id: row.id,
      sourceAccount: row.source_account,
      asOf: row.as_of,
      amount: formatAmount(row.amount_minor, row.instrument, row.amount_text),
      label: row.metric,
    });
  }

  const positions = store.db
    .query(
      `SELECT id, source_account, security_code, security_name, quantity_text, as_of
       FROM position_observations WHERE parse_run_id = ?1 ORDER BY id`,
    )
    .all(parseRunId) as {
    id: number;
    source_account: string;
    security_code: string;
    security_name: string | null;
    quantity_text: string;
    as_of: string | null;
  }[];
  for (const row of positions) {
    summaries.push({
      kind: "position",
      id: row.id,
      sourceAccount: row.source_account,
      asOf: row.as_of,
      amount: `${row.quantity_text} units`,
      label:
        row.security_name === null
          ? row.security_code
          : `${row.security_code} ${row.security_name}`,
    });
  }

  const valuations = store.db
    .query(
      `SELECT id, source_account, subject, metric, amount_minor, amount_text, currency, as_of
       FROM valuation_observations WHERE parse_run_id = ?1 ORDER BY id`,
    )
    .all(parseRunId) as {
    id: number;
    source_account: string;
    subject: string;
    metric: string;
    amount_minor: number | null;
    amount_text: string | null;
    currency: string;
    as_of: string | null;
  }[];
  for (const row of valuations) {
    summaries.push({
      kind: "valuation",
      id: row.id,
      sourceAccount: row.source_account,
      asOf: row.as_of,
      amount: formatAmount(row.amount_minor, row.currency, row.amount_text),
      label: `${row.subject} ${row.metric}`,
    });
  }

  return summaries;
}

function observationRows(summaries: readonly ObservationSummary[]): string {
  return htmlTable(
    ["observation", "kind", "account", "as_of", "amount", "detail"],
    summaries.map((summary) => [
      link(`/observations/${summary.kind}/${summary.id}`, `#${summary.id}`),
      cell(summary.kind),
      cell(summary.sourceAccount),
      cell(summary.asOf),
      `<span class="num">${cell(summary.amount)}</span>`,
      cell(summary.label),
    ]),
  );
}

// ── pages ──────────────────────────────────────────────────────────────

function renderOverview(store: Store): Response {
  const counts = COUNTED_TABLES.map((table) => {
    // Table names are compile-time literals, never request input.
    const row = store.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return [escapeHtml(table), `<span class="num">${row.n}</span>`];
  });

  const sources = store.db
    .query(
      `SELECT s.id, s.provider, s.ingestion,
              COUNT(a.id) AS artifact_count
       FROM sources s
       LEFT JOIN fetch_artifacts a ON a.source_id = s.id
       GROUP BY s.id, s.provider, s.ingestion
       ORDER BY s.id`,
    )
    .all() as {
    id: string;
    provider: string;
    ingestion: string;
    artifact_count: number;
  }[];

  const fetchRuns = store.db
    .query(
      `SELECT id, source_id, tool, external_run_id, status, started_at, completed_at
       FROM fetch_runs ORDER BY id`,
    )
    .all() as {
    id: number;
    source_id: string;
    tool: string;
    external_run_id: string | null;
    status: string;
    started_at: string;
    completed_at: string | null;
  }[];

  const parseRuns = store.db
    .query(
      `SELECT id, fetch_artifact_id, parser_name, parser_version, parsed_at, status,
              error, warnings_json, superseded_by_parse_run_id
       FROM parse_runs ORDER BY id`,
    )
    .all() as ParseRunRow[];

  const body = `
<h2>Row counts</h2>
${htmlTable(["table", "rows"], counts)}

<h2>Sources</h2>
${htmlTable(
  ["source", "provider", "ingestion", "artifacts"],
  sources.map((source) => [
    cell(source.id),
    cell(source.provider),
    cell(source.ingestion),
    `<span class="num">${source.artifact_count}</span>`,
  ]),
)}

<h2>Fetch runs</h2>
<p class="note">Layer A. Append-only: a run that happened stays recorded,
whatever it returned.</p>
${htmlTable(
  ["run", "source", "tool", "external_run_id", "status", "started_at", "completed_at"],
  fetchRuns.map((run) => [
    `<span class="num">${run.id}</span>`,
    cell(run.source_id),
    cell(run.tool),
    cell(run.external_run_id),
    cell(run.status),
    cell(run.started_at),
    cell(run.completed_at),
  ]),
)}

<h2>Parse runs</h2>
<p class="note">Layer B lineage. A re-parse with a newer parser version marks
the older run superseded; no observation row is ever changed or removed.</p>
${htmlTable(
  ["run", "artifact", "parser", "status", "warnings", "parsed_at", "lineage"],
  parseRuns.map((run) => [
    `<span class="num">${run.id}</span>`,
    link(`/artifacts/${run.fetch_artifact_id}`, `#${run.fetch_artifact_id}`),
    cell(`${run.parser_name}@${run.parser_version}`),
    cell(run.status),
    `<span class="num">${warningCount(run.warnings_json)}</span>`,
    cell(run.parsed_at),
    run.superseded_by_parse_run_id === null
      ? "current"
      : `<span class="mark">superseded by run ${run.superseded_by_parse_run_id}</span>`,
  ]),
)}
`;
  return page("Overview", "/", body);
}

function renderTransactions(store: Store): Response {
  const rows = store.db
    .query(
      // An error parse run is never superseded, so the current predicate has
      // to exclude it explicitly as well as checking supersession.
      `SELECT t.id, fa.source_id, t.source_account, t.as_of, t.amount_minor, t.amount_text,
              t.currency, t.description, t.counterparty, t.external_id, t.status,
              p.parser_name, p.parser_version
       FROM transaction_observations t
       JOIN parse_runs p ON p.id = t.parse_run_id
       JOIN fetch_artifacts fa ON fa.id = p.fetch_artifact_id
       WHERE p.superseded_by_parse_run_id IS NULL AND p.status = 'ok'
       ORDER BY COALESCE(t.as_of, '') DESC, t.id DESC`,
    )
    .all() as {
    id: number;
    source_id: string;
    amount_text: string | null;
    source_account: string;
    as_of: string | null;
    amount_minor: number | null;
    currency: string | null;
    description: string | null;
    counterparty: string | null;
    external_id: string | null;
    status: string | null;
    parser_name: string;
    parser_version: string;
  }[];

  const body = `
<h2>Transaction observations</h2>
<p class="note">Rows from superseded parse runs are hidden here and remain
readable through their artifact. external_id is what the provider said, not a
logical identity: a pending row and its posted row are related by a link, never
by an update.</p>
${htmlTable(
  ["observation", "source", "account", "as_of", "amount", "currency", "description", "counterparty", "external_id", "parser"],
  rows.map((row) => [
    link(`/observations/transaction/${row.id}`, `#${row.id}`),
    cell(row.source_id),
    cell(row.source_account),
    cell(row.as_of),
    `<span class="num">${cell(formatAmount(row.amount_minor, row.currency, row.amount_text))}</span>`,
    cell(row.currency),
    cell(row.description),
    cell(row.counterparty),
    cell(row.external_id),
    cell(`${row.parser_name}@${row.parser_version}`),
  ]),
)}
`;
  return page("Transactions", "/transactions", body);
}

function renderBalances(store: Store): Response {
  // Window function over non-superseded observations, evaluated on this
  // request. There is no "current balance" anywhere in the database.
  // `source_account` is only the provider's own label, so it does not
  // identify an institution: two sources can both call an account "main".
  // The source is carried through the join and into the partition key, or one
  // institution's balance would silently hide the other's.
  const latest = store.db
    .query(
      `SELECT id, source_id, source_account, metric, instrument, amount_minor,
              amount_text, as_of, observed_at, parser
       FROM (
         SELECT b.id, fa.source_id, b.source_account, b.metric, b.instrument,
                b.amount_minor, b.amount_text, b.as_of, b.observed_at,
                p.parser_name || '@' || p.parser_version AS parser,
                ROW_NUMBER() OVER (
                  PARTITION BY fa.source_id, b.source_account, b.metric, b.instrument
                  ORDER BY COALESCE(b.as_of, b.observed_at, '') DESC, b.id DESC
                ) AS rank_in_group
         FROM balance_observations b
         JOIN parse_runs p ON p.id = b.parse_run_id
         JOIN fetch_artifacts fa ON fa.id = p.fetch_artifact_id
         WHERE p.superseded_by_parse_run_id IS NULL AND p.status = 'ok'
       )
       WHERE rank_in_group = 1
       ORDER BY source_id, source_account, metric, instrument`,
    )
    .all() as {
    id: number;
    source_id: string;
    source_account: string;
    metric: string;
    instrument: string;
    amount_minor: number | null;
    amount_text: string | null;
    as_of: string | null;
    observed_at: string | null;
    parser: string;
  }[];

  const history = store.db
    .query(
      `SELECT b.id, b.source_account, b.metric, b.instrument, b.amount_minor,
              b.amount_text, b.as_of, b.observed_at,
              p.parser_name, p.parser_version, p.superseded_by_parse_run_id
       FROM balance_observations b
       JOIN parse_runs p ON p.id = b.parse_run_id
       ORDER BY COALESCE(b.as_of, b.observed_at, '') DESC, b.id DESC`,
    )
    .all() as {
    id: number;
    source_account: string;
    metric: string;
    instrument: string;
    amount_minor: number | null;
    amount_text: string | null;
    as_of: string | null;
    observed_at: string | null;
    parser_name: string;
    parser_version: string;
    superseded_by_parse_run_id: number | null;
  }[];

  const body = `
<h2>Latest per (source, source_account, metric, instrument)</h2>
<p class="note">Derived on request. This table is computed by a window function
over the non-superseded observations below and is never stored: a balance is a
measurement (subject, metric, value, as_of, source), not a column on an
account, and each metric an institution reports is its own measurement.</p>
${htmlTable(
  ["observation", "source", "account", "metric", "instrument", "amount", "as_of", "observed_at", "parser"],
  latest.map((row) => [
    link(`/observations/balance/${row.id}`, `#${row.id}`),
    cell(row.source_id),
    cell(row.source_account),
    cell(row.metric),
    cell(row.instrument),
    `<span class="num">${cell(formatAmount(row.amount_minor, row.instrument, row.amount_text))}</span>`,
    cell(row.as_of),
    cell(row.observed_at),
    cell(row.parser),
  ]),
)}

<h2>Full history</h2>
<p class="note">Every balance observation ever recorded, including those from
superseded parse runs, which are marked. Nothing here is ever updated or
deleted.</p>
${htmlTable(
  ["observation", "account", "metric", "instrument", "amount", "as_of", "observed_at", "parser", "lineage"],
  history.map((row) => [
    link(`/observations/balance/${row.id}`, `#${row.id}`),
    cell(row.source_account),
    cell(row.metric),
    cell(row.instrument),
    `<span class="num">${cell(formatAmount(row.amount_minor, row.instrument, row.amount_text))}</span>`,
    cell(row.as_of),
    cell(row.observed_at),
    cell(`${row.parser_name}@${row.parser_version}`),
    row.superseded_by_parse_run_id === null
      ? "current"
      : `<span class="mark">superseded by run ${row.superseded_by_parse_run_id}</span>`,
  ]),
)}
`;
  return page("Balances", "/balances", body);
}

function renderPositions(store: Store): Response {
  const positions = store.db
    .query(
      `SELECT po.id, fa.source_id, po.source_account, po.security_code, po.security_name,
              po.market, po.quantity_text, po.quantity_scale, po.currency, po.as_of,
              po.observed_at, p.parser_name, p.parser_version
       FROM position_observations po
       JOIN parse_runs p ON p.id = po.parse_run_id
       JOIN fetch_artifacts fa ON fa.id = p.fetch_artifact_id
       WHERE p.superseded_by_parse_run_id IS NULL AND p.status = 'ok'
       ORDER BY fa.source_id, po.source_account, po.security_code, po.id`,
    )
    .all() as {
    id: number;
    source_id: string;
    source_account: string;
    security_code: string;
    security_name: string | null;
    market: string | null;
    quantity_text: string;
    quantity_scale: number;
    currency: string | null;
    as_of: string | null;
    observed_at: string | null;
    parser_name: string;
    parser_version: string;
  }[];

  const valuations = store.db
    .query(
      `SELECT v.id, fa.source_id, v.source_account, v.subject, v.metric, v.amount_minor,
              v.amount_text, v.currency, v.as_of, v.observed_at
       FROM valuation_observations v
       JOIN parse_runs p ON p.id = v.parse_run_id
       JOIN fetch_artifacts fa ON fa.id = p.fetch_artifact_id
       WHERE p.superseded_by_parse_run_id IS NULL AND p.status = 'ok'
       ORDER BY fa.source_id, v.source_account, v.subject, v.metric, v.id`,
    )
    .all() as {
    id: number;
    source_id: string;
    source_account: string;
    subject: string;
    metric: string;
    amount_minor: number | null;
    amount_text: string | null;
    currency: string;
    as_of: string | null;
    observed_at: string | null;
  }[];

  // Provider-reported valuations, grouped by the (source, account, subject)
  // triple the position identifies. The source belongs in the key: security
  // codes are not globally unique — numeric TSE codes are shared across every
  // Japanese broker — so without it one broker's valuation would attach to
  // another broker's position. Each metric keeps the currency the provider
  // stated; nothing is summed and nothing is converted.
  const bySubject = new Map<string, typeof valuations>();
  const subjectKey = (source: string, account: string, subject: string): string =>
    `${source}\u0000${account}\u0000${subject}`;
  for (const valuation of valuations) {
    const key = subjectKey(
      valuation.source_id,
      valuation.source_account,
      valuation.subject,
    );
    const bucket = bySubject.get(key);
    if (bucket) bucket.push(valuation);
    else bySubject.set(key, [valuation]);
  }

  const sections = positions.map((position) => {
    const matching =
      bySubject.get(
        subjectKey(position.source_id, position.source_account, position.security_code),
      ) ?? [];
    const heading = `${position.source_id} · ${position.security_code}${
      position.security_name === null ? "" : ` — ${position.security_name}`
    }`;
    return `
<h3>${escapeHtml(heading)}</h3>
${htmlTable(
  ["observation", "source", "account", "market", "quantity", "scale", "currency", "as_of", "parser"],
  [
    [
      link(`/observations/position/${position.id}`, `#${position.id}`),
      cell(position.source_id),
      cell(position.source_account),
      cell(position.market),
      `<span class="num">${cell(position.quantity_text)}</span>`,
      `<span class="num">${position.quantity_scale}</span>`,
      cell(position.currency),
      cell(position.as_of),
      cell(`${position.parser_name}@${position.parser_version}`),
    ],
  ],
)}
${
  matching.length === 0
    ? `<p class="note">No provider-reported valuation observation matches this position.</p>`
    : htmlTable(
        ["valuation", "metric", "amount", "currency", "as_of", "observed_at"],
        matching.map((valuation) => [
          link(`/observations/valuation/${valuation.id}`, `#${valuation.id}`),
          cell(valuation.metric),
          `<span class="num">${cell(
            formatAmount(valuation.amount_minor, valuation.currency, valuation.amount_text),
          )}</span>`,
          cell(valuation.currency),
          cell(valuation.as_of),
          cell(valuation.observed_at),
        ]),
      )
}`;
  });

  const body = `
<h2>Position observations</h2>
<p class="note">Non-superseded positions, each shown with the valuations the
provider itself reported for the same (account, security). Quantities are
decimal strings with an explicit scale, never floating point. Each valuation
metric keeps its own currency: figures are listed side by side, never summed
and never converted. Kogane's own computed valuations are a later derived
layer and do not appear here.</p>
${positions.length === 0 ? `<p class="note">No rows.</p>` : sections.join("\n")}
`;
  return page("Positions", "/positions", body);
}

function renderObservation(store: Store, kind: ObservationKind, id: number): Response {
  const table = OBSERVATION_TABLES[kind];
  const row = store.db
    .query(`SELECT * FROM ${table} WHERE id = ?1`)
    .get(id) as Record<string, unknown> | null;
  if (!row) return notFound(`no ${kind} observation with id ${id}`);

  const columns = Object.entries(row)
    .filter(([column]) => column !== "extra_json")
    .map(([column, value]) => [`<code>${escapeHtml(column)}</code>`, cell(value)]);

  const extraJson = typeof row["extra_json"] === "string" ? row["extra_json"] : "";
  let extraPretty = extraJson;
  try {
    extraPretty = JSON.stringify(JSON.parse(extraJson), null, 2);
  } catch {
    // Not valid JSON: show exactly what is stored rather than inventing shape.
  }

  const amountUnit =
    typeof row["currency"] === "string"
      ? row["currency"]
      : typeof row["instrument"] === "string"
        ? row["instrument"]
        : null;
  const amountMinor = typeof row["amount_minor"] === "number" ? row["amount_minor"] : null;
  const amountText = typeof row["amount_text"] === "string" ? row["amount_text"] : null;
  const formatted =
    amountMinor === null && amountText === null
      ? ""
      : formatAmount(amountMinor, amountUnit, amountText);

  const parseRunId = typeof row["parse_run_id"] === "number" ? row["parse_run_id"] : 0;
  const provenance = store.db
    .query(
      `SELECT p.id AS parse_run_id, p.parser_name, p.parser_version, p.parsed_at,
              p.status AS parse_status, p.error, p.warnings_json,
              p.superseded_by_parse_run_id,
              a.id AS artifact_id, a.source_id, a.dataset, a.url, a.mime, a.fetched_at,
              r.sha256, r.size, r.content_type,
              f.id AS fetch_run_id, f.tool, f.external_run_id,
              f.status AS fetch_status, f.started_at, f.completed_at
       FROM parse_runs p
       JOIN fetch_artifacts a ON a.id = p.fetch_artifact_id
       JOIN raw_objects r ON r.sha256 = a.sha256
       JOIN fetch_runs f ON f.id = a.fetch_run_id
       WHERE p.id = ?1`,
    )
    .get(parseRunId) as
    | {
        parse_run_id: number;
        parser_name: string;
        parser_version: string;
        parsed_at: string;
        parse_status: string;
        error: string | null;
        warnings_json: string | null;
        superseded_by_parse_run_id: number | null;
        artifact_id: number;
        source_id: string;
        dataset: string | null;
        url: string | null;
        mime: string;
        fetched_at: string;
        sha256: string;
        size: number;
        content_type: string;
        fetch_run_id: number;
        tool: string;
        external_run_id: string | null;
        fetch_status: string;
        started_at: string;
        completed_at: string | null;
      }
    | null;

  const warnings = provenance ? warningList(provenance.warnings_json) : [];
  const trail = provenance
    ? `
<ul class="trail">
  <li><strong>Observation</strong> — ${escapeHtml(kind)} #${id}, raw locator
    <code>${cell(row["raw_locator"])}</code></li>
  <li><strong>Parse run</strong> — #${provenance.parse_run_id}
    <code>${escapeHtml(provenance.parser_name)}@${escapeHtml(provenance.parser_version)}</code>,
    parsed_at ${cell(provenance.parsed_at)}, status ${cell(provenance.parse_status)},
    ${warnings.length} warning(s)${supersededMark(provenance.superseded_by_parse_run_id)}
    ${provenance.error === null ? "" : `<br>error: ${escapeHtml(provenance.error)}`}
    ${
      warnings.length === 0
        ? ""
        : `<pre>${escapeHtml(warnings.join("\n"))}</pre>`
    }</li>
  <li><strong>Fetch artifact</strong> —
    ${link(`/artifacts/${provenance.artifact_id}`, `#${provenance.artifact_id}`)},
    source ${cell(provenance.source_id)}, dataset ${cell(provenance.dataset)},
    url ${cell(provenance.url)}, mime ${cell(provenance.mime)},
    fetched_at ${cell(provenance.fetched_at)}</li>
  <li><strong>Raw object</strong> —
    <code>${escapeHtml(provenance.sha256)}</code>, ${provenance.size} bytes,
    ${cell(provenance.content_type)},
    ${link(`/raw/${provenance.sha256}`, "raw bytes")}</li>
  <li><strong>Fetch run</strong> — #${provenance.fetch_run_id},
    tool ${cell(provenance.tool)},
    external_run_id ${cell(provenance.external_run_id)},
    status ${cell(provenance.fetch_status)},
    started_at ${cell(provenance.started_at)},
    completed_at ${cell(provenance.completed_at)}</li>
</ul>`
    : `<p class="note">No parse run is joinable from this observation.</p>`;

  const body = `
<h2>${escapeHtml(kind)} observation #${id}</h2>
${
  formatted === ""
    ? ""
    : `<p class="note">Formatted amount: <strong>${escapeHtml(formatted)}</strong></p>`
}
${htmlTable(["column", "value"], columns)}

<h2>extra_json</h2>
<p class="note">Everything the source said that the typed columns do not carry.
Kept verbatim so a later parser version can use it without re-fetching.</p>
<pre>${escapeHtml(extraPretty)}</pre>

<h2>Provenance</h2>
${trail}
`;
  return page(`Observation ${kind} #${id}`, "/", body);
}

function renderArtifacts(store: Store): Response {
  const rows = store.db
    .query(
      `SELECT a.id, a.source_id, a.dataset, a.url, a.mime, a.fetched_at, a.sha256,
              (SELECT COUNT(*) FROM parse_runs p WHERE p.fetch_artifact_id = a.id)
                AS parse_run_count,
              (SELECT COUNT(*) FROM transaction_observations t
                 JOIN parse_runs p ON p.id = t.parse_run_id
                WHERE p.fetch_artifact_id = a.id) AS transaction_count,
              (SELECT COUNT(*) FROM balance_observations b
                 JOIN parse_runs p ON p.id = b.parse_run_id
                WHERE p.fetch_artifact_id = a.id) AS balance_count,
              (SELECT COUNT(*) FROM position_observations o
                 JOIN parse_runs p ON p.id = o.parse_run_id
                WHERE p.fetch_artifact_id = a.id) AS position_count,
              (SELECT COUNT(*) FROM valuation_observations v
                 JOIN parse_runs p ON p.id = v.parse_run_id
                WHERE p.fetch_artifact_id = a.id) AS valuation_count
       FROM fetch_artifacts a
       ORDER BY a.id`,
    )
    .all() as {
    id: number;
    source_id: string;
    dataset: string | null;
    url: string | null;
    mime: string;
    fetched_at: string;
    sha256: string;
    parse_run_count: number;
    transaction_count: number;
    balance_count: number;
    position_count: number;
    valuation_count: number;
  }[];

  const body = `
<h2>Fetch artifacts</h2>
<p class="note">One row per thing a fetch retrieved. Observation counts include
every parse run over the artifact, superseded ones included.</p>
${htmlTable(
  ["artifact", "source", "dataset", "mime", "fetched_at", "sha256", "parse runs", "txn", "bal", "pos", "val", "bytes"],
  rows.map((row) => [
    link(`/artifacts/${row.id}`, `#${row.id}`),
    cell(row.source_id),
    cell(row.dataset ?? row.url),
    cell(row.mime),
    cell(row.fetched_at),
    `<code>${escapeHtml(shortSha(row.sha256))}</code>`,
    `<span class="num">${row.parse_run_count}</span>`,
    `<span class="num">${row.transaction_count}</span>`,
    `<span class="num">${row.balance_count}</span>`,
    `<span class="num">${row.position_count}</span>`,
    `<span class="num">${row.valuation_count}</span>`,
    link(`/raw/${row.sha256}`, "raw"),
  ]),
)}
`;
  return page("Artifacts", "/artifacts", body);
}

function renderArtifact(store: Store, id: number): Response {
  const artifact = store.db
    .query(
      `SELECT a.id, a.source_id, a.dataset, a.url, a.method, a.http_status, a.mime,
              a.fetched_at, a.sha256, r.size, r.content_type, r.blob_key,
              f.id AS fetch_run_id, f.tool, f.external_run_id, f.status AS fetch_status,
              f.started_at, f.completed_at
       FROM fetch_artifacts a
       JOIN raw_objects r ON r.sha256 = a.sha256
       JOIN fetch_runs f ON f.id = a.fetch_run_id
       WHERE a.id = ?1`,
    )
    .get(id) as
    | {
        id: number;
        source_id: string;
        dataset: string | null;
        url: string | null;
        method: string | null;
        http_status: number | null;
        mime: string;
        fetched_at: string;
        sha256: string;
        size: number;
        content_type: string;
        blob_key: string;
        fetch_run_id: number;
        tool: string;
        external_run_id: string | null;
        fetch_status: string;
        started_at: string;
        completed_at: string | null;
      }
    | null;
  if (!artifact) return notFound(`no fetch artifact with id ${id}`);

  const parseRuns = store.db
    .query(
      `SELECT id, fetch_artifact_id, parser_name, parser_version, parsed_at, status,
              error, warnings_json, superseded_by_parse_run_id
       FROM parse_runs WHERE fetch_artifact_id = ?1 ORDER BY id`,
    )
    .all(id) as ParseRunRow[];

  const parseRunSections = parseRuns.map((run) => {
    const summaries = observationsForParseRun(store, run.id);
    const counts = OBSERVATION_KINDS.map(
      (kind) => `${kind}: ${summaries.filter((item) => item.kind === kind).length}`,
    ).join(", ");
    const warnings = warningList(run.warnings_json);
    return `
<h3>Parse run #${run.id} —
  <code>${escapeHtml(run.parser_name)}@${escapeHtml(run.parser_version)}</code>${supersededMark(
    run.superseded_by_parse_run_id,
  )}</h3>
<p class="note">parsed_at ${cell(run.parsed_at)}, status ${cell(run.status)},
${escapeHtml(counts)}${run.error === null ? "" : `, error: ${escapeHtml(run.error)}`}</p>
${warnings.length === 0 ? "" : `<pre>${escapeHtml(warnings.join("\n"))}</pre>`}
${observationRows(summaries)}`;
  });

  const body = `
<h2>Fetch artifact #${artifact.id}</h2>
${htmlTable(
  ["field", "value"],
  [
    ["source", cell(artifact.source_id)],
    ["dataset", cell(artifact.dataset)],
    ["url", cell(artifact.url)],
    ["method", cell(artifact.method)],
    ["http_status", cell(artifact.http_status)],
    ["mime", cell(artifact.mime)],
    ["fetched_at", cell(artifact.fetched_at)],
    ["sha256", `<code>${escapeHtml(artifact.sha256)}</code>`],
    ["size", `${artifact.size} bytes`],
    ["content_type", cell(artifact.content_type)],
    ["blob_key", `<code>${escapeHtml(artifact.blob_key)}</code>`],
    ["raw bytes", link(`/raw/${artifact.sha256}`, `/raw/${shortSha(artifact.sha256)}…`)],
    [
      "fetch run",
      `#${artifact.fetch_run_id}, tool ${cell(artifact.tool)}, external_run_id ${cell(
        artifact.external_run_id,
      )}, status ${cell(artifact.fetch_status)}, started_at ${cell(
        artifact.started_at,
      )}, completed_at ${cell(artifact.completed_at)}`,
    ],
  ],
)}

<h2>Parse runs over these bytes</h2>
<p class="note">All parse runs, superseded ones included: the observations a
retired parser version produced stay readable here, which is how a re-parse can
be compared against what it replaced.</p>
${parseRuns.length === 0 ? `<p class="note">No parse run has read this artifact.</p>` : parseRunSections.join("\n")}
`;
  return page(`Artifact #${artifact.id}`, "/artifacts", body);
}

/** The evidence itself: stored bytes, stored content type, no reformatting. */
function renderRaw(store: Store, sha256: string): Response {
  if (!/^[0-9a-f]{64}$/u.test(sha256)) return notFound(`not a sha256 digest: ${sha256}`);
  const row = store.db
    .query("SELECT sha256, content_type FROM raw_objects WHERE sha256 = ?1")
    .get(sha256) as { sha256: string; content_type: string } | null;
  if (!row) return notFound(`no raw object with sha256 ${sha256}`);
  let bytes: Uint8Array;
  try {
    bytes = readRawObject(store, row.sha256);
  } catch (error) {
    return new Response(
      `raw object ${row.sha256} is recorded but unreadable: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
      { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } },
    );
  }
  // The bytes go out verbatim, but they are never treated as an active
  // document. Captured evidence can be attacker-authored HTML: rendered
  // inline it would run its own script in this origin, which can read every
  // other page here — the whole financial dataset. `sandbox` denies it an
  // origin and scripts, and `nosniff` stops the browser inferring a type the
  // source never declared.
  //
  // A stored content type is provider-derived and reaches a header, so it is
  // validated first: a CR or LF in it would otherwise throw out of the
  // handler as an unhandled 500.
  const declared = row.content_type.trim();
  const contentType = /^[ -~]+$/u.test(declared)
    ? declared
    : "application/octet-stream";
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": contentType,
      "content-disposition": "inline",
      "content-security-policy": "sandbox",
      "x-content-type-options": "nosniff",
      "x-kogane-sha256": row.sha256,
    },
  });
}

function notFound(message: string): Response {
  return new Response(`404 not found: ${message}\n`, {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function parseId(segment: string): number | undefined {
  if (!/^\d+$/u.test(segment)) return undefined;
  const id = Number.parseInt(segment, 10);
  return Number.isSafeInteger(id) ? id : undefined;
}

// ── router ─────────────────────────────────────────────────────────────

/**
 * A pure request-to-response function: it binds no port, holds no state and
 * writes nothing, so a test can call it directly.
 */
export function createUiHandler(store: Store): (request: Request) => Response {
  return (request: Request): Response => {
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("405 method not allowed: this browser is read-only\n", {
        status: 405,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    const segments = new URL(request.url).pathname.split("/").filter((part) => part !== "");
    const [first, second, third] = segments;

    if (first === undefined) return renderOverview(store);
    if (first === "transactions" && segments.length === 1) return renderTransactions(store);
    if (first === "balances" && segments.length === 1) return renderBalances(store);
    if (first === "positions" && segments.length === 1) return renderPositions(store);
    if (first === "artifacts" && segments.length === 1) return renderArtifacts(store);
    if (first === "artifacts" && segments.length === 2 && second !== undefined) {
      const id = parseId(second);
      if (id === undefined) return notFound(`not an artifact id: ${second}`);
      return renderArtifact(store, id);
    }
    if (
      first === "observations" &&
      segments.length === 3 &&
      second !== undefined &&
      third !== undefined
    ) {
      if (!isObservationKind(second)) return notFound(`unknown observation kind: ${second}`);
      const id = parseId(third);
      if (id === undefined) return notFound(`not an observation id: ${third}`);
      return renderObservation(store, second, id);
    }
    if (first === "raw" && segments.length === 2 && second !== undefined) {
      return renderRaw(store, second);
    }
    return notFound(new URL(request.url).pathname);
  };
}

if (import.meta.main) {
  const store = openStore();
  // Loopback only, and deliberately so: this server has no authentication and
  // renders real financial evidence once a capture is loaded. It must never be
  // reachable from a shared or forwarded interface.
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: Number(process.env["PORT"] ?? 8787),
    fetch: createUiHandler(store),
  });
  console.log(`kogane evidence browser on http://127.0.0.1:${server.port}/`);
}
