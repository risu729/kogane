// Inspect original JSON number tokens before Number conversion. The closed
// history schema permits fractional numbers only for profitLossRate metadata;
// all financial amounts and native timestamp/value pairs are safe integers.
import {
  decimalFromString,
  normalizeDecimal,
  DECIMAL_DIGIT_LIMIT,
} from "../../../domain/src/values";
import { assetHistoryError, isAssetHistoryError } from "./sbi-asset-history-schema";

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

// Size matches the Processor's existing raw-input ceiling. The node and
// numeric budgets cover the closed schema's 4096 points without unbounded
// token arrays; the depth guard runs before any whole-document JSON.parse.
export const ASSET_HISTORY_JSON_LIMITS = {
  bytes: 16 * 1024 * 1024,
  depth: 64,
  numbers: 262144,
  nodes: 1048576,
} as const;
interface NumberToken {
  start: number;
  end: number;
  rate: boolean;
}

/** Validate ORIGINAL grammar and decoded-key uniqueness without building an AST. */
function numberTokens(text: string): NumberToken[] {
  if (
    text.length > ASSET_HISTORY_JSON_LIMITS.bytes ||
    new TextEncoder().encode(text).byteLength > ASSET_HISTORY_JSON_LIMITS.bytes
  )
    throw assetHistoryError("sbi_asset_history_bound");
  let index = 0;
  let nodes = 0;
  const numbers: NumberToken[] = [];
  const syntax = (): never => {
    throw assetHistoryError("sbi_asset_history_schema");
  };
  const count = () => {
    if (++nodes > ASSET_HISTORY_JSON_LIMITS.nodes)
      throw assetHistoryError("sbi_asset_history_bound");
  };
  const whitespace = () => {
    while (/[ \t\r\n]/u.test(text[index] ?? "!")) index++;
  };
  const digit = () => {
    const c = text[index];
    return c !== undefined && c >= "0" && c <= "9";
  };
  const string = (): string => {
    const start = index;
    if (text[index++] !== '"') return syntax();
    while (index < text.length) {
      const c = text[index++];
      if (c === "\\") index++;
      else if (c === '"') return JSON.parse(text.slice(start, index)) as string;
    }
    return syntax();
  };
  const value = (depth: number, property?: string): void => {
    count();
    whitespace();
    const c = text[index];
    if (c === "{" || c === "[") {
      if (depth >= ASSET_HISTORY_JSON_LIMITS.depth)
        throw assetHistoryError("sbi_asset_history_bound");
      index++;
      whitespace();
      const object = c === "{";
      const close = object ? "}" : "]";
      const keys = new Set<string>();
      if (text[index] === close) {
        index++;
        return;
      }
      while (true) {
        let key: string | undefined;
        if (object) {
          count();
          whitespace();
          key = string();
          if (keys.has(key)) return syntax();
          keys.add(key);
          whitespace();
          if (text[index++] !== ":") return syntax();
        }
        value(depth + 1, key);
        whitespace();
        if (text[index] === close) {
          index++;
          return;
        }
        if (text[index++] !== ",") return syntax();
      }
    }
    if (c === '"') {
      string();
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return;
      }
    }
    const start = index;
    if (text[index] === "-") index++;
    if (text[index] === "0") index++;
    else {
      if (!digit() || text[index] === "0") return syntax();
      while (digit()) index++;
    }
    if (text[index] === ".") {
      index++;
      if (!digit()) return syntax();
      while (digit()) index++;
    }
    if (text[index] === "e" || text[index] === "E") {
      index++;
      if (text[index] === "+" || text[index] === "-") index++;
      if (!digit()) return syntax();
      while (digit()) index++;
    }
    // A numeric token must end at a JSON value delimiter, never at another
    // numeric fragment that normalization could accidentally repair.
    if (index === start || (index < text.length && !/[ \t\r\n,}\]]/u.test(text[index]!)))
      return syntax();
    if (numbers.length >= ASSET_HISTORY_JSON_LIMITS.numbers)
      throw assetHistoryError("sbi_asset_history_bound");
    numbers.push({ start, end: index, rate: property === "profitLossRate" });
  };
  value(0);
  whitespace();
  if (index !== text.length) return syntax();
  return numbers;
}

function read(text: string, auditOnly: boolean): unknown {
  try {
    // Complete grammar/key validation finishes before ANY numeric replacement.
    const tokens = numberTokens(text);
    let end = 0;
    const parts: string[] = [];
    for (const { start, end: next, rate } of tokens) {
      const token = text.slice(start, next);
      parts.push(text.slice(end, start));
      const integer = rate ? undefined : exactSafeInteger(token);
      const valid = rate ? Number.isFinite(Number(token)) : integer !== undefined;
      let replacement = integer ?? token;
      if (!valid) {
        if (!auditOnly)
          throw assetHistoryError(rate ? "sbi_asset_history_schema" : "sbi_asset_history_money");
        // Shape only. Derivation re-reads ORIGINAL bytes in strict mode.
        replacement = "1000000000000";
      }
      parts.push(replacement);
      end = next;
    }
    parts.push(text.slice(end));
    return JSON.parse(parts.join("")) as unknown;
  } catch (cause) {
    if (isAssetHistoryError(cause)) throw cause;
    throw assetHistoryError("sbi_asset_history_schema");
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
