// The observed export is an ordinary, unencrypted ZIP with two deflate CSVs.
// ZIP structure: https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT
const MAX_CSV_BYTES = 8 * 1024 * 1024;
const TRADE_HEADERS = [
  "約定日時",
  "取引番号",
  "取引区分",
  "銘柄",
  "注文先（自己または委託の別）",
  "売買",
  "数量",
  "約定レート",
  "建玉損益",
  "建玉損益（円）",
  "取引手数料",
  "ファンディングレート（円）",
  "決済損益（円）",
  "円転レート",
];
const CASH_PREFIX_HEADERS = [
  "日時",
  "入出金の種別",
  "暗号資産/通貨",
  "数量",
  "評価レート",
  "入出金額（円）",
];

export interface PnlCsvCounts {
  executions: number;
  cashflows: number;
  executionIds: string[];
  executionDates: string[];
}

export async function inspectPnlZip(bytes: Uint8Array, basisDate: string): Promise<PnlCsvCounts> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fail = (): never => {
    throw new Error("pnl_zip_invalid");
  };
  if (bytes.length < 22 || view.getUint32(0, true) !== 0x04034b50) fail();
  let end = bytes.length - 22;
  const minimumEnd = Math.max(0, bytes.length - 22 - 65535);
  for (; end >= minimumEnd; end -= 1)
    if (
      view.getUint32(end, true) === 0x06054b50 &&
      end + 22 + view.getUint16(end + 20, true) === bytes.length
    )
      break;
  if (
    end < minimumEnd ||
    view.getUint16(end + 4, true) !== 0 ||
    view.getUint16(end + 6, true) !== 0 ||
    view.getUint16(end + 8, true) !== 2 ||
    view.getUint16(end + 10, true) !== 2
  )
    fail();
  const directory = view.getUint32(end + 16, true);
  if (directory + view.getUint32(end + 12, true) !== end) fail();
  const files = new Map<string, string[][]>();
  let at = directory;
  for (let entry = 0; entry < 2; entry += 1) {
    if (at + 46 > end || view.getUint32(at, true) !== 0x02014b50) fail();
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const size = view.getUint32(at + 20, true);
    const expanded = view.getUint32(at + 24, true);
    const nameSize = view.getUint16(at + 28, true);
    const next = at + 46 + nameSize + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    if (
      (flags & 1) !== 0 ||
      method !== 8 ||
      expanded > MAX_CSV_BYTES ||
      next > end ||
      view.getUint16(at + 34, true) !== 0 ||
      local + 30 > directory
    )
      fail();
    const name = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(at + 46, at + 46 + nameSize),
    );
    const kind = /^TRADE_RECORD_LIST[^/\\]*\.csv$/u.test(name)
      ? "executions"
      : /^CASHFLOW[^/\\]*\.csv$/u.test(name)
        ? "cashflows"
        : fail();
    if (
      files.has(kind) ||
      view.getUint32(local, true) !== 0x04034b50 ||
      view.getUint16(local + 6, true) !== flags ||
      view.getUint16(local + 8, true) !== method
    )
      fail();
    const localNameSize = view.getUint16(local + 26, true);
    const start = local + 30 + localNameSize + view.getUint16(local + 28, true);
    if (
      start + size > directory ||
      new TextDecoder("utf-8", { fatal: true }).decode(
        bytes.subarray(local + 30, local + 30 + localNameSize),
      ) !== name
    )
      fail();
    const input = bytes.slice(start, start + size);
    const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let count = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        count += part.value.byteLength;
        if (count > expanded || count > MAX_CSV_BYTES) {
          await reader.cancel();
          fail();
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    const output = new Uint8Array(count);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    if (count !== expanded || crc32(output) !== crc) fail();
    const rows = parseCsv(new TextDecoder("utf-8", { fatal: true }).decode(output));
    const headers = rows[0];
    if (
      headers === undefined ||
      (kind === "executions"
        ? headers.length !== TRADE_HEADERS.length ||
          TRADE_HEADERS.some((header, index) => headers[index] !== header)
        : !validCashHeaders(headers))
    )
      throw new Error("pnl_csv_schema_unobserved");
    for (const row of rows.slice(1)) {
      if (
        row.length !== headers.length ||
        !validTimestamp(row[0]!) ||
        row[0]!.slice(0, 7).replace("/", "") !== basisDate.slice(0, 6)
      )
        throw new Error("pnl_csv_period_mismatch");
    }
    files.set(kind, rows);
    at = next;
  }
  if (at !== end || files.size !== 2) fail();
  const executionIds = files
    .get("executions")!
    .slice(1)
    .map((row) => row[1]!);
  if (
    executionIds.some((id) => id.trim() === "") ||
    new Set(executionIds).size !== executionIds.length
  )
    throw new Error("pnl_csv_execution_identity_invalid");
  return {
    executions: executionIds.length,
    cashflows: files.get("cashflows")!.length - 1,
    executionIds,
    executionDates: files
      .get("executions")!
      .slice(1)
      .map((row) => row[0]!),
  };
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validCashHeaders(headers: string[]): boolean {
  const balances = headers.slice(CASH_PREFIX_HEADERS.length, -1);
  return (
    CASH_PREFIX_HEADERS.every((header, index) => headers[index] === header) &&
    headers.at(-1) === "備考" &&
    balances.length > 0 &&
    balances.length <= 128 &&
    new Set(balances).size === balances.length &&
    balances.every((header) => /^残高_[A-Z0-9]+$/u.test(header))
  );
}

function validTimestamp(text: string): boolean {
  const match = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2}):(\d{2})$/u.exec(text);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() + 1 === month &&
    date.getUTCDate() === day &&
    date.getUTCHours() === hour &&
    date.getUTCMinutes() === minute &&
    date.getUTCSeconds() === second
  );
}

function parseCsv(input: string): string[][] {
  const text = input.replace(/^\uFEFF/u, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let closed = false;
  for (let at = 0; at < text.length; at += 1) {
    const char = text[at]!;
    if (quoted) {
      if (char === '"' && text[at + 1] === '"') {
        cell += '"';
        at += 1;
      } else if (char === '"') {
        quoted = false;
        closed = true;
      } else cell += char;
    } else if (char === '"' && cell === "" && !closed) quoted = true;
    else if (char === "," || char === "\n" || char === "\r") {
      row.push(cell);
      cell = "";
      closed = false;
      if (char !== ",") {
        rows.push(row);
        row = [];
        if (char === "\r" && text[at + 1] === "\n") at += 1;
      }
    } else if (closed || char === '"') throw new Error("pnl_csv_invalid");
    else cell += char;
  }
  if (quoted) throw new Error("pnl_csv_invalid");
  if (cell !== "" || row.length > 0 || closed) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}
