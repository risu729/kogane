// Independent synthetic CSV and ordinary ZIP fixtures for the observed export.
export const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\nSynthetic private report\n%%EOF\n");
const TRADE_HEADER =
  "約定日時,取引番号,取引区分,銘柄,注文先（自己または委託の別）,売買,数量,約定レート,建玉損益,建玉損益（円）,取引手数料,ファンディングレート（円）,決済損益（円）,円転レート";
const CASH_HEADER =
  "日時,入出金の種別,暗号資産/通貨,数量,評価レート,入出金額（円）,残高_JPY,残高_USDC,残高_BTC,残高_ETH,残高_XRP,残高_LTC,残高_BCH,残高_DOT,残高_LINK,残高_ADA,残高_DOGE,残高_XLM,残高_XTZ,残高_SOL,残高_AVAX,残高_MATIC,残高_FLR,残高_OAS,残高_XDC,残高_SHIB,残高_DAI,残高_ATOM,残高_APT,残高_HBAR,残高_ZPG,残高_NEAR,残高_NIDT,残高_ALGO,残高_APE,残高_AXS,残高_BAT,残高_CHZ,残高_ENJ,残高_ETC,残高_FCR,残高_MKR,残高_MONA,残高_OMG,残高_SAND,残高_TRX,備考";
const CASH_HEADER_LATEST =
  "日時,入出金の種別,暗号資産/通貨,数量,評価レート,入出金額（円）,残高_JPY,残高_BTC,残高_JPYSC,残高_ETH,残高_XRP,残高_SOL,残高_XLM,残高_ADA,残高_HBAR,残高_LINK,残高_ATOM,残高_TRX,残高_XDC,残高_DOGE,残高_SUI,残高_SHIB,残高_CANTON,残高_BCH,残高_LTC,残高_TON,残高_AVAX,残高_NEAR,残高_DOT,残高_POL,残高_ALGO,残高_FLR,残高_CHZ,残高_BERA,残高_NIDT,残高_ZPG,残高_USDC,残高_RLUSD,残高_DAI,残高_ETC,残高_APT,残高_XTZ,残高_SAND,残高_AXS,残高_BAT,残高_APE,残高_OAS,残高_OMG,残高_MKR,残高_ENJ,残高_MONA,残高_FCR,備考";
const csvCell = (text: string) =>
  /[",\r\n]/u.test(text) ? `"${text.replaceAll('"', '""')}"` : text;

export async function pnlZip(
  options: {
    executionIds?: string[];
    cashflows?: number;
    date?: string;
    badHeader?: boolean;
    corruptCrc?: boolean;
    extraFile?: boolean;
    tradeCsv?: string;
    cashHeader?: string;
    latestBalances?: boolean;
  } = {},
): Promise<Uint8Array> {
  const date = options.date ?? "2026/09/06 12:34:56";
  const trades =
    options.tradeCsv ??
    [
      options.badHeader
        ? `unknown,${TRADE_HEADER.slice(TRADE_HEADER.indexOf(",") + 1)}`
        : TRADE_HEADER,
      ...(options.executionIds ?? ["synthetic-execution-1"]).map((id) =>
        [date, id, "現物", "BTC/JPY", "取引所（委託）", "買", "0.1", "1", "", "", "0", "", "", ""]
          .map(csvCell)
          .join(","),
      ),
    ].join("\r\n") + "\r\n";
  const cashHeader =
    options.cashHeader ?? (options.latestBalances ? CASH_HEADER_LATEST : CASH_HEADER);
  const cash =
    [
      cashHeader,
      ...Array.from({ length: options.cashflows ?? 1 }, () => {
        const row = Array<string>(cashHeader.split(",").length).fill("");
        row[0] = date;
        row[1] = "synthetic movement";
        row[2] = "BTC";
        row[3] = "0.1";
        row[row.length - 1] = 'synthetic note,\r\n"quoted"';
        return row.map(csvCell).join(",");
      }),
    ].join("\r\n") + "\r\n";
  const files = [
    ["TRADE_RECORD_LIST_SYNTHETIC.csv", trades],
    ["CASHFLOW_SYNTHETIC.csv", cash],
    ...(options.extraFile ? [["unexpected.csv", "unknown"]] : []),
  ];
  const locals: Uint8Array[] = [];
  const directory: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of files) {
    const filename = new TextEncoder().encode(name!);
    const data = new TextEncoder().encode(content!);
    const compressed = new Uint8Array(
      await new Response(
        new Blob([data]).stream().pipeThrough(new CompressionStream("deflate-raw")),
      ).arrayBuffer(),
    );
    const crc = checksum(data);
    const local = new Uint8Array(30 + filename.length + compressed.length);
    const a = new DataView(local.buffer);
    a.setUint32(0, 0x04034b50, true);
    a.setUint16(4, 20, true);
    a.setUint16(6, 0x0800, true);
    a.setUint16(8, 8, true);
    a.setUint32(14, crc, true);
    a.setUint32(18, compressed.length, true);
    a.setUint32(22, data.length, true);
    a.setUint16(26, filename.length, true);
    local.set(filename, 30);
    local.set(compressed, 30 + filename.length);
    locals.push(local);
    const central = new Uint8Array(46 + filename.length);
    const b = new DataView(central.buffer);
    b.setUint32(0, 0x02014b50, true);
    b.setUint16(4, 20, true);
    b.setUint16(6, 20, true);
    b.setUint16(8, 0x0800, true);
    b.setUint16(10, 8, true);
    b.setUint32(16, options.corruptCrc ? crc ^ 1 : crc, true);
    b.setUint32(20, compressed.length, true);
    b.setUint32(24, data.length, true);
    b.setUint16(28, filename.length, true);
    b.setUint32(42, offset, true);
    central.set(filename, 46);
    directory.push(central);
    offset += local.length;
  }
  const directorySize = directory.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true);
  e.setUint16(8, files.length, true);
  e.setUint16(10, files.length, true);
  e.setUint32(12, directorySize, true);
  e.setUint32(16, offset, true);
  const output = new Uint8Array(offset + directorySize + end.length);
  let at = 0;
  for (const part of [...locals, ...directory, end]) {
    output.set(part, at);
    at += part.length;
  }
  return output;
}
function checksum(bytes: Uint8Array): number {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ -1) >>> 0;
}
