import { createScanner, format, SyntaxKind } from "jsonc-parser";

/** Change whitespace only; never serialize parsed numbers or collapse duplicate keys. */
export function prettyJson(text: string): string | null {
  if (text.length > 512 * 1024) return null;
  const scanner = createScanner(text, true);
  let depth = 0;
  for (let token = scanner.scan(); token !== SyntaxKind.EOF; token = scanner.scan()) {
    if (token === SyntaxKind.OpenBraceToken || token === SyntaxKind.OpenBracketToken) {
      if (++depth > 64) return null;
    } else if (token === SyntaxKind.CloseBraceToken || token === SyntaxKind.CloseBracketToken) {
      depth--;
    }
  }
  try {
    // Validation only: formatting operates on the original token spelling.
    JSON.parse(text);
    const edits = format(text, undefined, { insertSpaces: true, tabSize: 2, eol: "\n" });
    const size = edits.reduce(
      (length, edit) => length + edit.content.length - edit.length,
      text.length,
    );
    if (size > 1024 * 1024) return null;
    // Assemble once; repeated string splices become quadratic for large arrays.
    const parts: string[] = [];
    let offset = 0;
    for (const edit of edits) {
      if (edit.offset < offset) return null;
      parts.push(text.slice(offset, edit.offset), edit.content);
      offset = edit.offset + edit.length;
    }
    parts.push(text.slice(offset));
    return parts.join("");
  } catch {
    return null;
  }
}
