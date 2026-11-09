// Inspect original JSON number tokens before Number conversion. The closed
// history schema permits fractional numbers only for profitLossRate metadata;
// all financial amounts and native timestamp/value pairs are safe integers.
import {
  decimalFromString,
  normalizeDecimal,
  DECIMAL_DIGIT_LIMIT,
} from "../../../domain/src/values";
import { assetHistoryError, isAssetHistoryError } from "./sbi-asset-history-schema";

const TOKENS = /"(?:[^"\\]|\\[\s\S])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/gu;
const SAFE = BigInt(Number.MAX_SAFE_INTEGER);

function exactSafeInteger(token: string): string | undefined {
  if (token.length > DECIMAL_DIGIT_LIMIT) return undefined;
  const [mantissa, power] = token.split(/[eE]/u);
  const parsed = decimalFromString(mantissa!);
  const exponent = Number(power ?? 0);
  if (!parsed.ok || !Number.isSafeInteger(exponent) || Math.abs(exponent) > DECIMAL_DIGIT_LIMIT)
    return undefined;
  const exact = normalizeDecimal(BigInt(parsed.value.coefficient), parsed.value.scale - exponent);
  const integer = BigInt(exact.coefficient);
  return exact.scale === 0 && integer >= -SAFE && integer <= SAFE ? exact.coefficient : undefined;
}

function read(text: string, auditOnly: boolean): unknown {
  let previousString: { value: string; end: number } | undefined;
  let end = 0;
  const parts: string[] = [];
  try {
    for (const match of text.matchAll(TOKENS)) {
      const token = match[0];
      const start = match.index;
      parts.push(text.slice(end, start));
      let replacement = token;
      if (token.startsWith('"')) {
        previousString = { value: JSON.parse(token) as string, end: start + token.length };
      } else {
        const rate =
          previousString?.value === "profitLossRate" &&
          /^\s*:\s*$/u.test(text.slice(previousString.end, start));
        const integer = rate ? undefined : exactSafeInteger(token);
        const valid = rate ? Number.isFinite(Number(token)) : integer !== undefined;
        if (integer !== undefined) replacement = integer;
        if (!valid) {
          if (!auditOnly)
            throw assetHistoryError(rate ? "sbi_asset_history_schema" : "sbi_asset_history_money");
          // A shape-only stand-in, also shaped like a native timestamp. It
          // cannot become a fact: derivation re-reads the ORIGINAL bytes in
          // strict mode. Strings and keys are never changed by this audit.
          replacement = "1000000000000";
        }
      }
      parts.push(replacement);
      end = start + token.length;
    }
    parts.push(text.slice(end));
    return JSON.parse(parts.join("")) as unknown;
  } catch (cause) {
    if (isAssetHistoryError(cause)) throw cause;
    throw assetHistoryError("sbi_asset_history_schema", { cause });
  }
}

/** Canonical data: every monetary token was proved an exact safe integer. */
export function parseAssetHistoryJson(text: string): unknown {
  return read(text, false);
}

/** Only for the closed secret-field audit before retaining exact raw bytes. */
export function auditAssetHistoryJson(text: string): unknown {
  return read(text, true);
}
