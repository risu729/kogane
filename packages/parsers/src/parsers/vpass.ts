import type { ArtifactMeta, Parser, ParseResult, TransactionObservation } from "../types.ts";
import { decodeUtf8, isObject, unitScopeAdmitted } from "./util.ts";
import { stableFingerprint } from "./sbi-strict.ts";

const SOURCE = "vpass";
const MIME = "application/json";
const ROOT_KEYS = ["body", "header"] as const;
const HEADER_KEYS = [
  "loginFlg",
  "resultCode",
  "resultMessage",
  "siteCatalystSessionBean",
  "transitTo",
  "vpSessionBean",
] as const;
const BODY_KEYS = ["content"] as const;
const WEB_CONTENT_KEYS = [
  "HpSvrRoot",
  "HpSvrRootUrl",
  "TkAccountExplanation",
  "WebMeisaiCommonDisplayServiceBean",
  "WebMeisaiTopDisplayServiceBean",
] as const;
const CUSTOMIZED_CONTENT_KEYS = [
  "CustomizedMeisaiAnsDisplayServiceBean",
  "CustomizedWebMeisaiCommonInputServiceBean",
] as const;
const WEB_ROW_KEYS = [
  "columnsSize",
  "columnsSizeS",
  "data",
  "maxIndex",
  "rowType",
  "shiharaiPatternFlag",
] as const;
const CUSTOMIZED_ROW_KEYS = [
  "bunkatsuPay",
  "bunkatsuYaku",
  "genchiKin",
  "kanzanDate",
  "kanzanRate",
  "kmName",
  "riyouDate",
  "riyouKin",
  "shiharaiDate",
  "shiharaiTotal",
  "tesuWariKin",
  "tukaRyaku",
  "uketsukeKbn",
  "uriageKbn",
  "zokugara",
] as const;
const WEB_BEAN_BASE =
  "adsTypeFlag,campaignMsgFlag,cardCode,cloApiUrl,cloDispUrl,crCampaignFlag,ecrmUser,externalId,formIdDispFlag,globalId,hpLinkIndicateFl,kaiteiFlag,kanjyoFlag,linkHanteiVo,meisaiList,menteDetailFlg,nextFirstRow,nextPageDispFlg,nextPageNo,olLinkIndicateFl,paramMap,prMsg03DispFlag,prMsg04DispFlag,prMsg05DispFlag,prMsg11,prMsg11DispFlag,prMsg12,prMsg12DispFlag,preEditFlag,prevFirstRow,prevPageDispFlg,prevPageNo,prmsgDispFlag,riyouEndFlag,riyouFirstFlag,saiseiStatus,seikyuYMList,shiharaiEndFlag,shiharaiFirstFlag,srCampaignFlag,webMeisaiTopK3Vo".split(
    ",",
  );
const WEB_BEAN_WITH_BRIDGE = [...WEB_BEAN_BASE, "bridgePagePrm", "bridgeUrl", "financialHpUrl"];
const CUSTOMIZED_BEAN_BASE =
  "atRevoLinkDisp,campaignMsgFlag,cardName,crCampaignFlag,csvMoneyFlag,kanjyoFlag,ktmktKbn,pageFlg,pageSize,responseCnt,seikyuDate,seikyuYM,seikyuYMList,shiharaiKin1,shiharaiKin2,shiharaiKin3,srCampaignFlag,sysDate,sysdateStringForMobile,total,userKbn,userName".split(
    ",",
  );
const CUSTOMIZED_BEAN_WITH_SETTLEMENT = [...CUSTOMIZED_BEAN_BASE, "kessai1"];
const CUSTOMIZED_BEAN_WITH_ROWS = [...CUSTOMIZED_BEAN_WITH_SETTLEMENT, "meisaiList"];
const ARTIFACT_KEY = /^(?:cards\/(card-\d{3})\/)?months\/(\d{6})\/(top|answer)-(\d{3})\.json$/u;

interface Scope {
  card: string;
  month: string;
  pageKind: "top" | "answer";
  pageIndex: number;
}

export const vpassStatementPage: Parser = {
  name: "vpass-statement-page",
  version: "1.0.0",
  accepts(artifact: ArtifactMeta): boolean {
    return (
      artifact.sourceId === SOURCE &&
      artifact.dataset === "statement-page" &&
      artifact.mime === MIME
    );
  },
  parse(bytes: Uint8Array, artifact: ArtifactMeta): ParseResult {
    requireSuccessfulRun(artifact);
    const scope = artifactScope(artifact);
    const root = parseObject(bytes, "vpass statement page");
    exactKeys(root, ROOT_KEYS, "vpass statement page");
    const header = requiredObject(root["header"], "vpass header");
    exactKeys(header, HEADER_KEYS, "vpass header");
    if (![0, "0", "0000"].includes(header["resultCode"] as never))
      throw new Error("vpass header.resultCode is not successful");
    boundedString(header["transitTo"], "vpass header.transitTo", false);
    const body = requiredObject(root["body"], "vpass body");
    exactKeys(body, BODY_KEYS, "vpass body");
    const content = requiredObject(body["content"], "vpass content");
    const web = content["WebMeisaiTopDisplayServiceBean"];
    const customized = content["CustomizedMeisaiAnsDisplayServiceBean"];
    if ((web === undefined) === (customized === undefined))
      throw new Error("vpass statement page must contain exactly one supported family");
    return web === undefined
      ? parseCustomized(content, customized, artifact, scope)
      : parseWeb(content, web, artifact, scope);
  },
};

function parseWeb(
  content: Record<string, unknown>,
  value: unknown,
  artifact: ArtifactMeta,
  scope: Scope,
): ParseResult {
  if (scope.pageKind !== "top") throw new Error("vpass web page must use a top artifact key");
  exactKeys(content, WEB_CONTENT_KEYS, "vpass web content");
  const bean = requiredObject(value, "vpass web bean");
  exactKeyVariant(bean, [WEB_BEAN_BASE, WEB_BEAN_WITH_BRIDGE], "vpass web bean");
  const rows = boundedArray(bean["meisaiList"], "vpass web meisaiList");
  const observations: TransactionObservation[] = [];
  const warnings: string[] = [];
  const occurrences = new Map<string, number>();
  rows.forEach((entry, index) => {
    const row = requiredObject(entry, `vpass web row ${index}`);
    exactKeys(row, WEB_ROW_KEYS, `vpass web row ${index}`);
    const columnsSize = boundedSafeInteger(
      row["columnsSize"],
      `vpass web row ${index}.columnsSize`,
    );
    const maxIndex = boundedString(row["maxIndex"], `vpass web row ${index}.maxIndex`, false);
    const columnsSizeText = boundedString(
      row["columnsSizeS"],
      `vpass web row ${index}.columnsSizeS`,
      false,
    );
    const rowType = boundedString(row["rowType"], `vpass web row ${index}.rowType`, false);
    boundedSafeInteger(row["shiharaiPatternFlag"], `vpass web row ${index}.shiharaiPatternFlag`);
    const data = boundedStringArray(row["data"], `vpass web row ${index}.data`);
    const primary = data[0];
    const secondary = data[1];
    if (
      rowType !== primary ||
      columnsSize !== data.length ||
      columnsSizeText !== String(data.length) ||
      maxIndex !== String(data.length - 1)
    ) {
      throw new Error(`vpass web row ${index} metadata conflicts with data`);
    }
    if (primary === "45") {
      exactDataLength(data, 5, `vpass web row ${index}.data`);
      boundedString(data[1], `vpass web row ${index}.data[1]`, false);
      return;
    }
    if (primary === "4C") {
      exactDataLength(data, 4, `vpass web row ${index}.data`);
      if (secondary !== "") throw new Error(`vpass web row ${index}.data[1] has schema drift`);
      boundedString(data[2], `vpass web row ${index}.data[2]`, false);
      return;
    }
    if (primary === "4K" && secondary === "002") {
      exactDataLength(data, 4, `vpass web row ${index}.data`);
      boundedString(data[3], `vpass web row ${index}.data[3]`, false);
      return;
    }
    if (primary !== "4K" || (secondary !== "005" && secondary !== "007"))
      throw new Error(`vpass web row ${index} has an unsupported provider subtype`);
    const expectedLength = secondary === "007" ? 14 : 11;
    if (data.length !== expectedLength)
      throw new Error(`vpass web row ${index}.data has schema drift`);
    const asOf = providerDate(data[3], scope.month, `vpass web row ${index}.data[3]`);
    const merchant = boundedString(data[4], `vpass web row ${index}.data[4]`, false);
    const paymentType = boundedString(data[6], `vpass web row ${index}.data[6]`, true);
    const amountText = data[5]!;
    const providerAmount =
      amountText === "" ? undefined : jpyInteger(amountText, `vpass web row ${index}.data[5]`);
    if (secondary === "007" && providerAmount === undefined)
      throw new Error(`vpass web row ${index}.data[5] must contain an amount`);
    const fingerprint = stableFingerprint({
      card: scope.card,
      month: scope.month,
      family: "web",
      row,
    });
    const occurrence = occurrences.get(fingerprint) ?? 0;
    occurrences.set(fingerprint, occurrence + 1);
    const amount = providerAmount === undefined ? undefined : invertLiability(providerAmount);
    observations.push({
      kind: "transaction",
      sourceAccount: `vpass:${scope.card}`,
      externalId: `vpass:${scope.card}:${scope.month}:web:${fingerprint}:${occurrence}`,
      status: "posted",
      ...(amount === undefined
        ? {}
        : { amountMinor: amount, amountText: String(amount), amountScale: 0 }),
      currency: "JPY",
      description: paymentType,
      counterparty: merchant,
      asOf,
      observedAt: canonicalInstant(artifact.fetchedAt, "artifact.fetchedAt"),
      rawLocator: `json:$.body.content.WebMeisaiTopDisplayServiceBean.meisaiList[${index}]`,
      extra: {
        ...row,
        _kogane: {
          canonicalDataset: "statement-page",
          statementFamily: "web",
          statementMonth: scope.month,
          pageKind: scope.pageKind,
          pageIndex: scope.pageIndex,
          providerSubtype: `${primary}/${secondary}`,
          appMapping: secondary === "007" ? "InstallmentWithCurrency" : "InstallmentWithComment",
          providerAmountSign: "credit-liability-positive-refund-negative",
          observationSign: "outflow-negative-inflow-positive",
          identityOrigin: "sanitized-row+card+month+family+occurrence",
        },
      },
    });
    if (providerAmount === undefined)
      warnings.push(
        `json:$.body.content.WebMeisaiTopDisplayServiceBean.meisaiList[${index}].data[5] has no provider amount`,
      );
  });
  return { observations, warnings };
}

function parseCustomized(
  content: Record<string, unknown>,
  value: unknown,
  artifact: ArtifactMeta,
  scope: Scope,
): ParseResult {
  exactKeys(content, CUSTOMIZED_CONTENT_KEYS, "vpass customized content");
  if (
    (scope.pageIndex === 0 && scope.pageKind !== "top") ||
    (scope.pageIndex > 0 && scope.pageKind !== "answer")
  ) {
    throw new Error("vpass customized page kind conflicts with page index");
  }
  const bean = requiredObject(value, "vpass customized bean");
  exactKeyVariant(
    bean,
    [CUSTOMIZED_BEAN_BASE, CUSTOMIZED_BEAN_WITH_SETTLEMENT, CUSTOMIZED_BEAN_WITH_ROWS],
    "vpass customized bean",
  );
  const rows =
    bean["meisaiList"] === undefined
      ? []
      : boundedArray(bean["meisaiList"], "vpass customized meisaiList");
  if (bean["pageFlg"] !== "3") throw new Error("vpass customized pageFlg is unsupported");
  const pageSize = boundedSafeInteger(bean["pageSize"], "vpass customized pageSize");
  if (pageSize === 0) throw new Error("vpass customized pageSize must be positive");
  digitStringInteger(bean["responseCnt"], "vpass customized responseCnt");
  boundedSafeInteger(bean["total"], "vpass customized total");
  if (bean["seikyuYM"] !== scope.month)
    throw new Error("vpass customized statement month conflicts with artifact key");
  const occurrences = new Map<string, number>();
  const observations: TransactionObservation[] = rows.map((entry, index) => {
    const row = requiredObject(entry, `vpass customized row ${index}`);
    exactKeys(row, CUSTOMIZED_ROW_KEYS, `vpass customized row ${index}`);
    for (const key of CUSTOMIZED_ROW_KEYS)
      boundedString(row[key], `vpass customized row ${index}.${key}`, true);
    const saleCode = row["uriageKbn"] as string;
    if (saleCode !== "5" && saleCode !== "6")
      throw new Error(`vpass customized row ${index}.uriageKbn is unsupported`);
    const providerAmount = jpyInteger(
      row["riyouKin"] as string,
      `vpass customized row ${index}.riyouKin`,
    );
    if ((saleCode === "5" && providerAmount <= 0) || (saleCode === "6" && providerAmount >= 0))
      throw new Error(`vpass customized row ${index} amount conflicts with uriageKbn`);
    const asOf = providerDate(
      row["riyouDate"],
      scope.month,
      `vpass customized row ${index}.riyouDate`,
    );
    const merchant = boundedString(row["kmName"], `vpass customized row ${index}.kmName`, false);
    const amount = invertLiability(providerAmount);
    const fingerprint = stableFingerprint({
      card: scope.card,
      month: scope.month,
      family: "customized",
      row,
    });
    const occurrence = occurrences.get(fingerprint) ?? 0;
    occurrences.set(fingerprint, occurrence + 1);
    return {
      kind: "transaction",
      sourceAccount: `vpass:${scope.card}`,
      externalId: `vpass:${scope.card}:${scope.month}:customized:${fingerprint}:${occurrence}`,
      status: "unconfirmed",
      amountMinor: amount,
      amountText: String(amount),
      amountScale: 0,
      currency: "JPY",
      description: row["bunkatsuYaku"] as string,
      counterparty: merchant,
      asOf,
      observedAt: canonicalInstant(artifact.fetchedAt, "artifact.fetchedAt"),
      rawLocator: `json:$.body.content.CustomizedMeisaiAnsDisplayServiceBean.meisaiList[${index}]`,
      extra: {
        ...row,
        _kogane: {
          canonicalDataset: "statement-page",
          statementFamily: "customized",
          statementMonth: scope.month,
          pageKind: scope.pageKind,
          pageIndex: scope.pageIndex,
          providerSaleCode: saleCode,
          providerAmountSign: "credit-liability-positive-refund-negative",
          observationSign: "outflow-negative-inflow-positive",
          identityOrigin: "sanitized-row+card+month+family+occurrence",
        },
      },
    };
  });
  return { observations, warnings: [] };
}

function artifactScope(artifact: ArtifactMeta): Scope {
  const match = artifact.artifactKey?.match(ARTIFACT_KEY);
  if (!match) throw new Error("vpass statement artifact key is invalid");
  const cardFromPath = match[1];
  const card = artifact.fetchUnitKey ?? cardFromPath;
  if (typeof card !== "string" || !/^card-\d{3}$/u.test(card))
    throw new Error("vpass statement fetch unit key is missing or invalid");
  if (cardFromPath !== undefined && cardFromPath !== card)
    throw new Error("vpass statement card identity does not match its fetch unit");
  const month = match[2]!;
  const year = Number(month.slice(0, 4));
  const monthNumber = Number(month.slice(4));
  if (year < 2000 || year > 2199 || monthNumber < 1 || monthNumber > 12)
    throw new Error("vpass statement month is invalid");
  return {
    card,
    month,
    pageKind: match[3] as "top" | "answer",
    pageIndex: Number(match[4]),
  };
}

function providerDate(value: unknown, statementMonth: string, label: string): string {
  const text = boundedString(value, label, false).normalize("NFKC").trim();
  const match = /^(\d{2})\/(\d{2})\/(\d{2})$/u.exec(text);
  if (!match) throw new Error(`${label} is not a provider YY/MM/DD date`);
  const year = Math.floor(Number(statementMonth.slice(0, 4)) / 100) * 100 + Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    throw new Error(`${label} is not a calendar date`);
  return `${String(year).padStart(4, "0")}-${match[2]}-${match[3]}`;
}

function jpyInteger(value: string, label: string): number {
  const text = value.normalize("NFKC").trim();
  if (!/^-?(?:0|[1-9]\d*|\d{1,3}(?:,\d{3})+)$/u.test(text))
    throw new Error(`${label} is not an exact JPY integer`);
  const amount = Number(text.replaceAll(",", ""));
  if (!Number.isSafeInteger(amount)) throw new Error(`${label} exceeds the safe integer range`);
  return amount;
}

function invertLiability(value: number): number {
  return value === 0 ? 0 : -value;
}

function parseObject(bytes: Uint8Array, label: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(decodeUtf8(bytes)) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError)
      throw new Error(`${label} must be valid JSON`, { cause: error });
    throw error;
  }
  return requiredObject(value, label);
}

function requiredObject(value: unknown, label: string): Record<string, unknown> {
  if (!isObject(value)) throw new Error(`${label} must be an object`);
  return value;
}

function boundedArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > 10_000)
    throw new Error(`${label} must be a bounded array`);
  return value;
}

function boundedStringArray(value: unknown, label: string): string[] {
  const array = boundedArray(value, label);
  if (array.some((entry) => typeof entry !== "string" || entry.length > 5_000))
    throw new Error(`${label} must contain only bounded strings`);
  return array as string[];
}

function exactDataLength(value: string[], expected: number, label: string): void {
  if (value.length !== expected) throw new Error(`${label} has schema drift`);
}

function boundedString(value: unknown, label: string, empty: boolean): string {
  if (typeof value !== "string" || value.length > 5_000 || (!empty && value.length === 0))
    throw new Error(`${label} must be a bounded${empty ? "" : " non-empty"} string`);
  return value;
}

function boundedSafeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 10_000)
    throw new Error(`${label} must be a bounded safe integer`);
  return value as number;
}

function digitStringInteger(value: unknown, label: string): number {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d*)$/u.test(value))
    throw new Error(`${label} must be an exact non-negative integer string`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > 10_000)
    throw new Error(`${label} must be a bounded exact non-negative integer string`);
  return parsed;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (!sameKeys(value, keys)) throw new Error(`${label} has schema drift`);
}

function exactKeyVariant(
  value: Record<string, unknown>,
  variants: readonly (readonly string[])[],
  label: string,
): void {
  if (!variants.some((keys) => sameKeys(value, keys))) throw new Error(`${label} has schema drift`);
}

function sameKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalInstant(value: string, label: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    new Date(value).toISOString() !== value
  )
    throw new Error(`${label} must be a canonical UTC instant`);
  return value;
}

function requireSuccessfulRun(artifact: ArtifactMeta): void {
  if (
    (artifact.runStatus !== "success" || artifact.runFailureCount !== 0) &&
    !unitScopeAdmitted(artifact)
  )
    throw new Error("Vpass observations require a successful failure-free fetch run");
}
