// The `card_debit_account_sweep` lane (ADR 0032 and its 2026-09-27
// amendment, docs/card-settlements.md, Provider-stated debit accounts): the
// 「カード情報」 table of each stored MyJCB credit detail page becomes one
// `card_debit_account_statement` row (migration 0060).
//
//   * It reads pages the pipeline already admitted: artifacts whose
//     `myjcb-credit-statement-total` parse is published. The page's bytes are
//     re-read from R2 and checked against their digest, as a parse job does.
//   * One row per card, raw object and reader version. The same bytes stored
//     by several runs are read once; the lane's selection is an anti-join on
//     that key, so it needs no cursor, and running it again writes nothing.
//   * A page whose table has another shape is a `refused` row with a closed
//     code (INV05), so it is not read again under the same reader version.
//   * The account holder's name and the card name are never read: nothing
//     uses them. The log line and tick record carry counts only.
import { parse } from "parse5";
import {
  readMyJcbCardInformation,
  type CardInformationReading,
} from "../../../packages/domain/src/myjcb-card-information.ts";
import type { StatementPageNode } from "../../../packages/domain/src/myjcb-statement-page.ts";
import {
  bankAccountReference,
  bankSourceIdForDisplayedName,
  debitAccountTypeForDisplayedText,
  type BankAccountReference,
  type CardDebitAccountStatement,
} from "../../../packages/domain/src/card-debit-account.ts";

/** The version of `readMyJcbCardInformation` a row records. A changed reading
 * is a new version and new rows; old rows stay. */
export const CARD_INFORMATION_READER_VERSION = "myjcb-card-information-1.0.0";
/** Pages read per tick. */
const CARD_DEBIT_ACCOUNT_BATCH = 20;
const MAX_PAGE_BYTES = 3_000_000;

export interface CardDebitAccountSweepResult {
  /** Pages examined this tick. */
  scanned: number;
  /** Pages whose table was read. */
  read: number;
  /** Pages refused with a closed code. */
  refused: number;
  /** Rows this tick newly wrote. */
  written: number;
}

interface PageRow {
  id: number;
  artifact_key: string;
  sha256: string;
  fetched_at_ms: number;
  blob_key: string;
  byte_size: number;
  parse_run_id: number;
}

/** `myjcb:<connection>:root`, derived from the artifact key exactly as the
 * statement parser derives the source account of the page's total. */
const CARD_SOURCE_ACCOUNT_SQL = `'myjcb:'||substr(a.artifact_key,1,instr(a.artifact_key,'/')-1)||':root'`;

/**
 * Published statement pages without a reading under `?1`, oldest first, at
 * most `?2`. The anti-join probes the unique key of
 * `card_debit_account_statement`. Only keys whose connection segment has the
 * shape the table's CHECK accepts (`[a-z0-9][a-z0-9-]{0,63}`, one `/`) are
 * selected: any other key could never be written, and selecting it would
 * fail the lane on the same page every tick.
 */
const CARD_DEBIT_ACCOUNT_PAGES_SQL = `SELECT a.id,a.artifact_key,a.sha256,
 coalesce(a.fetched_at_ms,a.recorded_at_ms) AS fetched_at_ms,o.blob_key,o.byte_size,pp.parse_run_id
 FROM fetch_artifacts a
 JOIN published_parse_runs pp ON pp.fetch_artifact_id=a.id AND pp.parser_name='myjcb-credit-statement-total'
 JOIN raw_objects o ON o.sha256=a.sha256
 WHERE a.source_id='myjcb' AND a.dataset='credit-detail'
  AND a.artifact_key GLOB '[a-z0-9]*/credit-detail-[01][0-9].html'
  AND instr(a.artifact_key,'/') BETWEEN 2 AND 65
  AND substr(a.artifact_key,1,instr(a.artifact_key,'/')-1) NOT GLOB '*[^a-z0-9-]*'
  AND substr(a.artifact_key,instr(a.artifact_key,'/')+1) GLOB 'credit-detail-[01][0-9].html'
  AND NOT EXISTS(SELECT 1 FROM card_debit_account_statement s
   WHERE s.raw_sha256=a.sha256 AND s.card_source_account=${CARD_SOURCE_ACCOUNT_SQL} AND s.reader_version=?1)
 ORDER BY a.id LIMIT ?2`;

const INSERT_SQL = `INSERT INTO card_debit_account_statement(source_id,card_source_account,fetch_artifact_id,
 statement_parse_run_id,raw_sha256,source_object_key,observed_at,reader_version,outcome,refusal_code,
 bank_name,branch_name,account_type,leading_digits,masked_digit_count,created_at)
 SELECT 'myjcb',?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15
 WHERE NOT EXISTS(SELECT 1 FROM card_debit_account_statement
  WHERE raw_sha256=?4 AND card_source_account=?1 AND reader_version=?7)`;

/** Reads the 「カード情報」 table of one MyJCB page's HTML. */
export function parseCardInformation(html: string): CardInformationReading {
  return readMyJcbCardInformation(parse(html) as unknown as StatementPageNode);
}

type PageReading = CardInformationReading | { outcome: "refused"; code: "page_not_utf8" };

async function readPage(
  bucket: R2Bucket,
  row: PageRow,
): Promise<PageReading | { outcome: "refused"; code: "raw_object_unreadable" }> {
  const unreadable = { outcome: "refused", code: "raw_object_unreadable" } as const;
  if (row.byte_size > MAX_PAGE_BYTES) return unreadable;
  const object = await bucket.get(row.blob_key);
  if (!object || object.size !== row.byte_size) return unreadable;
  const bytes = new Uint8Array(await object.arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  if (Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("") !== row.sha256)
    return unreadable;
  let html: string;
  try {
    html = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { outcome: "refused", code: "page_not_utf8" };
  }
  return parseCardInformation(html);
}

export async function cardDebitAccountSweep(
  env: { DB: D1Database; EVIDENCE: R2Bucket },
  options: { limit?: number; now?: string } = {},
): Promise<CardDebitAccountSweepResult> {
  const pages = await env.DB.prepare(CARD_DEBIT_ACCOUNT_PAGES_SQL)
    .bind(CARD_INFORMATION_READER_VERSION, options.limit ?? CARD_DEBIT_ACCOUNT_BATCH)
    .all<PageRow>();
  const result: CardDebitAccountSweepResult = { scanned: 0, read: 0, refused: 0, written: 0 };
  for (const page of pages.results) {
    result.scanned++;
    const reading = await readPage(env.EVIDENCE, page);
    const connection = page.artifact_key.slice(0, page.artifact_key.indexOf("/"));
    const info = reading.outcome === "read" ? reading.information : null;
    if (info) result.read++;
    else result.refused++;
    const inserted = await env.DB.prepare(INSERT_SQL)
      .bind(
        `myjcb:${connection}:root`,
        page.id,
        page.parse_run_id,
        page.sha256,
        page.blob_key,
        new Date(page.fetched_at_ms).toISOString(),
        CARD_INFORMATION_READER_VERSION,
        info ? "read" : "refused",
        reading.outcome === "refused" ? reading.code : null,
        info?.bankName ?? null,
        info?.branchName ?? null,
        info?.accountType ?? null,
        info?.leadingDigits ?? null,
        info?.maskedDigitCount ?? null,
        options.now ?? new Date().toISOString(),
      )
      .run();
    result.written += inserted.meta.changes;
  }
  return result;
}

interface StatementRow {
  id: number;
  card_source_account: string;
  bank_name: string;
  branch_name: string;
  account_type: string;
  leading_digits: string;
  masked_digit_count: number;
}

/**
 * The debit-account reading of the page a MyJCB statement total was parsed
 * from (`?1` its parse run, `?2` its source account), under the current
 * reader version. The statement and its debit account come from the same
 * bytes, so each statement carries its own stated account.
 */
const STATEMENT_FOR_PARSE_SQL = `SELECT s.id,s.card_source_account,s.bank_name,s.branch_name,s.account_type,
 s.leading_digits,s.masked_digit_count
 FROM parse_runs p JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id
 JOIN card_debit_account_statement s ON s.raw_sha256=a.sha256 AND s.card_source_account=?2 AND s.reader_version=?3
 WHERE p.id=?1 AND s.outcome='read' LIMIT 1`;

export async function debitAccountStatementForParse(
  db: D1Database,
  parseRunId: number,
  cardSourceAccount: string,
): Promise<CardDebitAccountStatement | null> {
  const row = await db
    .prepare(STATEMENT_FOR_PARSE_SQL)
    .bind(parseRunId, cardSourceAccount, CARD_INFORMATION_READER_VERSION)
    .first<StatementRow>();
  if (!row) return null;
  return {
    ref: {
      kind: "typed-claim",
      id: `card_debit_account_statement:${row.id}`,
      revision: `reader:${CARD_INFORMATION_READER_VERSION}`,
    },
    sourceId: "myjcb",
    sourceAccount: row.card_source_account,
    displayed: {
      bankName: row.bank_name,
      branchName: row.branch_name,
      accountType: row.account_type,
      leadingDigits: row.leading_digits,
      maskedDigitCount: row.masked_digit_count,
    },
    bankSourceId: bankSourceIdForDisplayedName(row.bank_name),
    accountType: debitAccountTypeForDisplayedText(row.account_type),
  };
}

/** How many source accounts of one bank the rule may be given; beyond this
 * uniqueness is not judged and the caller records nothing. */
const KNOWN_BANK_ACCOUNT_LIMIT = 100;

/**
 * The accounts Kogane knows at one bank: the distinct source accounts its
 * identity rules recorded (`source_accounts.reference_json[0]`), read
 * through the (source_id, …) unique index. `null` when there are more than
 * KNOWN_BANK_ACCOUNT_LIMIT.
 */
export async function knownBankAccounts(
  db: D1Database,
  bankSourceId: string,
): Promise<BankAccountReference[] | null> {
  const rows = await db
    .prepare(
      `SELECT DISTINCT json_extract(reference_json,'$[0]') AS source_account FROM source_accounts
       WHERE source_id=?1 AND json_type(reference_json,'$[0]')='text' ORDER BY 1 LIMIT ?2`,
    )
    .bind(bankSourceId, KNOWN_BANK_ACCOUNT_LIMIT + 1)
    .all<{ source_account: string }>();
  if (rows.results.length > KNOWN_BANK_ACCOUNT_LIMIT) return null;
  return rows.results.map((row) => bankAccountReference(bankSourceId, row.source_account));
}
