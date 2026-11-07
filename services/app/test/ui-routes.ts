// The API paths the web UI names, read from its sources (ADR 0081, point 4).
//
// The scan is textual, like `tests/log-hygiene.test.ts`: comments are
// dropped, and every string or template literal of `apps/web/src` that is an
// API path is kept. A template is resolved as far as the sources allow: a
// `${NAME}` whose NAME is a string constant of `apps/web/src` or
// `packages/observation-shared/src` (`REPORTS_PATH`, `BASE`), or a call of a
// one-line path helper of the same file (`reportPath(id)`), is replaced by its
// value. What is left is normalized into a route pattern:
//
//   * the query string is dropped (`?offset=…`);
//   * a `${…}` that is a whole path segment becomes `*` (`/api/artifacts/*`);
//   * a `${…}` that is not, which is how the UI appends a query
//     (`/api/transactions${request.suffix}`), is dropped.
//
// A path that starts with an expression the scan cannot resolve is not seen.
// Today every route of the UI is named by at least one literal the scan
// resolves; the parity test fails on a pattern no route covers, and on a
// route no pattern names, so the map and the UI cannot drift apart silently.

/** The sources the Vite transform hands the test, keyed by path. */
type Sources = Record<string, string>;

const WEB_SOURCES = import.meta.glob("../../../apps/web/src/**/*.{ts,tsx}", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Sources;
const SHARED_SOURCES = import.meta.glob("../../../packages/observation-shared/src/**/*.ts", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Sources;

/** A source with its comments replaced by spaces; string and template text kept. */
export function withoutComments(source: string): string {
  let out = "";
  let i = 0;
  // A stack of open template literals and of `${` expressions inside them.
  const stack: ("`" | "${")[] = [];
  let braces: number[] = [];
  while (i < source.length) {
    const c = source[i]!;
    const next = source[i + 1];
    const inTemplate = stack.at(-1) === "`";
    if (inTemplate) {
      if (c === "\\") {
        out += c + (next ?? "");
        i += 2;
        continue;
      }
      if (c === "`") {
        stack.pop();
        out += c;
        i++;
        continue;
      }
      if (c === "$" && next === "{") {
        stack.push("${");
        braces.push(0);
        out += "${";
        i += 2;
        continue;
      }
      out += c;
      i++;
      continue;
    }
    if (c === "/" && next === "/") {
      while (i < source.length && source[i] !== "\n") {
        out += " ";
        i++;
      }
      continue;
    }
    if (c === "/" && next === "*") {
      const end = source.indexOf("*/", i + 2);
      const stop = end === -1 ? source.length : end + 2;
      out += source.slice(i, stop).replace(/[^\n]/gu, " ");
      i = stop;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== c && source[j] !== "\n")
        j += source[j] === "\\" ? 2 : 1;
      out += source.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (c === "`") {
      stack.push("`");
      out += c;
      i++;
      continue;
    }
    if (stack.at(-1) === "${") {
      if (c === "{") braces[braces.length - 1]!++;
      if (c === "}") {
        if (braces.at(-1) === 0) {
          stack.pop();
          braces = braces.slice(0, -1);
          out += c;
          i++;
          continue;
        }
        braces[braces.length - 1]!--;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** `const NAME = "/api/…"` in one source; `exported` keeps only exported ones. */
function pathConstants(source: string, exported: boolean): Map<string, string> {
  const constants = new Map<string, string>();
  const pattern = exported
    ? /\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*"(\/api[^"]*)"/gu
    : /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*"(\/api[^"]*)"/gu;
  for (const match of source.matchAll(pattern)) constants.set(match[1]!, match[2]!);
  return constants;
}

/** Whether `source` uses `name` other than in its own declaration. */
function uses(source: string, name: string): boolean {
  const escaped = name.replace(/[$]/gu, "\\$");
  const all = source.match(new RegExp(`(?<![\\w$.])${escaped}(?![\\w$])`, "gu"))?.length ?? 0;
  const declared = source.match(new RegExp(`\\bconst\\s+${escaped}(?![\\w$])`, "gu"))?.length ?? 0;
  return all > declared;
}

/** `function name(…): string { return `…`; }`: a one-line path helper. */
function pathHelpers(source: string): Map<string, string> {
  const helpers = new Map<string, string>();
  for (const match of source.matchAll(
    /\bfunction\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*string\s*)?\{\s*return\s+(`[^`]*`|"[^"]*")\s*;\s*\}/gu,
  ))
    helpers.set(match[1]!, match[2]!.slice(1, -1));
  return helpers;
}

/** Replace each resolvable `${…}` by its value, until nothing more resolves. */
function resolve(
  text: string,
  constants: Map<string, string>,
  helpers: Map<string, string>,
): string {
  for (let round = 0; round < 4; round++) {
    const next = text.replace(
      /\$\{\s*([A-Za-z_$][\w$]*)\s*(\([^)]*\))?\s*\}/gu,
      (whole, name, call) => {
        if (call === undefined && constants.has(name)) return constants.get(name)!;
        if (call !== undefined && helpers.has(name)) return helpers.get(name)!;
        return whole;
      },
    );
    if (next === text) break;
    text = next;
  }
  return text;
}

/** The route pattern of one resolved literal; see the header. */
function routePattern(literal: string): string {
  let path = literal;
  const query = path.indexOf("?");
  if (query !== -1) path = path.slice(0, query);
  // Whole-segment expressions are parameters; anything else is a suffix.
  path = path.replace(/\/\$\{[^}]*\}(?=\/|$)/gu, "/*");
  path = path.replace(/\$\{[^}]*\}/gu, "");
  return path.replace(/\/+$/u, "");
}

/** Every API path the web UI names, as route patterns, with the files naming each. */
export function uiApiPatterns(): Map<string, string[]> {
  const web = Object.entries(WEB_SOURCES).map(
    ([file, text]) => [file.replace(/^(\.\.\/)+/u, ""), withoutComments(text)] as const,
  );
  // Exported constants of the UI and of the contracts it imports; a file's own
  // constants take precedence over them in that file.
  const shared = new Map<string, string>();
  for (const text of [
    ...Object.values(SHARED_SOURCES).map(withoutComments),
    ...web.map(([, t]) => t),
  ])
    for (const [name, value] of pathConstants(text, true)) shared.set(name, value);
  const found = new Map<string, string[]>();
  const add = (value: string, file: string) => {
    if (!value.startsWith("/api/") && value !== "/api") return;
    const pattern = routePattern(value);
    found.set(pattern, [...new Set([...(found.get(pattern) ?? []), file])]);
  };
  for (const [file, text] of web) {
    const constants = new Map([...shared, ...pathConstants(text, false)]);
    const helpers = pathHelpers(text);
    for (const match of text.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`((?:[^`\\]|\\.)*)`/gu))
      add(resolve(match[1] ?? match[2] ?? match[3]!, constants, helpers), file);
    // A constant passed as it is (`getJson(COLLECTION_QUALITY_PATH, …)`).
    for (const [name, value] of constants) if (uses(text, name)) add(value, file);
  }
  return found;
}

/**
 * Whether `route` (a concrete path whose `:name` segments are parameters)
 * serves `pattern` (a scanned path whose `*` segments are anything).
 */
export function routeServes(route: string, pattern: string): boolean {
  const a = route.split("/");
  const b = pattern.split("/");
  return (
    a.length === b.length &&
    a.every((segment, index) => segment === b[index] || segment.startsWith(":") || b[index] === "*")
  );
}
