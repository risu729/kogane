// The API paths the web UI names, read from its sources (ADR 0081, point 4).
//
// The scan is textual, like `tests/log-hygiene.test.ts`: comments are
// dropped, and every string or template literal of `apps/web/src` that is an
// API path is kept. A template is resolved as far as the sources allow: a
// `${NAME}` whose NAME is a string constant of `apps/web/src` or
// `packages/observation-shared/src` (`REPORTS_PATH`, `BASE`), or a call of a
// one-line path helper of the same file (`reportPath(id)`), is replaced by its
// value; a file-local builder with a parameter as a path segment is resolved
// at its calls (`path("accounts", …)`, see `segmentBuilders`). What is left is
// normalized into a route pattern:
//
//   * the query string is dropped (`?offset=…`);
//   * a `${…}` that is a whole path segment becomes `*` (`/api/artifacts/*`);
//   * a `${…}` that is not, which is how the UI appends a query
//     (`/api/transactions${request.suffix}`), is dropped.
//
// A `*` is served only by a `:name` segment of a route, never by a literal
// one, so a parameter cannot stand in for routes the scan did not see.
//
// A path that starts with an expression the scan cannot resolve is not seen,
// nor is a suffix passed to a request helper (`request("/proposals/…")` on the
// schedules page; those are POSTs, which guard 1 covers through the
// catalogue). Today every read route of the UI is named by at least one
// literal the scan resolves; the parity test fails on a pattern no route
// covers, and on a route no pattern names, so the map and the UI cannot drift
// apart silently.

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

/** `text` as a literal inside a regular expression: every metacharacter escaped. */
function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/gu, "\\$&");
}

/** Whether `source` uses `name` other than in its own declaration. */
function uses(source: string, name: string): boolean {
  const escaped = escapeRegExp(name);
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

/** The end of the `{…}` block that opens at `open`, or -1. */
function blockEnd(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

/** The arguments of the call whose `(` is at `open`, split at top-level commas. */
function callArguments(source: string, open: number): string[] | null {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < source.length; i++) {
    const c = source[i]!;
    if (c === '"' || c === "'" || c === "`") {
      const close = source.indexOf(c, i + 1);
      if (close === -1) return null;
      i = close;
    } else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c) && --depth === 0) {
      args.push(source.slice(start, i).trim());
      return args;
    } else if (c === "," && depth === 1) {
      args.push(source.slice(start, i).trim());
      start = i + 1;
    }
  }
  return null;
}

/**
 * A file-local path builder whose returned template has a parameter as a
 * whole path segment (`function path(collection, …) { … return
 * `/api/identity/${collection}?…`; }`), resolved at each call of the same
 * file: a string-literal argument replaces its parameter
 * (`path("accounts", …)` names `/api/identity/accounts`). Its returned
 * templates are then not scanned on their own, so a call with a new literal
 * is a new route and not hidden behind `/api/identity/*`. An exported builder
 * may be called elsewhere, so its templates are scanned as they are.
 */
function segmentBuilders(source: string): { paths: string[]; resolved: Set<number> } {
  const paths: string[] = [];
  const resolved = new Set<number>();
  for (const match of source.matchAll(
    /(\bexport\s+)?\bfunction\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?::\s*string\s*)?\{/gu,
  )) {
    if (match[1] !== undefined) continue;
    const name = match[2]!;
    const params = match[3]!
      .split(",")
      .map((param) => /^\s*([A-Za-z_$][\w$]*)/u.exec(param)?.[1])
      .filter((param): param is string => param !== undefined);
    const open = match.index + match[0].length - 1;
    const end = blockEnd(source, open);
    if (end === -1) continue;
    const found = [...source.slice(open, end).matchAll(/\breturn\s+(`(?:[^`\\]|\\.)*`)/gu)];
    const returns = found.map((each) => each[1]!.slice(1, -1));
    const segment = (param: string) =>
      new RegExp(`/\\$\\{\\s*${escapeRegExp(param)}\\s*\\}(?=/|\\?|$)`, "u");
    if (!returns.some((template) => params.some((param) => segment(param).test(template))))
      continue;
    const calls = [
      ...source.matchAll(new RegExp(`(?<![\\w$.])${escapeRegExp(name)}\\s*\\(`, "gu")),
    ].filter((call) => call.index !== match.index + match[0].indexOf(name));
    if (calls.length === 0) continue;
    for (const each of found) resolved.add(open + each.index + each[0].length - each[1]!.length);
    for (const call of calls) {
      const args = callArguments(source, call.index + call[0].length - 1) ?? [];
      for (const template of returns)
        paths.push(
          params.reduce((text, param, index) => {
            const literal = /^"([^"]*)"$|^'([^']*)'$/u.exec(args[index] ?? "");
            if (literal === null) return text;
            return text.replace(
              new RegExp(`\\$\\{\\s*${escapeRegExp(param)}\\s*\\}`, "gu"),
              () => literal[1] ?? literal[2]!,
            );
          }, template),
        );
    }
  }
  return { paths, resolved };
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
    const builders = segmentBuilders(text);
    for (const path of builders.paths) add(resolve(path, constants, helpers), file);
    for (const match of text.matchAll(/"([^"\n]*)"|'([^'\n]*)'|`((?:[^`\\]|\\.)*)`/gu)) {
      if (builders.resolved.has(match.index)) continue;
      add(resolve(match[1] ?? match[2] ?? match[3]!, constants, helpers), file);
    }
    // A constant passed as it is (`getJson(COLLECTION_QUALITY_PATH, …)`).
    for (const [name, value] of constants) if (uses(text, name)) add(value, file);
  }
  return found;
}

/**
 * Whether `route` (a concrete path whose `:name` segments are parameters)
 * serves `pattern` (a scanned path whose `*` segments are expressions). A `*`
 * needs a parameter: `/api/identity/*` is not served by
 * `/api/identity/accounts`, or one expression would vouch for every literal
 * route under it.
 */
export function routeServes(route: string, pattern: string): boolean {
  const a = route.split("/");
  const b = pattern.split("/");
  return (
    a.length === b.length &&
    a.every(
      (segment, index) => segment.startsWith(":") || (segment === b[index] && b[index] !== "*"),
    )
  );
}
