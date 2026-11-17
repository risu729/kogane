import { parseAssetHistoryJson } from "../../../packages/parsers/src/parsers/sbi-asset-history-json";
import { sha256Hex } from "../../../packages/collection/src/digest";
import { MailboxError } from "./mailbox-bootstrap";

const ROW_STRINGS = [
  "readSts",
  "sBaseDate",
  "sName",
  "sType",
  "kofuInfoKtitle",
  "busiSys",
  "kofuHms",
  "etsuranKigen",
  "sIntFileId",
  "sOriFileId",
  "sCount",
  "sCd",
  "sCdSeq",
  "userTokuteiId",
  "sTypeCd",
  "starSts",
  "sDoiyoKbn",
  "rDoiyoKbn",
] as const;
const ROW_NULLS = ["kofuInfoKinfo", "kofuDetailList", "kakuninFlg"] as const;
const DETAIL_STRINGS = [
  "kofuInfoKinfo",
  "kofuInfo",
  "readSts",
  "readHms",
  "tsuchiInfo",
  "sDoiyoKbn",
  "rDoiyoKbn",
  "sTypeCd",
] as const;
const DETAIL_NULLABLE = ["torizanKbn", "tsuchiInfoKinfo"] as const;
const DETAIL_NULLS = ["doiHms", "doiCreateSts", "doiHonbun", "doiComment", "kakuninFlg"] as const;
const KINDS = new Set([
  "FR81011D02",
  "STWHAB019P",
  "STWHAB001P",
  "STWHZB120P",
  "STWHAB202P",
  "FR00011M01",
  "FR81011D03",
  "STWHAB240P",
]);
const COMMON = ["ctt", "code", "message"];
const MAX_ROWS = 1000;
type JsonObject = Record<string, unknown>;
export type MailboxRow = Record<(typeof ROW_STRINGS)[number], string> &
  Record<(typeof ROW_NULLS)[number], null>;
export interface MailboxFile {
  readonly sOriFileId: string;
  readonly sIntFileId: string;
}
export interface MailboxDetail {
  readonly sTypeCd: " ";
  readonly kofuDetailList: readonly [MailboxFile];
}
export interface MailboxInventory {
  readonly rows: readonly MailboxRow[];
  readonly total: number;
}

/** Audit original syntax, duplicate decoded keys and exact integer counts first. */
export function mailboxJson(bytes: Uint8Array): unknown {
  try {
    if (bytes.byteLength > 2 * 1024 * 1024) refuse();
    return parseAssetHistoryJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    refuse();
  }
}

/** The current unpaged list needs corroboration from the independently issued summary. */
export function mailboxInventory(listValue: unknown, summaryValue: unknown): MailboxInventory {
  const list = envelope(listValue, ["outlist", "allCountKen"]);
  const summary = envelope(summaryValue, ["summaryList"]);
  if (!Array.isArray(list.outlist) || list.outlist.length > MAX_ROWS) refuse();
  const total = count(list.allCountKen);
  if (total !== list.outlist.length) incomplete();
  if (!Array.isArray(summary.summaryList) || summary.summaryList.length > MAX_ROWS) refuse();
  const groups = new Map<string, { issued: number; listed: number }>();
  let issuedTotal = 0;
  for (const value of summary.summaryList) {
    const group = object(value, ["busiSys", "userTokuteiId", "kofuKensu", "mikaifuKensu"]);
    const key = groupIdentity(string(group.busiSys), string(group.userTokuteiId));
    const issued = count(group.kofuKensu);
    if (count(group.mikaifuKensu) > issued || groups.has(key)) refuse();
    groups.set(key, { issued, listed: 0 });
    issuedTotal += issued;
    if (!Number.isSafeInteger(issuedTotal)) refuse();
  }
  if (issuedTotal !== total) incomplete();
  const identities = new Set<string>();
  const rows = list.outlist.map((value) => {
    const row = object(value, [...ROW_STRINGS, ...ROW_NULLS]);
    for (const key of ROW_STRINGS) string(row[key]);
    for (const key of ROW_NULLS) if (row[key] !== null) refuse();
    const checked = row as MailboxRow;
    if (!validDocumentDate(checked.sBaseDate) || !checked.sCd) refuse();
    if (!checked.userTokuteiId || !checked.sCdSeq || !checked.busiSys) refuse();
    const identity = rowIdentity(checked);
    if (identities.has(identity)) incomplete();
    identities.add(identity);
    const group = groups.get(groupIdentity(checked.busiSys, checked.userTokuteiId));
    if (!group) incomplete();
    group.listed++;
    return checked;
  });
  for (const group of groups.values()) if (group.issued !== group.listed) incomplete();
  return { rows, total };
}

/** Only the actually witnessed single-PDF detail shape is supported. */
export function mailboxDetail(value: unknown): MailboxDetail {
  const detail = envelope(value, [
    ...DETAIL_STRINGS,
    ...DETAIL_NULLS,
    ...DETAIL_NULLABLE,
    "kofuDetailList",
  ]);
  for (const key of DETAIL_STRINGS) string(detail[key]);
  for (const key of DETAIL_NULLABLE) if (detail[key] !== null) string(detail[key]);
  for (const key of DETAIL_NULLS) if (detail[key] !== null) refuse();
  if (
    detail.sTypeCd !== " " ||
    !Array.isArray(detail.kofuDetailList) ||
    detail.kofuDetailList.length !== 1
  )
    throw new MailboxError("sbi_mailbox_document_unobserved");
  const file = object(detail.kofuDetailList[0], ["sOriFileId", "sIntFileId"]);
  const sOriFileId = string(file.sOriFileId);
  const sIntFileId = string(file.sIntFileId);
  if (!sOriFileId.toLowerCase().endsWith(".pdf") || !sIntFileId)
    throw new MailboxError("sbi_mailbox_document_unobserved");
  return { sTypeCd: " ", kofuDetailList: [{ sOriFileId, sIntFileId }] };
}

/** Unsupported siblings keep their metadata and fail only their own document unit. */
export function assertSupportedMailboxRow(row: MailboxRow): void {
  if (!KINDS.has(row.sCd) || row.sTypeCd !== " ")
    throw new MailboxError("sbi_mailbox_document_unobserved");
}

export function mailboxDetailFields(row: MailboxRow): Record<string, string> {
  return {
    userTokuteiId: row.userTokuteiId,
    sCd: row.sCd,
    sBaseDate: row.sBaseDate,
    sCdSeq: row.sCdSeq,
  };
}

export function mailboxPdfFields(row: MailboxRow, detail: MailboxDetail): Record<string, string> {
  return {
    ...mailboxDetailFields(row),
    sTypeCd: detail.sTypeCd,
    sIntFileIds: detail.kofuDetailList[0].sIntFileId,
    xmlPreviewFlg: "0",
  };
}

/** The stable row id is independent of response order, read state and PDF bytes. */
export function rowIdentity(row: MailboxRow): string {
  return JSON.stringify([row.busiSys, row.userTokuteiId, row.sCd, row.sBaseDate, row.sCdSeq]);
}

export async function mailboxDocumentIdentity(
  row: MailboxRow,
): Promise<{ kind: string; identity: string }> {
  const encode = (value: string) => new TextEncoder().encode(value);
  return {
    kind: await sha256Hex(encode(row.sCd)),
    identity: await sha256Hex(encode(rowIdentity(row))),
  };
}

export function validDocumentDate(value: string): boolean {
  if (!/^\d{8}$/u.test(value) || value.startsWith("0000")) return false;
  const date = new Date(
    `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6)}T00:00:00.000Z`,
  );
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10).replaceAll("-", "") === value
  );
}

function envelope(value: unknown, keys: readonly string[]): JsonObject {
  const result = object(value, [...COMMON, ...keys]);
  if (result.ctt !== null || result.code !== "200000") refuse();
  string(result.message);
  return result;
}

function object(value: unknown, keys: readonly string[]): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) refuse();
  const object = value as JsonObject;
  if (Object.keys(object).length !== keys.length || keys.some((key) => !Object.hasOwn(object, key)))
    refuse();
  return object;
}

function string(value: unknown): string {
  if (typeof value !== "string" || value.length > 16384) refuse();
  return value;
}

function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > MAX_ROWS)
    refuse();
  return value;
}

function groupIdentity(business: string, user: string): string {
  return JSON.stringify([business, user]);
}

function refuse(): never {
  throw new MailboxError("sbi_mailbox_response_unobserved");
}

function incomplete(): never {
  throw new MailboxError("sbi_mailbox_inventory_incomplete");
}
