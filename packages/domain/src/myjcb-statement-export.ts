/** Observed export envelopes only; no monetary rows are published from files. */
export type MyJcbExportKind = "csv" | "pdf" | "ofx";
export const MYJCB_CREDIT_CSV_HEADERS = [
  "ご利用者",
  "カテゴリ",
  "ご利用日",
  "ご利用先など",
  "ご利用金額(￥)",
  "支払区分",
  "今回回数",
  "訂正サイン",
  "お支払い金額(￥)",
  "国内／海外",
  "摘要",
  "備考",
] as const;

export function validateMyJcbCreditCsvText(csv: string): void {
  if (csv.includes("\0") || csv.charCodeAt(0) === 0xfeff || /(?<!\r)\n|\r(?!\n)/u.test(csv)) fail();
  const lines = csv.split("\r\n");
  const headers = lines.flatMap((line, index) =>
    columns(line)?.join("\0") === MYJCB_CREDIT_CSV_HEADERS.join("\0") ? [index] : [],
  );
  if (headers.length !== 1 || !lines.slice(0, headers[0]!).some((line) => line.trim() !== ""))
    fail();
}
function columns(line: string): string[] | null {
  const result: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (char === "," && !quoted) {
      result.push(value);
      value = "";
    } else value += char;
  }
  if (quoted) return null;
  return [...result, value];
}
export function validateMyJcbCreditExport(kind: MyJcbExportKind, bytes: Uint8Array): void {
  if (bytes.length === 0 || bytes.length > 8 * 1024 * 1024) fail();
  if (kind === "pdf") {
    if (
      new TextDecoder("ascii").decode(bytes.subarray(0, 8)) !== "%PDF-1.4" ||
      !/%%EOF[\t\r\n ]*$/u.test(new TextDecoder("ascii").decode(bytes.subarray(-1024)))
    )
      fail();
    return;
  }
  if (kind === "csv") {
    validateMyJcbCreditCsvText(new TextDecoder("shift_jis", { fatal: true }).decode(bytes));
    return;
  }
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (text.includes("\r") || !text.endsWith("\n")) fail();
  const root = text.indexOf("<OFX>");
  if (root < 0 || !/^OFXHEADER:100(?:\r?\n)/u.test(text) || !/<\/OFX>\s*$/u.test(text)) fail();
  const headers = new Map<string, string>();
  for (const line of text
    .slice(0, root)
    .split(/\r?\n/u)
    .filter((line) => line !== "")) {
    const match = /^([A-Z]+):([^\r\n]*)$/u.exec(line);
    if (!match || headers.has(match[1]!)) fail();
    headers.set(match[1]!, match[2]!);
  }
  for (const [name, value] of Object.entries({
    OFXHEADER: "100",
    DATA: "OFXSGML",
    VERSION: "102",
    SECURITY: "NONE",
    ENCODING: "UTF-8",
    CHARSET: "CSUNICODE",
    COMPRESSION: "NONE",
  }))
    if (headers.get(name) !== value) fail();
  if (!/<CREDITCARDMSGSRSV1>/u.test(text) || !/<CCSTMTRS>/u.test(text)) fail();
}
function fail(): never {
  throw new Error("myjcb_statement_export_unsupported");
}
