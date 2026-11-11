export const REDACTED_BASE_VARIABLE = "__KOGANE_REDACTED_BASE_VARIABLE__";

export function sanitizeHistoryHtmlText(html: string): {
  sanitized: string;
  originalValue: string;
} {
  const matches = [...html.matchAll(/<input\b[^>]*>/giu)].filter((match) =>
    attributeMatches(match[0], "name").some(
      (attribute) => attributeValue(attribute).toLowerCase() === "basevariable",
    ),
  );
  if (matches.length !== 1) throw new Error("history_base_variable_count_invalid");
  const match = matches[0];
  if (!match || match.index === undefined) throw new Error("history_base_variable_count_invalid");
  const tag = match[0];
  const nameMatches = attributeMatches(tag, "name");
  const name = attributeValue(nameMatches[0]);
  if (nameMatches.length !== 1 || name.toLowerCase() !== "basevariable") {
    throw new Error("history_base_variable_name_invalid");
  }
  const typeMatches = attributeMatches(tag, "type");
  if (typeMatches.length !== 1 || attributeValue(typeMatches[0]).toLowerCase() !== "hidden") {
    throw new Error("history_base_variable_type_invalid");
  }
  const valueMatches = attributeMatches(tag, "value");
  if (valueMatches.length !== 1) throw new Error("history_base_variable_value_count_invalid");
  const valueMatch = valueMatches[0];
  if (!valueMatch || valueMatch.index === undefined) {
    throw new Error("history_base_variable_value_count_invalid");
  }
  const originalValue = attributeValue(valueMatch);
  if (!originalValue) throw new Error("history_base_variable_empty");
  const replacement =
    valueMatch[1] !== undefined
      ? `value="${REDACTED_BASE_VARIABLE}"`
      : valueMatch[2] !== undefined
        ? `value='${REDACTED_BASE_VARIABLE}'`
        : `value=${REDACTED_BASE_VARIABLE}`;
  const sanitizedTag = `${tag.slice(0, valueMatch.index)}${replacement}${tag.slice(
    valueMatch.index + valueMatch[0].length,
  )}`;
  let sanitized = `${html.slice(0, match.index)}${sanitizedTag}${html.slice(match.index + tag.length)}`;
  // The observed known-empty form also carries navigation/session state.
  // Refuse unknown hidden fields rather than silently archiving new secrets.
  for (const input of [...sanitized.matchAll(/<input\b[^>]*>/giu)]) {
    if (
      !attributeMatches(input[0], "type").some(
        (value) => attributeValue(value).toLowerCase() === "hidden",
      )
    )
      continue;
    const names = attributeMatches(input[0], "name");
    const name = attributeValue(names[0]);
    if (name.toLowerCase() === "basevariable") continue;
    if (names.length !== 1 || !["returnUrlList", "checkScreenTransfer"].includes(name))
      throw new Error("history_hidden_field_unknown");
    const values = attributeMatches(input[0], "value");
    if (values.length !== 1) throw new Error("history_hidden_field_invalid");
    const value = attributeValue(values[0]);
    const redacted = input[0].replace(values[0]![0], `value="__KOGANE_REDACTED_NAVIGATION__"`);
    sanitized = sanitized.replace(input[0], redacted);
    if (value && sanitized.includes(value)) throw new Error("history_hidden_redaction_incomplete");
  }
  if (sanitized.includes(originalValue))
    throw new Error("history_base_variable_redaction_incomplete");
  return { sanitized, originalValue };
}

function attributeMatches(tag: string, name: string): RegExpMatchArray[] {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return [
    ...tag.matchAll(
      new RegExp(`\\b${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>\u0060]+))`, "giu"),
    ),
  ];
}

function attributeValue(match: RegExpMatchArray | undefined): string {
  return match?.[1] ?? match?.[2] ?? match?.[3] ?? "";
}
