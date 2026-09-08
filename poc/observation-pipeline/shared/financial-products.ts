export const FINANCIAL_PRODUCT_CATALOGUE_VERSION = "2026-09-08.1";
export const FINANCIAL_PRODUCT_RESOLVER_VERSION = "own-row-v1";
const VERIFIED_AT = "2026-09-08";
const BANK_APP =
  "https://bk.web.sbishinseibank.co.jp/SFC/apps/services/www/SFC/desktopbrowser/default/";
export const FINANCIAL_PRODUCT_SOURCES = [
  {
    id: "shinsei-powerflex",
    title: "パワーフレックス口座の位置付け",
    url: "https://faq.sbishinseibank.co.jp/faq_detail.html?category=702&id=102&page=1",
    verifiedAt: VERIFIED_AT,
  },
  {
    id: "shinsei-yen-ordinary",
    title: "パワーフレックス円普通預金",
    url: "https://www.sbishinseibank.co.jp/retail/yen/en_futsu.html",
    verifiedAt: VERIFIED_AT,
  },
  {
    id: "shinsei-hyper",
    title: "SBIハイパー預金の開始について",
    url: "https://corp.sbishinseibank.co.jp/ja/news/news/20250918a.html",
    verifiedAt: VERIFIED_AT,
  },
  {
    id: "shinsei-power-deposit",
    title: "ボーナス利息付特別預金（パワー預金）",
    url: "https://www.sbishinseibank.co.jp/info/news2607_poweryokin.html?intcid=yen_power_17",
    verifiedAt: VERIFIED_AT,
  },
  {
    id: "shinsei-power-limits",
    title: "パワー預金の振替限度額",
    url: "https://faq.sbishinseibank.co.jp/faq_detail.html?category=1169&id=111725&page=1",
    verifiedAt: VERIFIED_AT,
  },
  {
    id: "shinsei-fx-ordinary",
    title: "パワーフレックス外貨普通預金",
    url: "https://www.sbishinseibank.co.jp/retail/gaika/fx_saving/",
    verifiedAt: VERIFIED_AT,
  },
  {
    id: "shinsei-ui-codes",
    title: "銀行公開UIの預金コード分類",
    url: `${BANK_APP}js/service/utility.js`,
    verifiedAt: VERIFIED_AT,
  },
  {
    id: "shinsei-ui-accounts",
    title: "銀行公開UIの口座分類",
    url: `${BANK_APP}js/controller/AI0001_account_info.js`,
    verifiedAt: VERIFIED_AT,
  },
  {
    id: "shinsei-ui-view",
    title: "銀行公開UIの製品別操作",
    url: `${BANK_APP}view/PAI0001_account_info.html`,
    verifiedAt: VERIFIED_AT,
  },
  {
    id: "shinsei-ui-messages",
    title: "銀行公開UIの商品範囲・ゼロ残高の説明",
    url: `${BANK_APP}js/messages/message_jp.json`,
    verifiedAt: VERIFIED_AT,
  },
] as const;
export const FINANCIAL_INSTITUTIONS = [
  { id: "sbi-shinsei-bank", name: "SBI新生銀行" },
  { id: "smbc-bank", name: "三井住友銀行" },
] as const;
export const FINANCIAL_PRODUCT_FAMILIES = [
  {
    id: "sbi-shinsei:powerflex",
    name: "総合口座パワーフレックス",
    institutionId: "sbi-shinsei-bank",
    parentId: null,
  },
  {
    id: "sbi-shinsei:powerflex-fx-ordinary",
    name: "パワーフレックス外貨普通預金",
    institutionId: "sbi-shinsei-bank",
    parentId: "sbi-shinsei:powerflex",
  },
] as const;
interface ProductDefinition {
  id: string;
  name: string;
  institutionId: string;
  familyId: string;
  code: string;
  nativeCurrency: string;
  kind:
    | "ordinary-deposit"
    | "securities-linked-deposit"
    | "bonus-interest-special-deposit"
    | "foreign-ordinary-deposit";
  sourceIds: string[];
}
const FX_CODES = [
  ["621", "USD"],
  ["622", "EUR"],
  ["623", "CAD"],
  ["624", "AUD"],
  ["625", "GBP"],
  ["626", "NZD"],
  ["627", "SGD"],
  ["628", "HKD"],
  ["629", "ZAR"],
  ["630", "NOK"],
  ["631", "CNY"],
  ["632", "TRY"],
  ["633", "BRL"],
] as const;
export const FINANCIAL_PRODUCTS: readonly ProductDefinition[] = [
  {
    id: "sbi-shinsei:powerflex-yen-ordinary",
    name: "パワーフレックス円普通預金",
    institutionId: "sbi-shinsei-bank",
    familyId: "sbi-shinsei:powerflex",
    code: "601",
    nativeCurrency: "JPY",
    kind: "ordinary-deposit",
    sourceIds: ["shinsei-yen-ordinary", "shinsei-ui-accounts", "shinsei-ui-codes"],
  },
  {
    id: "sbi-shinsei:hyper-deposit",
    name: "SBIハイパー預金",
    institutionId: "sbi-shinsei-bank",
    familyId: "sbi-shinsei:powerflex",
    code: "603",
    nativeCurrency: "JPY",
    kind: "securities-linked-deposit",
    sourceIds: ["shinsei-hyper", "shinsei-ui-accounts", "shinsei-ui-view", "shinsei-ui-codes"],
  },
  {
    id: "sbi-shinsei:power-deposit",
    name: "ボーナス利息付特別預金（パワー預金）",
    institutionId: "sbi-shinsei-bank",
    familyId: "sbi-shinsei:powerflex",
    code: "605",
    nativeCurrency: "JPY",
    kind: "bonus-interest-special-deposit",
    sourceIds: [
      "shinsei-power-deposit",
      "shinsei-power-limits",
      "shinsei-ui-codes",
      "shinsei-ui-view",
      "shinsei-ui-messages",
    ],
  },
  ...FX_CODES.map(([code, currency]): ProductDefinition => ({
    id: `sbi-shinsei:powerflex-fx-ordinary:${currency.toLowerCase()}`,
    name: `パワーフレックス外貨普通預金（${currency}）`,
    institutionId: "sbi-shinsei-bank",
    familyId: "sbi-shinsei:powerflex-fx-ordinary",
    code,
    nativeCurrency: currency,
    kind: "foreign-ordinary-deposit",
    sourceIds: [
      "shinsei-fx-ordinary",
      "shinsei-ui-codes",
      "shinsei-ui-accounts",
      "shinsei-ui-messages",
    ],
  })),
];
export interface FinancialProductInput {
  asOf?: string | null;
  observedAt?: string | null;
  kind: "transaction" | "balance" | "position" | "valuation";
  id: number;
  parseRunId: number;
  artifactId: number;
  rawLocator: string;
  sourceId: string;
  dataset: string;
  sourceAccount: string;
  currency: string | null;
  subject: string | null;
  extra: unknown;
}
export interface FinancialProductClaim {
  status: "identified" | "unresolved" | "conflict";
  productId: string | null;
  name: string | null;
  institution: { id: string; name: string } | null;
  family: { id: string; name: string } | null;
  nativeCurrency: string | null;
  code: string | null;
  catalogueVersion: string;
  resolverVersion: string;
  origin: Pick<
    FinancialProductInput,
    "kind" | "id" | "parseRunId" | "artifactId" | "rawLocator"
  > & { asOf: string | null; observedAt: string | null };
  evidence: { sourceIds: string[]; fields: string[]; rule: string };
  temporalBasis: "current-catalogue-no-historical-terms";
  reason: string;
}
const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const codeText = (value: unknown): string | null =>
  typeof value === "string" && /^[A-Za-z0-9_-]{1,64}$/u.test(value) ? value : null;
/** Pure own-row interpretation. The caller supplies trusted parsed lineage; no sibling/run inference. */
export function resolveFinancialProduct(input: FinancialProductInput): FinancialProductClaim {
  const row = object(input.extra);
  const metadata = object(row._kogane);
  const code = codeText(row.productCode);
  const claim: FinancialProductClaim = {
    status: "unresolved",
    productId: null,
    name: null,
    institution: FINANCIAL_INSTITUTIONS.find((i) => i.id === input.sourceId) ?? null,
    family: null,
    nativeCurrency: null,
    code,
    catalogueVersion: FINANCIAL_PRODUCT_CATALOGUE_VERSION,
    resolverVersion: FINANCIAL_PRODUCT_RESOLVER_VERSION,
    origin: {
      asOf: input.asOf ?? null,
      observedAt: input.observedAt ?? null,
      kind: input.kind,
      id: input.id,
      parseRunId: input.parseRunId,
      artifactId: input.artifactId,
      rawLocator: input.rawLocator,
    },
    evidence: { sourceIds: [], fields: [], rule: "unresolved-own-row-v1" },
    temporalBasis: "current-catalogue-no-historical-terms",
    reason: "この取得元の商品を特定する検証済みのルールはまだありません。",
  };
  const stop = (reason: string, conflict = false): FinancialProductClaim => ({
    ...claim,
    status: conflict ? "conflict" : "unresolved",
    reason,
  });
  if (
    /:gross(?:$|:)|:aggregate(?:$|:)/u.test(input.sourceAccount) ||
    /aggregate|summary|total/iu.test(String(metadata.sourceView ?? ""))
  )
    return stop("集計値は個別の金融商品を表しません。商品への割当は行っていません。");
  if (input.sourceId === "smbc-bank")
    return stop(
      "円普通預金の取得範囲は分かりますが、残高別金利型などの具体的な商品区分を示す原本の根拠がありません。",
    );
  if (input.sourceId !== "sbi-shinsei-bank") return claim;
  if (
    input.dataset !== "top-accounts-balance-and-activity" ||
    !["balance", "valuation"].includes(input.kind) ||
    metadata.sourceView !== "top_overview"
  )
    return stop(
      "この行自身に商品を確定する対応対象の口座概要データがありません。他の行や取得回からは推定していません。",
    );
  const locator =
    /^json:\$\.responseParam\.overview\.responseParam\.savingsDetails\[(0|[1-9]\d*)\]\.(balance|yenEqui)$/u.exec(
      input.rawLocator,
    );
  if (
    !locator ||
    !Number.isSafeInteger(Number(locator[1])) ||
    locator[2] !== (input.kind === "valuation" ? "yenEqui" : "balance")
  )
    return stop("商品コードと元の口座概要行の位置が一致していません。", true);
  claim.evidence.fields = [
    "extra.productCode",
    "extra.currency",
    "extra.accountNo",
    "extra._kogane.sourceView",
    "rawLocator",
  ];
  if (!code) return stop("この行に検証可能な商品コードがありません。");
  if (metadata.productCode !== undefined && metadata.productCode !== code)
    return stop("原本の商品コードと解釈用メタデータの商品コードが一致していません。", true);
  if (
    typeof row.accountNo !== "string" ||
    !row.accountNo ||
    input.sourceAccount !== `sbi-shinsei:${row.accountNo}`
  )
    return stop("商品コードの原本行と取得元口座の参照が一致していません。", true);
  if (typeof row.currency !== "string" || !/^[A-Z]{3}$/u.test(row.currency))
    return stop("この行の元の通貨を確認できません。");
  let native: string | null = input.currency;
  if (input.kind === "valuation") {
    const subject =
      input.subject ??
      (typeof metadata.subjectCurrency === "string" ? metadata.subjectCurrency : null);
    if (!subject)
      return stop("円換算額の対象となる元の通貨が不明です。円預金とは解釈していません。");
    if (
      input.currency !== "JPY" ||
      (metadata.subjectCurrency !== undefined && metadata.subjectCurrency !== subject)
    )
      return stop("円換算額の表示通貨と対象通貨の情報が矛盾しています。", true);
    native = subject;
    claim.evidence.fields.push("subject", "extra._kogane.subjectCurrency");
  }
  if (
    native !== row.currency ||
    (metadata.subjectCurrency !== undefined && metadata.subjectCurrency !== row.currency)
  )
    return stop("原本行の通貨と観測対象の通貨が一致していません。", true);
  claim.nativeCurrency = native;
  const product = FINANCIAL_PRODUCTS.find(
    (p) => p.code === code && p.institutionId === input.sourceId,
  );
  if (!product)
    return stop("この商品コードの公式の商品対応は未確認です。普通預金などへの代替はしていません。");
  if (product.nativeCurrency !== native)
    return stop("商品コードに対応する通貨と原本の通貨が一致していません。", true);
  const family = FINANCIAL_PRODUCT_FAMILIES.find((f) => f.id === product.familyId)!;
  return {
    ...claim,
    status: "identified",
    productId: product.id,
    name: product.name,
    family: { id: family.id, name: family.name },
    evidence: {
      ...claim.evidence,
      sourceIds: [...product.sourceIds, "shinsei-powerflex"],
      rule: "shinsei-top-own-row-code-currency-v1",
    },
    reason:
      "同じ原本行の商品コード・通貨・口座参照を、銀行公開UIのコード分類と公式商品説明に対応付けました。残高の有無や過去の契約条件は示しません。",
  };
}
/** Network boundary guard: claims must use this catalogue and keep unresolved results unlabelled. */
export function validFinancialProductClaim(value: unknown): value is FinancialProductClaim {
  const row = object(value);
  if (
    Object.keys(row).length === 0 ||
    !["identified", "unresolved", "conflict"].includes(String(row.status)) ||
    typeof row.status !== "string" ||
    row.catalogueVersion !== FINANCIAL_PRODUCT_CATALOGUE_VERSION ||
    row.resolverVersion !== FINANCIAL_PRODUCT_RESOLVER_VERSION ||
    row.temporalBasis !== "current-catalogue-no-historical-terms" ||
    typeof row.reason !== "string" ||
    row.reason.length < 1 ||
    row.reason.length > 1000
  )
    return false;
  if (row.code !== null && codeText(row.code) === null) return false;
  if (
    row.nativeCurrency !== null &&
    (typeof row.nativeCurrency !== "string" || !/^[A-Z]{3}$/u.test(row.nativeCurrency))
  )
    return false;
  const institution = object(row.institution);
  if (
    row.institution !== null &&
    !FINANCIAL_INSTITUTIONS.some((i) => institution.id === i.id && institution.name === i.name)
  )
    return false;
  const origin = object(row.origin);
  if (
    [origin.asOf, origin.observedAt].some(
      (time) => time !== null && (typeof time !== "string" || time.length < 1 || time.length > 128),
    )
  )
    return false;
  if (
    typeof origin.kind !== "string" ||
    !["transaction", "balance", "position", "valuation"].includes(origin.kind) ||
    [origin.id, origin.parseRunId, origin.artifactId].some(
      (id) => typeof id !== "number" || !Number.isSafeInteger(id) || id < 1,
    ) ||
    typeof origin.rawLocator !== "string" ||
    origin.rawLocator.length < 1 ||
    origin.rawLocator.length > 1024
  )
    return false;
  const evidence = object(row.evidence);
  const fields = [
    "extra.productCode",
    "extra.currency",
    "extra.accountNo",
    "extra._kogane.sourceView",
    "rawLocator",
    "subject",
    "extra._kogane.subjectCurrency",
  ];
  if (
    !Array.isArray(evidence.fields) ||
    evidence.fields.length > fields.length ||
    evidence.fields.some((f) => typeof f !== "string" || !fields.includes(f)) ||
    new Set(evidence.fields).size !== evidence.fields.length ||
    !Array.isArray(evidence.sourceIds) ||
    evidence.sourceIds.length > FINANCIAL_PRODUCT_SOURCES.length ||
    evidence.sourceIds.some(
      (id) => typeof id !== "string" || !FINANCIAL_PRODUCT_SOURCES.some((s) => s.id === id),
    ) ||
    new Set(evidence.sourceIds).size !== evidence.sourceIds.length
  )
    return false;
  if (row.status !== "identified")
    return (
      row.productId === null &&
      row.name === null &&
      row.family === null &&
      evidence.sourceIds.length === 0 &&
      evidence.rule === "unresolved-own-row-v1"
    );
  const product = FINANCIAL_PRODUCTS.find((p) => p.id === row.productId);
  const family = object(row.family);
  const expectedFamily = FINANCIAL_PRODUCT_FAMILIES.find((f) => f.id === product?.familyId);
  const expectedSources = [...(product?.sourceIds ?? []), "shinsei-powerflex"];
  return (
    product !== undefined &&
    row.name === product.name &&
    institution.id === product.institutionId &&
    row.code === product.code &&
    row.nativeCurrency === product.nativeCurrency &&
    family.id === product.familyId &&
    family.name === expectedFamily?.name &&
    ["balance", "valuation"].includes(origin.kind) &&
    evidence.rule === "shinsei-top-own-row-code-currency-v1" &&
    expectedSources.length === evidence.sourceIds.length &&
    expectedSources.every((id) => (evidence.sourceIds as unknown[]).includes(id)) &&
    [
      "extra.productCode",
      "extra.currency",
      "extra.accountNo",
      "extra._kogane.sourceView",
      "rawLocator",
    ].every((f) => (evidence.fields as unknown[]).includes(f))
  );
}
