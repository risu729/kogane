import { decodeUtf8 } from "./util.ts";

export class SonyCsvDecodeError extends Error {
  constructor(
    readonly category: "media_type" | "charset" | "decode",
    message: string,
  ) {
    super(message);
  }
}

/** Sony's observed octet-stream export labels strict Shift-JIS bytes as UTF-8. */
export function decodeSonyCsv(bytes: Uint8Array, mediaType: string): string {
  const match =
    /^([a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+)(?:\s*;\s*charset=(?:"([a-z0-9._-]+)"|([a-z0-9._-]+)))?$/iu.exec(
      mediaType,
    );
  const bases = new Set([
    "text/csv",
    "application/csv",
    "application/x-csv",
    "text/plain",
    "application/octet-stream",
  ]);
  if (!match || !bases.has(match[1]!.toLowerCase()))
    throw new SonyCsvDecodeError("media_type", "Sony history CSV media type drift");
  const base = match[1]!.toLowerCase();
  const charset = (match[2] ?? match[3])?.toLowerCase().replaceAll("_", "-");
  const utf8 = charset === "utf-8" || charset === "utf8";
  if (
    charset &&
    !utf8 &&
    !["shift-jis", "shiftjis", "sjis", "windows-31j", "cp932"].includes(charset)
  )
    throw new SonyCsvDecodeError("charset", "Sony history CSV charset drift");
  if (charset && !utf8) return decodeShiftJis(bytes);
  try {
    return decodeUtf8(bytes);
  } catch {
    // The exception is confined to Sony's observed binary export. No lossy
    // decoder or schema fallback is permitted; callers still validate all rows.
    if (!charset || (utf8 && base === "application/octet-stream")) return decodeShiftJis(bytes);
    throw new SonyCsvDecodeError("decode", "Sony history CSV bytes are not valid UTF-8");
  }
}

function decodeShiftJis(bytes: Uint8Array): string {
  try {
    return new TextDecoder("shift-jis", { fatal: true }).decode(bytes);
  } catch {
    throw new SonyCsvDecodeError(
      "decode",
      "Sony history CSV bytes do not match the declared charset",
    );
  }
}
