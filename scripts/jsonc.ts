// Minimal JSONC reader for the repository's own configuration files.
//
// Wrangler configs (`wrangler*.jsonc`) and Bun lockfiles (`bun.lock`) are JSON
// with comments and trailing commas. Nothing in this repository may add a
// dependency just to read them, and `JSON.parse` rejects both extensions, so
// the ledger generators share this scanner: it removes comments and trailing
// commas outside string literals and hands the rest to `JSON.parse`, which
// keeps the actual grammar (numbers, escapes, duplicate keys) in one place.

/** Strip `//` and block comments and trailing commas, preserving strings. */
export function stripJsonc(text: string): string {
  let out = "";
  let index = 0;
  // Offset in `out` of a comma that has seen only whitespace and comments since;
  // it is trailing if the next real character closes its array or object. The
  // check must run inside this scan, because `"a,}"` is data, not a comma.
  let pendingComma: number | undefined;
  while (index < text.length) {
    const character = text[index] as string;
    if (character === '"') {
      const start = index;
      index += 1;
      while (index < text.length) {
        const inner = text[index] as string;
        if (inner === "\\") {
          index += 2;
          continue;
        }
        index += 1;
        if (inner === '"') break;
      }
      out += text.slice(start, index);
      pendingComma = undefined;
      continue;
    }
    if (character === "/" && text[index + 1] === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && text[index + 1] === "*") {
      const end = text.indexOf("*/", index + 2);
      index = end === -1 ? text.length : end + 2;
      continue;
    }
    if ((character === "]" || character === "}") && pendingComma !== undefined) {
      out = out.slice(0, pendingComma) + out.slice(pendingComma + 1);
      pendingComma = undefined;
    } else if (character === ",") pendingComma = out.length;
    else if (!/\s/u.test(character)) pendingComma = undefined;
    out += character;
    index += 1;
  }
  return out;
}

/** Parse JSON with comments and trailing commas. */
export function parseJsonc(text: string, label: string): unknown {
  try {
    return JSON.parse(stripJsonc(text));
  } catch (error) {
    throw new Error(`Cannot parse ${label} as JSONC`, { cause: error });
  }
}
