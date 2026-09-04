import { decode, encode } from "iconv-lite";

export const REDACTED_BASE_VARIABLE = "__KOGANE_REDACTED_BASE_VARIABLE__";

export function sanitizeHistoryHtml(html: string): Uint8Array {
  const matches = [...html.matchAll(/<input\b[^>]*>/giu)].filter((match) =>
    attributeMatches(match[0], "name")
      .some((attribute) => attributeValue(attribute).toLowerCase() === "basevariable")
  );
  if (matches.length !== 1) throw new Error("history_base_variable_count_invalid");
  const match = matches[0];
  if (!match || match.index === undefined) throw new Error("history_base_variable_count_invalid");
  const tag = match[0];
  const nameMatches = attributeMatches(tag, "name");
  const name = attributeValue(nameMatches[0]);
  if (nameMatches.length !== 1 || name?.toLowerCase() !== "basevariable") {
    throw new Error("history_base_variable_name_invalid");
  }
  const typeMatches = [...tag.matchAll(/\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/giu)];
  const inputType = typeMatches[0]?.[1] ?? typeMatches[0]?.[2] ?? typeMatches[0]?.[3];
  if (typeMatches.length !== 1 || inputType?.toLowerCase() !== "hidden") {
    throw new Error("history_base_variable_type_invalid");
  }
  const valueMatches = [...tag.matchAll(/\bvalue\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/giu)];
  if (valueMatches.length !== 1) throw new Error("history_base_variable_value_count_invalid");
  const valueMatch = valueMatches[0];
  const value = valueMatch?.[1] ?? valueMatch?.[2] ?? valueMatch?.[3];
  if (!valueMatch || !value) throw new Error("history_base_variable_empty");
  const replacement = valueMatch[1] !== undefined
    ? `value="${REDACTED_BASE_VARIABLE}"`
    : valueMatch[2] !== undefined
      ? `value='${REDACTED_BASE_VARIABLE}'`
      : `value=${REDACTED_BASE_VARIABLE}`;
  const sanitizedTag = `${tag.slice(0, valueMatch.index)}${replacement}${
    tag.slice(valueMatch.index + valueMatch[0].length)
  }`;
  const sanitized = `${html.slice(0, match.index)}${sanitizedTag}${html.slice(match.index + tag.length)}`;
  if (sanitized.includes(value)) throw new Error("history_base_variable_redaction_incomplete");
  const bytes = encode(sanitized, "shift_jis");
  const roundTrip = decode(bytes, "shift_jis");
  if (roundTrip !== sanitized || !roundTrip.includes(REDACTED_BASE_VARIABLE) || roundTrip.includes(value)) {
    throw new Error("history_base_variable_redaction_round_trip_invalid");
  }
  return bytes;
}

function attributeMatches(tag: string, name: string): RegExpMatchArray[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return [...tag.matchAll(new RegExp(
    `\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\u0060]+))`,
    "giu",
  ))];
}

function attributeValue(match: RegExpMatchArray | undefined): string {
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
}
