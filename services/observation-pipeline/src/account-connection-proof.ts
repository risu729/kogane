import { parse, type DefaultTreeAdapterMap } from "parse5";
type Node = DefaultTreeAdapterMap["node"];
const nodes = (node: Node): Node[] => [
  node,
  ...("childNodes" in node ? node.childNodes.flatMap(nodes) : []),
];
const content = (node: Node): string =>
  node.nodeName === "#text"
    ? (node as DefaultTreeAdapterMap["textNode"]).value
    : "childNodes" in node
      ? node.childNodes.map(content).join("")
      : "";
const attr = (node: Node, name: string): string =>
  "attrs" in node ? (node.attrs.find((a) => a.name === name)?.value ?? "") : "";
const tag = (node: Node, name: string): boolean => "tagName" in node && node.tagName === name;
const normalize = (value: string) => value.replace(/\s+/gu, " ").trim();
const providers = [
  {
    heading: "三井住友銀行",
    label: "三井住友銀行（MoneyForward連携）",
    source: "smbc-bank",
    reason:
      "直接取得の保存原本に支店・口座番号がなく、口座の対応は未確認です。連携には円預金と外貨の複数項目が含まれます。",
  },
  {
    heading: "SBI新生銀行",
    label: "SBI新生銀行（MoneyForward連携）",
    source: "sbi-shinsei-bank",
    reason: "支店・口座番号と直接取得の接続識別子を照合する根拠が不足しています。",
  },
  {
    heading: "SMBC信託銀行プレスティア(旧シティバンク)",
    label: "SMBC信託銀行 PRESTIA（MoneyForward連携）",
    source: null,
    reason:
      "PRESTIA預金の直接取得はありません。GLOBAL PASSのデビット利用は預金口座とは別の対象です。",
  },
  {
    heading: "三井住友カード (VpassID)",
    label: "三井住友カード（MoneyForward連携）",
    source: "vpass",
    reason:
      "連携には複数カードとポイントが含まれ、保存原本のカード番号欄は空です。カード名だけでは直接取得の各カードと対応付けられません。",
  },
] as const;
export interface ConnectionDetail {
  label: string;
  relatedSource: string | null;
  reason: string;
  rows: { name: string; product: string; number: string }[];
}
/** Private verifier: original identifiers remain in memory and never enter the review record. */
export function readConnectionDetail(html: string): ConnectionDetail {
  if (new TextEncoder().encode(html).byteLength > 8 * 1024 * 1024)
    throw new Error("connection_detail_size");
  const all = nodes(parse(html));
  const headings = all.filter((n) => tag(n, "h1")).map((n) => normalize(content(n)));
  const provider = providers.filter((p) => headings.includes(p.heading));
  if (provider.length !== 1) throw new Error("connection_provider_heading_ambiguous");
  const tables = all.filter((n) => tag(n, "table") && attr(n, "class") === "table table-bordered");
  if (tables.length !== 1) throw new Error("connection_summary_ambiguous");
  const rows = nodes(tables[0]!)
    .filter((n) => tag(n, "tr"))
    .map((row) =>
      ("childNodes" in row ? row.childNodes : [])
        .filter((n) => tag(n, "td") || tag(n, "th"))
        .map((n) => normalize(content(n))),
    );
  if (
    rows.length < 2 ||
    rows.length > 100 ||
    rows[0]?.slice(0, 3).join("|") !== "名称|種類|番号" ||
    rows.some((r) => r.length < 4)
  )
    throw new Error("connection_summary_shape");
  const p = provider[0]!;
  return {
    label: p.label,
    relatedSource: p.source,
    reason: p.reason,
    rows: rows.slice(1).map((r) => ({ name: r[0]!, product: r[1]!, number: r[2]! })),
  };
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("connection_direct_shape");
  return value as Record<string, unknown>;
}
function section(value: unknown): {
  request: Record<string, unknown>;
  response: Record<string, unknown>;
} {
  const v = object(value);
  const error = object(v.errorInfo);
  if (
    error.statusID !== "00000" ||
    typeof error.statusMessage !== "string" ||
    error.statusMessage.toLowerCase() !== "success"
  )
    throw new Error("connection_direct_response_failed");
  return { request: object(v.requestParam), response: object(v.responseParam) };
}
/** Branch+display number identifies the shared provider connection, never a 15-digit leaf account. */
export function verifyShinseiConnection(
  detail: ConnectionDetail,
  top: unknown,
  summary: unknown,
): { directSourceAccounts: string[] } {
  if (detail.relatedSource !== "sbi-shinsei-bank") throw new Error("connection_wrong_provider");
  if (
    object(object(top).header).adapterResultCode !== "0" ||
    object(object(summary).header).adapterResultCode !== "0"
  )
    throw new Error("connection_direct_response_failed");
  const topResponse = object(object(top).responseParam);
  const summaryResponse = object(object(summary).responseParam);
  const overview = section(topResponse.overview);
  const activity = section(topResponse.activity);
  const branch = section(summaryResponse.branchFetch);
  const overviewSummary = section(summaryResponse.summary);
  const category = section(summaryResponse.category);
  const principal = overview.request.nationalid;
  if (
    typeof principal !== "string" ||
    !/^\d{10}$/u.test(principal) ||
    [activity, branch, overviewSummary, category].some((s) => s.request.nationalid !== principal)
  )
    throw new Error("connection_principal_conflict");
  if (
    typeof branch.response.branchCode !== "string" ||
    !/^\d{3,4}$/u.test(branch.response.branchCode) ||
    typeof branch.response.branchName !== "string"
  )
    throw new Error("connection_branch_shape");
  if (
    detail.rows.length !== 2 ||
    detail.rows
      .map((r) => r.product)
      .sort()
      .join("|") !== ["円普通預金", "SBIハイパー預金"].sort().join("|")
  )
    throw new Error("connection_product_scope_changed");
  for (const row of detail.rows) {
    const match = /^(.*?)\((\d{3})\)$/u.exec(row.name);
    if (
      !match ||
      normalize(match[1]!) !== normalize(branch.response.branchName) ||
      Number(match[2]) !== Number(branch.response.branchCode) ||
      !/^\d{7}$/u.test(row.number) ||
      match[2]! + row.number !== principal
    )
      throw new Error("connection_number_mismatch");
  }
  const savings = overview.response.savingsDetails;
  if (!Array.isArray(savings) || savings.length < 1 || savings.length > 100)
    throw new Error("connection_leaf_inventory_invalid");
  const accounts = savings.map((v) => object(v).accountNo);
  if (
    accounts.some((a) => typeof a !== "string" || !/^\d{15}$/u.test(a)) ||
    new Set(accounts).size !== accounts.length ||
    !accounts.includes(activity.response.accountNo)
  )
    throw new Error("connection_leaf_inventory_invalid");
  return { directSourceAccounts: (accounts as string[]).map((a) => `sbi-shinsei:${a}`) };
}
