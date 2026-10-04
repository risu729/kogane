import { parse } from "parse5";
import type { ArtifactMeta, Observation, Parser, ParseIssue } from "../types.ts";
import { containerClaim } from "./coverage.ts";
import { decimalText, decimalToMinorUnits, minorUnitExponent } from "./util.ts";

interface Node {
  nodeName: string;
  tagName?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: Node[];
  value?: string;
}
export class PrestiaBankParseError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PrestiaBankParseError";
  }
}
const fail = (code: string): never => {
  throw new PrestiaBankParseError(code);
};
const attr = (node: Node, name: string) => node.attrs?.find((a) => a.name === name)?.value;
const hasClass = (node: Node, name: string) =>
  (attr(node, "class") ?? "").split(/\s+/u).includes(name);
function find(node: Node, predicate: (node: Node) => boolean): Node[] {
  return [
    ...(predicate(node) ? [node] : []),
    ...(node.childNodes ?? []).flatMap((n) => find(n, predicate)),
  ];
}
const blocked = new Set([
  "script",
  "style",
  "template",
  "input",
  "button",
  "select",
  "textarea",
  "iframe",
  "object",
  "embed",
  "svg",
  "math",
  "img",
  "noscript",
]);
function text(node: Node): string {
  if (blocked.has(node.tagName ?? "")) return "";
  return (
    node.nodeName === "#text" ? (node.value ?? "") : (node.childNodes ?? []).map(text).join("")
  )
    .replace(/\s+/gu, " ")
    .trim();
}
function one(nodes: Node[], code = "missing-or-duplicate-field"): Node {
  if (nodes.length !== 1) fail(code);
  return nodes[0]!;
}
const GROUPS = [
  ["円普通預金・円定期預金", "yen-deposits"],
  ["外貨普通預金・外貨定期預金", "foreign-deposits"],
  ["プレミアム・デポジット（仕組預金）", "premium-deposit"],
  ["投資信託", "mutual-funds"],
  ["合同運用指定金銭信託", "money-trust"],
  ["借入", "borrowing"],
  ["円当座預金", "yen-current"],
  ["", "monthly-average"],
] as const;
const MONTHLY = [
  [
    "月間平均総取引残高",
    "provider_monthly_average_total_relationship_balance",
    "total-relationship",
  ],
  ["うち外貨部分", "provider_monthly_average_foreign_currency_balance", "foreign-currency"],
  ["うち流動性預金部分", "provider_monthly_average_liquid_deposit_balance", "liquid-deposits"],
] as const;
const PROVENANCE = "sanitized_provider_capture";
const escape = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
function document(html: string): Node {
  if (!html || html.length > 1024 * 1024) fail("invalid-html-size");
  return parse(html);
}
const DISPLAY_NOTE =
  "お客様の残高一覧です。時間帯等によっては、最新の情報が表示されない場合があります。";
const FX_NOTE =
  "総額は、外貨建て預入金額を最新のTTBレートにて円換算した金額の合計を表示しております。";
const MONTHLY_NOTE =
  "流動性預金とは定期預金を除いた円および外貨のすべての預金残高を示します。上記の月間平均総取引残高は前営業日時点の情報をもとに計算した参考値です。";
const TIMING_NOTE_PATTERN =
  "営業日\\d{1,2}:\\d{2}以降翌営業日\\d{1,2}:\\d{2}まで、および土・日・祝休日（日本標準時）に受付した海外送金取引は、翌営業日の\\d{1,2}:\\d{2}以降に残高および取引履歴に反映されます。";
const PREMIUM_NOTE_PATTERN =
  "プレミアム・デポジット円投資型において満期時に元本が外貨に交換された場合、満期日の翌営業日\\d{1,2}:\\d{2}以降にプレスティアマルチマネー口座外貨普通預金の残高に反映されます。";
function recognizedFinancialNote(note: string): boolean {
  const compact = note.replaceAll(" ", "");
  return (
    compact === DISPLAY_NOTE ||
    compact === MONTHLY_NOTE ||
    new RegExp(`^(?:${TIMING_NOTE_PATTERN})$`, "u").test(compact) ||
    new RegExp(`^${FX_NOTE}(?:${TIMING_NOTE_PATTERN})?(?:${PREMIUM_NOTE_PATTERN})?$`, "u").test(
      compact,
    )
  );
}
interface PrestiaBankCaption {
  text: string;
  localDateTime: string;
}
function caption(input: string): PrestiaBankCaption {
  const match = /^\((\d{4}\/\d{2}\/\d{2}) (\d{2}):(\d{2})\)$/u.exec(input);
  if (!match || Number(match[2]) > 23 || Number(match[3]) > 59) fail("invalid-provider-caption");
  return { text: input, localDateTime: `${maturity(match![1]!)}T${match![2]}:${match![3]}:00` };
}
function financialPage(doc: Node): {
  form: Node;
  groups: Node[];
  notes: string[];
  providerCaption?: PrestiaBankCaption;
} {
  const form = one(
    find(doc, (n) => n.tagName === "form" && attr(n, "name") === "ACKZDSP"),
    "unrecognized-page",
  );
  const heading = find(form, (n) => n.tagName === "h1" && text(n) === "口座残高");
  if (heading.length !== 1) fail("unrecognized-page");
  const section = one(
    find(
      form,
      (n) =>
        n.tagName === "section" &&
        hasClass(n, "card") &&
        find(n, (c) => c.tagName === "h2" && text(c) === "口座残高一覧").length === 1,
    ),
    "unrecognized-balance-section",
  );
  // The mobile page puts every group in one `inner` wrapper. Grouping follows
  // the explicit h3 headings in DOM order, never wrapper/currency guesses.
  const groups: Node[] = [];
  const paragraphs: Node[] = [];
  let providerCaption: PrestiaBankCaption | undefined;
  function partition(node: Node): void {
    if (blocked.has(node.tagName ?? "")) return;
    if (node.nodeName === "#text") {
      if ((node.value ?? "").trim()) fail("unknown-financial-text");
      return;
    }
    if (node.tagName === "h2") {
      if (text(node) !== "口座残高一覧") fail("unknown-financial-text");
      return;
    }
    if (node.tagName === "span" && hasClass(node, "heading-caption")) {
      if (providerCaption) fail("duplicate-provider-caption");
      providerCaption = caption(text(node));
      return;
    }
    if (
      (node.tagName === "a" && hasClass(node, "btn-print")) ||
      (node.tagName === "div" && hasClass(node, "mc_acHead")) ||
      (node.tagName === "div" && hasClass(node, "btn-area"))
    ) {
      const expected = hasClass(node, "btn-print")
        ? "印刷する"
        : hasClass(node, "mc_acHead")
          ? "口座を表示する"
          : "ホーム";
      if (text(node) !== expected) fail("unknown-financial-text");
      return;
    }
    if (node.tagName === "div" && hasClass(node, "mc_cardTbl")) {
      if (!groups.length) fail("financial-table-without-group");
      groups.at(-1)!.childNodes!.push(node);
      return;
    }
    if (node.tagName === "h3") {
      groups.push({ nodeName: "div", tagName: "div", childNodes: [node] });
      return;
    }
    if (node.tagName === "table" || node.tagName === "p") {
      if (node.tagName === "p") paragraphs.push(node);
      if (groups.length) groups.at(-1)!.childNodes!.push(node);
      else if (node.tagName === "table") fail("financial-table-without-group");
      return;
    }
    for (const child of node.childNodes ?? []) partition(child);
  }
  partition(section);
  const notes = paragraphs.map(text).filter((note) => note !== "");
  if (notes.some((note) => !recognizedFinancialNote(note))) fail("unknown-financial-note");
  if (groups.length !== GROUPS.length) fail("unrecognized-balance-groups");
  const seen = new Set<string>();
  for (const group of groups) {
    const headingText = text(one(find(group, (n) => n.tagName === "h3")));
    const id = GROUPS.find(([label]) => label === headingText)?.[1];
    if (!id || seen.has(id)) fail("unknown-or-duplicate-balance-group");
    seen.add(id!);
  }
  return { form, groups, notes, ...(providerCaption ? { providerCaption } : {}) };
}
function renderTable(node: Node, detail = false): string {
  const allowed = new Set([
    "table",
    "thead",
    "tbody",
    "tfoot",
    "tr",
    "td",
    "th",
    "span",
    "small",
    "strong",
    "b",
    "div",
    "br",
  ]);
  if (node.nodeName === "#text") return escape(node.value ?? "");
  if (blocked.has(node.tagName ?? "") || node.tagName === "a") return "";
  const isDetail = node.tagName === "table" ? hasClass(node, "table-normal") : detail;
  // The final column is a provider operation control, never financial
  // evidence. Drop all its descendants and direct text, not only links.
  const operationCell = isDetail && node.tagName === "tr" ? cells(node).at(-1) : undefined;
  const content = (node.childNodes ?? [])
    .map((child) =>
      child === operationCell
        ? `<${child.tagName}></${child.tagName}>`
        : renderTable(child, isDetail),
    )
    .join("");
  if (!node.tagName || !allowed.has(node.tagName)) return content;
  const className =
    node.tagName === "table"
      ? (attr(node, "class") ?? "")
          .split(/\s+/u)
          .filter((c) =>
            /^(?:table|table-form|table-normal|mc_table-(?:form|normal)__[1-8]|mc_cardTbl_origin|mc_hide)$/u.test(
              c,
            ),
          )
          .join(" ")
      : "";
  const attributes = className ? ` class="${escape(className)}"` : "";
  return node.tagName === "br"
    ? "<br>"
    : `<${node.tagName}${attributes}>${content}</${node.tagName}>`;
}
/** Parsed-DOM financial allowlist. No navigation, forms state, owner banner or executable attributes survive. */
export function sanitizePrestiaBankPage(html: string): string {
  // A truncated or unknown financial layout must never become a canonical
  // capture eligible for persistence merely because it had known headings.
  parsePrestiaBankBalancePage(html);
  const { groups, notes, providerCaption } = financialPage(document(html));
  const body = groups
    .map((group) => {
      const heading = text(one(find(group, (n) => n.tagName === "h3")));
      const tables = find(group, (n) => n.tagName === "table");
      if (tables.some((table) => find(table, (n) => n.tagName === "table").length !== 1))
        fail("nested-financial-table");
      return `<div class="inner"><h3>${escape(heading)}</h3>${tables.map((table) => renderTable(table)).join("")}</div>`;
    })
    .join("");
  return `<html><head></head><body data-kogane-provenance="${PROVENANCE}"><form name="ACKZDSP"><h1>口座残高</h1><section class="card"><h2>口座残高一覧</h2>${providerCaption ? `<span class="heading-caption">${escape(providerCaption.text)}</span>` : ""}${body}${notes.map((note) => `<p>${escape(note)}</p>`).join("")}</section></form></body></html>`;
}
interface Money {
  amountText: string;
  amountScale: number;
}
export interface PrestiaBankAccount extends Money {
  accountNumber: string;
  providerProductLabel: string;
  currency: string;
  metric: "available_balance" | "term_deposit_principal";
  group: string;
  depositNumber?: string;
  maturityDate?: string;
  rawLocator: string;
}
export interface PrestiaBankAggregate {
  group: string;
  metric: string;
  subject: string;
  providerLabel: string;
  amount: Money | null;
  rawLocator: string;
}
export interface PrestiaBankBalancePage {
  accounts: PrestiaBankAccount[];
  aggregates: PrestiaBankAggregate[];
  monthlyAverages: PrestiaBankAggregate[];
  notes: string[];
  providerCaption?: PrestiaBankCaption;
}
function responsiveRows(block: Node): { headings: string[]; values: string[] }[] {
  const rows = (block.childNodes ?? []).filter(
    (n) => n.tagName === "div" && hasClass(n, "mc_cardTbl_row"),
  );
  if (
    !rows.length ||
    (block.childNodes ?? []).some((n) =>
      n.nodeName === "#text"
        ? Boolean((n.value ?? "").trim())
        : !rows.includes(n) && !blocked.has(n.tagName ?? ""),
    )
  )
    fail("unknown-responsive-layout");
  return rows.map((row) => {
    const pairs = (row.childNodes ?? []).filter(
      (n) => n.tagName === "div" && hasClass(n, "mc_cardTbl_thtd"),
    );
    if (
      (row.childNodes ?? []).some((n) =>
        n.nodeName === "#text"
          ? Boolean((n.value ?? "").trim())
          : !pairs.includes(n) && !blocked.has(n.tagName ?? ""),
      )
    )
      fail("unknown-responsive-layout");
    for (const pair of pairs) {
      const th = one(
        find(pair, (n) => n.tagName === "div" && hasClass(n, "mc_cardTbl_th")),
        "unknown-responsive-layout",
      );
      const td = one(
        find(pair, (n) => n.tagName === "div" && hasClass(n, "mc_cardTbl_td")),
        "unknown-responsive-layout",
      );
      if (
        (pair.childNodes ?? []).some((n) =>
          n.nodeName === "#text"
            ? Boolean((n.value ?? "").trim())
            : n !== th && n !== td && !blocked.has(n.tagName ?? ""),
        )
      )
        fail("unknown-responsive-layout");
    }
    return {
      headings: pairs.map((pair) =>
        text(
          one(
            find(pair, (n) => n.tagName === "div" && hasClass(n, "mc_cardTbl_th")),
            "unknown-responsive-layout",
          ),
        ).replace(/\s*:\s*$/u, ""),
      ),
      values: pairs.map((pair, index) =>
        index === pairs.length - 1
          ? ""
          : text(
              one(
                find(pair, (n) => n.tagName === "div" && hasClass(n, "mc_cardTbl_td")),
                "unknown-responsive-layout",
              ),
            ),
      ),
    };
  });
}
function money(input: string, currency: string): Money | null {
  if (input === "-") return null;
  const match = /^(-?(?:0|[1-9]\d*|[1-9]\d{0,2}(?:,\d{3})+)(?:\.\d+)?) ([A-Z]{3})$/u.exec(input);
  if (!match || match[2] !== currency || input.length > 80) fail("invalid-provider-amount");
  const amount = decimalText(match![1]!.replaceAll(",", ""));
  if (!amount) fail("invalid-provider-amount");
  return { amountText: amount!.text, amountScale: amount!.scale };
}
const cells = (row: Node) =>
  (row.childNodes ?? []).filter((n) => n.tagName === "td" || n.tagName === "th");
function maturity(input: string): string {
  if (!/^\d{4}\/\d{2}\/\d{2}$/u.test(input)) fail("invalid-maturity-date");
  const date = input.replaceAll("/", "-");
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== date)
    fail("invalid-maturity-date");
  return date;
}
/** Reads the observed Japanese mobile table shape, never inferred currency groups or FX allocations. */
export function parsePrestiaBankBalancePage(html: string): PrestiaBankBalancePage {
  const doc = document(html);
  const { groups, notes, providerCaption } = financialPage(doc);
  const accounts: PrestiaBankAccount[] = [],
    aggregates: PrestiaBankAggregate[] = [],
    monthlyAverages: PrestiaBankAggregate[] = [];
  const identities = new Set<string>();
  for (const section of groups) {
    const heading = text(one(find(section, (n) => n.tagName === "h3")));
    const group = GROUPS.find(([label]) => label === heading)![1];
    const summary = one(
      find(section, (n) => n.tagName === "table" && hasClass(n, "table-form")),
      "missing-or-duplicate-group-total",
    );
    const summaryIndex = GROUPS.findIndex(([label]) => label === heading) + 1;
    if (!hasClass(summary, `mc_table-form__${summaryIndex}`)) fail("unknown-summary-layout");
    const summaryRows = find(summary, (n) => n.tagName === "tr");
    const labels =
      group === "monthly-average"
        ? MONTHLY.map(([label]) => label)
        : [group === "mutual-funds" ? "評価額合計" : "総額"];
    if (summaryRows.length !== labels.length) fail("unknown-summary-layout");
    summaryRows.forEach((row, index) => {
      const fields = cells(row);
      if (
        fields.length !== 2 ||
        fields[0]!.tagName !== "th" ||
        fields[1]!.tagName !== "td" ||
        text(fields[0]!) !== labels[index]
      )
        fail("unknown-summary-layout");
      const monthly = group === "monthly-average" ? MONTHLY[index]! : undefined;
      const value: PrestiaBankAggregate = {
        group,
        metric:
          monthly?.[1] ??
          (group === "foreign-deposits"
            ? "provider_yen_equivalent"
            : "provider_balance_group_total"),
        subject: monthly?.[2] ?? group,
        providerLabel: labels[index]!,
        amount: money(text(fields[1]!), "JPY"),
        rawLocator: `html:group=${group};summary-row=${index + 1}`,
      };
      (monthly ? monthlyAverages : aggregates).push(value);
    });
    const tables = find(section, (n) => n.tagName === "table");
    if (tables.some((table) => !hasClass(table, "table-form") && !hasClass(table, "table-normal")))
      fail("unknown-financial-table");
    const detailTables = tables.filter((table) => hasClass(table, "table-normal"));
    // This release supports exactly the detail topology observed locally:
    // yen savings, foreign savings and foreign term deposits. No provider
    // absent-product/empty-table marker has been observed or is inferred.
    const requiredDetails =
      group === "yen-deposits"
        ? ["ordinary"]
        : group === "foreign-deposits"
          ? ["ordinary", "term"]
          : [];
    if (detailTables.length !== requiredDetails.length) fail("incomplete-detail-topology");
    const tableKinds = new Set<string>();
    const detailViews: { headings: string[]; values: string[][] }[] = [];
    for (const table of detailTables) {
      const header = one(
        find(table, (n) => n.tagName === "thead"),
        "unknown-detail-layout",
      );
      const headerRow = one(
        find(header, (n) => n.tagName === "tr"),
        "unknown-detail-layout",
      );
      const headings = cells(headerRow).map(text);
      const ordinary = ["口座", "口座番号", "通貨", "利用可能額", ""];
      const term = ["口座", "口座番号", "預入番号", "満期日", "通貨", "預入金額", ""];
      const isTerm = headings.join("|") === term.join("|");
      if (!isTerm && headings.join("|") !== ordinary.join("|")) fail("unknown-detail-layout");
      const kind = isTerm ? "term" : "ordinary";
      const detailIndex = group === "yen-deposits" ? 1 : isTerm ? 3 : 2;
      if (!requiredDetails.includes(kind) || !hasClass(table, `mc_table-normal__${detailIndex}`))
        fail("unsupported-detail-group");
      if (tableKinds.has(kind)) fail("duplicate-detail-table");
      tableKinds.add(kind);
      const body = one(
        find(table, (n) => n.tagName === "tbody"),
        "unknown-detail-layout",
      );
      const rows = find(body, (n) => n.tagName === "tr");
      if (
        find(table, (n) => n.tagName === "tr").length !== rows.length + 1 ||
        find(table, (n) => n.tagName === "tfoot").length
      )
        fail("unknown-detail-layout");
      if (!rows.length || rows.length > 200) fail("unrecognized-detail-empty-state");
      detailViews.push({
        headings,
        values: rows.map((row) =>
          cells(row).map((cell, index) => (index === headings.length - 1 ? "" : text(cell))),
        ),
      });
      rows.forEach((row, index) => {
        const fields = cells(row);
        if (fields.length !== headings.length || fields.some((n) => n.tagName !== "td"))
          fail("unknown-detail-layout");
        const providerProductLabel = text(fields[0]!);
        const accountNumber = text(fields[1]!);
        const currency = text(fields[isTerm ? 4 : 2]!);
        if (
          !providerProductLabel ||
          providerProductLabel.length > 200 ||
          !/^\d{7,8}$/u.test(accountNumber)
        )
          fail("invalid-account-identity");
        if (
          !/^[A-Z]{3}$/u.test(currency) ||
          (group === "yen-deposits" ? currency !== "JPY" : currency === "JPY")
        )
          fail("invalid-row-currency");
        const depositNumber = isTerm ? text(fields[2]!) : undefined;
        if (isTerm && !/^\d{5}$/u.test(depositNumber!)) fail("invalid-deposit-identity");
        const identity = `${accountNumber}:${currency}:${depositNumber ?? "ordinary"}`;
        if (identities.has(identity)) fail("duplicate-account");
        identities.add(identity);
        const amount = money(text(fields[isTerm ? 5 : 3]!), currency);
        if (!amount) fail("missing-native-amount");
        accounts.push({
          ...amount!,
          accountNumber,
          providerProductLabel,
          currency,
          group,
          metric: isTerm ? "term_deposit_principal" : "available_balance",
          ...(isTerm
            ? { depositNumber: depositNumber!, maturityDate: maturity(text(fields[3]!)) }
            : {}),
          rawLocator: `html:group=${group};table=${kind};row=${index + 1}`,
        });
      });
    }
    if (requiredDetails.some((kind) => !tableKinds.has(kind))) fail("incomplete-detail-topology");
    const mirrors = find(section, (n) => n.tagName === "div" && hasClass(n, "mc_cardTbl"));
    if (mirrors.length && mirrors.length !== detailViews.length)
      fail("incomplete-responsive-topology");
    const mirrored = new Set<number>();
    for (const mirror of mirrors) {
      const rows = responsiveRows(mirror);
      const index = detailViews.findIndex((view) =>
        rows.every((row) => row.headings.join("|") === view.headings.join("|")),
      );
      if (index < 0 || mirrored.has(index)) fail("unknown-responsive-layout");
      mirrored.add(index);
      if (
        JSON.stringify(rows.map((row) => row.values)) !== JSON.stringify(detailViews[index]!.values)
      )
        fail("conflicting-responsive-balances");
    }
  }
  if (
    !notes.some(
      (note) =>
        note.startsWith("総額は、外貨建て預入金額") &&
        note.includes("最新のTTBレート") &&
        note.includes("円換算"),
    )
  )
    fail("missing-provider-fx-basis");
  if (
    !notes.some(
      (note) =>
        note.startsWith("流動性預金とは") &&
        note.includes("前営業日時点") &&
        note.includes("参考値"),
    )
  )
    fail("missing-provider-average-basis");
  return {
    accounts,
    aggregates,
    monthlyAverages,
    notes,
    ...(providerCaption ? { providerCaption } : {}),
  };
}
function exactAmount(amount: Money, currency: string) {
  const amountMinor = decimalToMinorUnits(amount.amountText, currency);
  // The decimal text is authoritative even beyond the current minor-unit table.
  // Known currencies with sub-minor precision still retain their exact value.
  return {
    amountText: amount.amountText,
    amountScale: amount.amountScale,
    ...(minorUnitExponent(currency) === undefined || amountMinor === undefined
      ? {}
      : { amountMinor }),
  };
}
export const prestiaBankBalances: Parser = {
  name: "prestia-bank-balances",
  version: "1.0.0",
  accepts(artifact: ArtifactMeta): boolean {
    return (
      artifact.sourceId === "prestia" &&
      artifact.dataset === "prestia-bank-balance-html" &&
      artifact.mime === "text/html" &&
      artifact.artifactKey === "balance.html" &&
      artifact.fetchUnitKey === "balance-summary"
    );
  },
  parse(bytes, artifact) {
    if (!this.accepts(artifact)) fail("invalid-artifact-metadata");
    if (artifact.runStatus !== "success" || artifact.runFailureCount !== 0)
      fail("unsuccessful-fetch-run");
    if (!bytes.length || bytes.length > 1024 * 1024) fail("invalid-html-size");
    let html: string;
    try {
      html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return fail("invalid-utf8-capture");
    }
    const doc = document(html);
    if (
      attr(one(find(doc, (n) => n.tagName === "body")), "data-kogane-provenance") !== PROVENANCE ||
      sanitizePrestiaBankPage(html) !== html
    )
      fail("unsanitized-provider-capture");
    const parsed = parsePrestiaBankBalancePage(html);
    const observations: Observation[] = parsed.accounts.map((account) => ({
      kind: "balance",
      sourceAccount: `prestia-bank:account:${account.accountNumber}:${account.currency}${account.depositNumber ? `:deposit:${account.depositNumber}` : ""}`,
      metric: account.metric,
      ...exactAmount(account, account.currency),
      instrument: account.currency,
      asOf: artifact.fetchedAt,
      observedAt: artifact.fetchedAt,
      rawLocator: account.rawLocator,
      extra: {
        providerProductLabel: account.providerProductLabel,
        accountNumber: account.accountNumber,
        ...(parsed.providerCaption ? { providerCaption: parsed.providerCaption } : {}),
        ...(account.depositNumber
          ? { depositNumber: account.depositNumber, maturityDate: account.maturityDate }
          : {}),
        _kogane: {
          captureProvenance: PROVENANCE,
          group: account.group,
          identityOrigin: "provider-account-currency-and-deposit",
          timeBasis: "provider-current",
        },
      },
    }));
    for (const aggregate of [...parsed.aggregates, ...parsed.monthlyAverages]) {
      if (!aggregate.amount) continue;
      const monthly = aggregate.group === "monthly-average";
      observations.push({
        kind: "valuation",
        sourceAccount: monthly
          ? "prestia-bank:relationship"
          : `prestia-bank:group:${aggregate.group}`,
        subject: aggregate.subject,
        metric: aggregate.metric,
        ...exactAmount(aggregate.amount, "JPY"),
        currency: "JPY",
        asOf: artifact.fetchedAt,
        observedAt: artifact.fetchedAt,
        rawLocator: aggregate.rawLocator,
        extra: {
          providerLabel: aggregate.providerLabel,
          providerCalculationNotes: parsed.notes,
          ...(parsed.providerCaption ? { providerCaption: parsed.providerCaption } : {}),
          _kogane: {
            captureProvenance: PROVENANCE,
            group: aggregate.group,
            aggregationRule: "non-additive",
            timeBasis: monthly ? "provider-monthly-average" : "provider-current",
            ...(monthly
              ? {
                  periodBasis: "provider-reference-at-previous-business-day",
                  periodStatus: "not-stated",
                }
              : {}),
            ...(aggregate.group === "foreign-deposits"
              ? {
                  valuationBasis: "bank-latest-ttb",
                  valuationScope: "foreign-deposits-group",
                  allocation: "not-stated",
                }
              : {}),
          },
        },
      });
    }
    const issues: ParseIssue[] = [...parsed.aggregates, ...parsed.monthlyAverages]
      .filter((a) => a.amount === null)
      .map((a) => ({
        code: "row_unreadable",
        locator: a.rawLocator,
        severity: "info",
        impact: "field",
        message: "provider_value_not_stated",
      }));
    return {
      observations,
      warnings: [],
      issues,
      coverage: [
        containerClaim({
          artifact,
          issues,
          observedCount: observations.length,
          evidenceRefs: ["html:form[name=ACKZDSP]", "html:section=balance-summary"],
        }),
      ],
    };
  },
};
