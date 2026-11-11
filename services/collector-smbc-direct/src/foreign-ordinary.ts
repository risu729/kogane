import { parse, type DefaultTreeAdapterMap } from "parse5";
import { parse as parseJavaScript } from "acorn";
import type { DateRange, ForeignOrdinaryProgress } from "./types";

export const FOREIGN_EMPTY_CODE = "PC-AIFDDT1-00134-E";
export const FOREIGN_BALANCE_UNIT = "foreign-ordinary-aud-balance";
export const FOREIGN_HISTORY_UNIT = "foreign-ordinary-aud-history";

type HtmlNode = DefaultTreeAdapterMap["node"];
type HtmlElement = DefaultTreeAdapterMap["element"];
type SyntaxNode = { type: string; [key: string]: unknown };

export function foreignFailureCodes(foreign?: ForeignOrdinaryProgress): string[] {
  return [
    ...new Set(
      [foreign?.balance, foreign?.history].flatMap((unit) =>
        unit?.status === "partial" ? [unit.failureCode ?? "foreign_collection_failed"] : [],
      ),
    ),
  ];
}

export interface ForeignOrdinaryBalance {
  currency: "AUD";
  amount: string;
  yenEquivalent: string;
  referenceRate: string;
}
export interface ForeignOrdinaryHistory {
  currency: "AUD";
  range: DateRange;
  emptyCode: typeof FOREIGN_EMPTY_CODE;
  transactions: [];
}

/** Structured extraction emits only reviewed fields, never HTML or forms. */
export function sanitizeForeignBalance(html: string): ForeignOrdinaryBalance {
  const currency = audContainer(documentOf(html));
  const balance = labelled(currency, "dl", "現在残高");
  const symbol = single(
    elements(balance, "span").filter((span) => classes(span).includes("foreignCurrency")),
  );
  if (visibleText(symbol) !== "A$") refuse("foreign_currency_unreviewed");
  const amount = price(balance);
  const yenEquivalent = price(labelled(currency, "dl", "円貨換算金額"));
  const rate = labelled(currency, "dl", "現在の参考為替レート(外貨→円)");
  const referenceRate = decimal(plainText(single(elements(rate, "dd"))).replace(/円$/u, ""));
  return { currency: "AUD", amount, yenEquivalent, referenceRate };
}

function audContainer(document: HtmlNode): HtmlElement {
  return single(
    elements(document, "dl").filter(
      (element) =>
        classes(element).includes("detail-list03") &&
        elements(element, "dt").some((term) => visibleText(term) === "通貨：A$"),
    ),
    "foreign_currency_unreviewed",
  );
}

export function foreignHistoryIndex(html: string): "0" {
  const link = single(
    elements(audContainer(documentOf(html)), "a").filter(
      (element) => attribute(element, "data-event") === "/accountinquiry/AIFDDTLmeisai",
    ),
  );
  if (attribute(link, "id") !== "0") refuse("foreign_account_selection_unreviewed");
  return "0";
}

/** The unique visible main, account heading and AUD amount bind the page. */
export function assertForeignHistoryContext(html: string, accountNo: string, amount: string): void {
  const main = single(elements(documentOf(html), "main"));
  const headers = elements(main, "dl").filter((element) => classes(element).includes("item"));
  if (headers.length !== 1) refuse("foreign_history_account_mismatch");
  const titles = elements(headers[0]!, "dt").filter((term) => classes(term).includes("title"));
  const firstTitle = elements(main, "dt").find((term) => classes(term).includes("title"));
  if (
    titles.length !== 1 ||
    titles[0] !== firstTitle ||
    /外貨([0-9]+)$/u.exec(visibleText(titles[0]!))?.[1] !== accountNo
  )
    refuse("foreign_history_account_mismatch");
  const heading = single(
    elements(main, "dl").filter((element) => {
      const names = classes(element);
      return (
        names.includes("detail-list07") &&
        names.includes("-flexEnd") &&
        names.includes("-account") &&
        elements(element, "dt").some((term) => visibleText(term) === "通貨・現在残高")
      );
    }),
  );
  const current = single(elements(heading, "dd"));
  const priceText = plainText(
    single(elements(current, "span").filter((element) => classes(element).includes("price"))),
  );
  if (visibleText(current) !== `A$${priceText}` || decimal(priceText) !== amount)
    refuse("foreign_history_currency_mismatch");
}

export function sanitizeForeignHistory(html: string, range: DateRange): ForeignOrdinaryHistory {
  const document = documentOf(html);
  assertEmptyDataScript(document);
  if (elements(document, "table").length !== 0 || elements(document, "tbody").length !== 0)
    refuse("foreign_nonempty_unreviewed");
  const alert = single(
    elements(document, "div").filter((element) => {
      const names = classes(element);
      return names.includes("card-box03") && names.includes("-alert01");
    }),
  );
  if (
    visibleText(single(elements(alert, "dt"))) !== `エラーコード:${FOREIGN_EMPTY_CODE}` ||
    visibleText(single(elements(alert, "dd"))) !== "指定期間の入出金はございません。"
  )
    refuse("foreign_history_response_unreviewed");
  const period = `${displayDate(range.start)}-${displayDate(range.end)}の明細`;
  if (elements(document, "p").filter((element) => visibleText(element) === period).length !== 1)
    refuse("foreign_history_range_mismatch");
  return { currency: "AUD", range, emptyCode: FOREIGN_EMPTY_CODE, transactions: [] };
}

function displayDate(value: string): string {
  return `${Number(value.slice(0, 4))}年${Number(value.slice(5, 7))}月${Number(value.slice(8, 10))}日`;
}

function documentOf(html: string): HtmlNode {
  let invalid = false;
  const document = parse(html, {
    onParseError: (error) => {
      if (error.code !== "missing-doctype") invalid = true;
    },
  });
  if (invalid) refuse("foreign_html_shape_unreviewed");
  return document;
}

function isElement(node: HtmlNode): node is HtmlElement {
  return "tagName" in node;
}
function children(node: HtmlNode): HtmlNode[] {
  return "childNodes" in node ? node.childNodes : [];
}
function attribute(node: HtmlElement, name: string): string | undefined {
  return node.attrs.find((entry) => entry.name === name)?.value;
}
function hidden(node: HtmlElement): boolean {
  return (
    attribute(node, "hidden") !== undefined ||
    attribute(node, "aria-hidden")?.toLowerCase() === "true" ||
    /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!important\s*)?(?:;|$)/iu.test(
      attribute(node, "style") ?? "",
    )
  );
}
function inert(node: HtmlElement): boolean {
  return (
    node.namespaceURI !== "http://www.w3.org/1999/xhtml" ||
    hidden(node) ||
    ["template", "style", "noscript"].includes(node.tagName) ||
    node.tagName === "script"
  );
}
function elements(root: HtmlNode, tag: string): HtmlElement[] {
  const found: HtmlElement[] = [];
  for (const child of children(root)) {
    if (!isElement(child) || inert(child)) continue;
    if (child.tagName === tag) found.push(child);
    found.push(...elements(child, tag));
  }
  return found;
}
function text(node: HtmlNode): string {
  if (node.nodeName === "#text" && "value" in node) return node.value;
  if (isElement(node) && inert(node)) return "";
  return children(node).map(text).join("");
}
function plainText(node: HtmlNode): string {
  return text(node).trim();
}
function visibleText(node: HtmlNode): string {
  return plainText(node).replace(/\s+/gu, "");
}
function classes(node: HtmlElement): string[] {
  return (attribute(node, "class") ?? "").split(/\s+/u);
}
function price(node: HtmlElement): string {
  return decimal(
    plainText(single(elements(node, "span").filter((span) => classes(span).includes("price")))),
  );
}
function decimal(value: string): string {
  if (!/^(?:0|[1-9][0-9]{0,14}|[1-9][0-9]{0,2}(?:,[0-9]{3})+)(?:\.[0-9]{1,8})?$/u.test(value))
    refuse("foreign_decimal_invalid");
  return value.replaceAll(",", "");
}
function labelled(root: HtmlElement, tag: string, label: string): HtmlElement {
  const candidates = elements(root, tag).filter((element) =>
    elements(element, "dt").some((term) => visibleText(term) === label),
  );
  const leaves = candidates.filter(
    (candidate) =>
      !candidates.some((nested) => nested !== candidate && ancestor(candidate, nested)),
  );
  return single(leaves);
}
function ancestor(parent: HtmlElement, node: HtmlElement): boolean {
  for (
    let current = node.parentNode;
    current !== null;
    current = "parentNode" in current ? current.parentNode : null
  )
    if (current === parent) return true;
  return false;
}
function single<T>(values: T[], code = "foreign_html_shape_unreviewed"): T {
  if (values.length !== 1) refuse(code);
  return values[0]!;
}

function syntax(value: unknown): value is SyntaxNode {
  return (
    value !== null && typeof value === "object" && "type" in value && typeof value.type === "string"
  );
}
function identifier(value: unknown, name: string): boolean {
  return syntax(value) && value.type === "Identifier" && value.name === name;
}
function call(value: unknown, arity: number): SyntaxNode | undefined {
  return syntax(value) &&
    value.type === "CallExpression" &&
    !value.optional &&
    Array.isArray(value.arguments) &&
    value.arguments.length === arity
    ? value
    : undefined;
}
function member(value: unknown, property: string): SyntaxNode | undefined {
  return syntax(value) &&
    value.type === "MemberExpression" &&
    !value.computed &&
    !value.optional &&
    identifier(value.property, property)
    ? value
    : undefined;
}
function emptyReturn(value: unknown): boolean {
  const parseCall = call(value, 1);
  const parseMember = member(parseCall?.callee, "parse");
  if (!parseMember || !identifier(parseMember.object, "JSON")) return false;
  const replaceCall = call((parseCall!.arguments as unknown[])[0], 2);
  const replaceMember = member(replaceCall?.callee, "replace");
  if (
    !replaceMember ||
    !syntax(replaceMember.object) ||
    replaceMember.object.type !== "Literal" ||
    replaceMember.object.value !== ""
  )
    return false;
  const [pattern, replacement] = replaceCall!.arguments as unknown[];
  return (
    syntax(pattern) &&
    pattern.type === "Literal" &&
    pattern.regex !== null &&
    typeof pattern.regex === "object" &&
    "pattern" in pattern.regex &&
    pattern.regex.pattern === "&quot;" &&
    "flags" in pattern.regex &&
    pattern.regex.flags === "g" &&
    syntax(replacement) &&
    replacement.type === "Literal" &&
    replacement.value === '"'
  );
}
function walkSyntax(value: unknown, visit: (node: SyntaxNode) => void): void {
  if (Array.isArray(value)) {
    for (const child of value) walkSyntax(child, visit);
    return;
  }
  if (!syntax(value)) return;
  visit(value);
  for (const [key, child] of Object.entries(value))
    if (key !== "start" && key !== "end") walkSyntax(child, visit);
}
function target(value: unknown): boolean {
  if (!syntax(value)) return false;
  if (value.type === "Identifier")
    return ["getData", "meisaiListJSONData", "JSON"].includes(String(value.name));
  if (value.type === "MemberExpression") {
    const property = value.property;
    return (
      (syntax(property) &&
        ["getData", "meisaiListJSONData", "JSON"].includes(
          String(property.name ?? property.value),
        )) ||
      target(value.object)
    );
  }
  if (
    ["ArrayPattern", "ObjectPattern", "RestElement", "AssignmentPattern", "Property"].includes(
      value.type,
    )
  )
    return Object.values(value).some((child) =>
      Array.isArray(child) ? child.some(target) : target(child),
    );
  return false;
}
function protectedCallTarget(value: unknown): boolean {
  if (!syntax(value)) return false;
  if (value.type === "Identifier")
    return value.name === "getData" || value.name === "meisaiListJSONData";
  if (value.type !== "MemberExpression") return false;
  const property = value.property;
  return (
    (syntax(property) &&
      ["getData", "meisaiListJSONData"].includes(String(property.name ?? property.value))) ||
    protectedCallTarget(value.object)
  );
}
function globalMutation(node: SyntaxNode): boolean {
  if (node.type === "UnaryExpression" && node.operator === "delete" && target(node.argument))
    return true;
  if (node.type !== "CallExpression" && node.type !== "NewExpression") return false;
  if (
    identifier(node.callee, "eval") ||
    identifier(node.callee, "Function") ||
    (node.type === "NewExpression" && identifier(node.callee, "getData"))
  )
    return true;
  if (
    !syntax(node.callee) ||
    node.callee.type !== "MemberExpression" ||
    !Array.isArray(node.arguments)
  )
    return false;
  if (protectedCallTarget(node.callee.object)) return true;
  const property = node.callee.property;
  const name = syntax(property) ? (property.name ?? property.value) : undefined;
  const first = node.arguments[0];
  return (
    [
      "assign",
      "defineProperty",
      "defineProperties",
      "set",
      "setPrototypeOf",
      "apply",
      "construct",
    ].includes(String(name)) &&
    (target(first) ||
      ["window", "globalThis", "self"].some((global) => identifier(first, global)) ||
      (syntax(first) && first.type === "ThisExpression"))
  );
}

// Executability is independent of CSS visibility. HTML templates are inert;
// their separate content fragment is deliberately never traversed here.
function scriptElements(root: HtmlNode): HtmlElement[] {
  const found: HtmlElement[] = [];
  for (const child of children(root)) {
    if (!isElement(child)) continue;
    if (
      child.namespaceURI === "http://www.w3.org/1999/xhtml" &&
      ["template", "noscript"].includes(child.tagName)
    )
      continue;
    if (child.tagName === "script") found.push(child);
    found.push(...scriptElements(child));
  }
  return found;
}
// https://mimesniff.spec.whatwg.org/#javascript-mime-type-essence-match
const CLASSIC_SCRIPT_TYPES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
]);
function classicScriptSource(script: HtmlElement): string | undefined {
  const type = attribute(script, "type")?.trim().toLowerCase() ?? "";
  if (script.namespaceURI !== "http://www.w3.org/1999/xhtml" || type === "module")
    refuse("foreign_history_response_unreviewed");
  if (
    attribute(script, "src") !== undefined ||
    attribute(script, "nomodule") !== undefined ||
    (type !== "" && !CLASSIC_SCRIPT_TYPES.has(type))
  )
    return undefined;
  return children(script)
    .map((child) => (child.nodeName === "#text" && "value" in child ? child.value : ""))
    .join("");
}

function assertEmptyDataScript(document: HtmlNode): void {
  try {
    const programs = scriptElements(document)
      .map(classicScriptSource)
      .filter((source): source is string => source !== undefined)
      .map((source) => parseJavaScript(source, { ecmaVersion: "latest", sourceType: "script" }));
    const top = programs.flatMap((program) => program.body as unknown as SyntaxNode[]);
    const definitions = top.filter(
      (node) => node.type === "FunctionDeclaration" && identifier(node.id, "getData"),
    );
    const definition = single(definitions, "foreign_history_response_unreviewed");
    if (
      definition.async ||
      definition.generator ||
      !Array.isArray(definition.params) ||
      definition.params.length !== 0 ||
      !syntax(definition.body) ||
      !Array.isArray(definition.body.body) ||
      definition.body.body.length !== 1
    )
      refuse("foreign_history_response_unreviewed");
    const statement = definition.body.body[0];
    if (
      !syntax(statement) ||
      statement.type !== "ReturnStatement" ||
      !emptyReturn(statement.argument)
    )
      refuse("foreign_history_response_unreviewed");
    const declarations = top
      .filter((node) => node.type === "VariableDeclaration")
      .flatMap((node) =>
        Array.isArray(node.declarations)
          ? node.declarations
              .filter(syntax)
              .map((declaration) => ({ declaration, kind: node.kind }))
          : [],
      );
    const binding = single(
      declarations.filter(({ declaration }) => identifier(declaration.id, "meisaiListJSONData")),
      "foreign_history_response_unreviewed",
    );
    const initializer = call(binding.declaration.init, 0);
    if (binding.kind !== "var" || !initializer || !identifier(initializer.callee, "getData"))
      refuse("foreign_history_response_unreviewed");
    // Declarations hoist within a script, never into an earlier script element.
    const definitionScript = programs.findIndex((program) =>
      (program.body as unknown[]).includes(definition),
    );
    const bindingScript = programs.findIndex((program) =>
      program.body.some(
        (statement) =>
          syntax(statement) &&
          Array.isArray(statement.declarations) &&
          statement.declarations.includes(binding.declaration),
      ),
    );
    if (definitionScript < 0 || bindingScript < definitionScript)
      refuse("foreign_history_response_unreviewed");
    let functionBindings = 0;
    let dataBindings = 0;
    let calls = 0;
    let mutation = false;
    for (const program of programs)
      walkSyntax(program, (node) => {
        if (["FunctionDeclaration", "FunctionExpression"].includes(node.type)) {
          if (identifier(node.id, "getData")) functionBindings += 1;
          else if (target(node.id)) mutation = true;
        }
        if (["ClassDeclaration", "ClassExpression"].includes(node.type) && target(node.id))
          mutation = true;
        if (globalMutation(node)) mutation = true;
        if (node.type === "VariableDeclarator") {
          if (identifier(node.id, "meisaiListJSONData")) dataBindings += 1;
          else if (target(node.id)) mutation = true;
        }
        if (node.type === "CallExpression" && identifier(node.callee, "getData")) calls += 1;
        if (
          (node.type === "AssignmentExpression" && target(node.left)) ||
          (node.type === "UpdateExpression" && target(node.argument)) ||
          ((node.type === "ForInStatement" || node.type === "ForOfStatement") &&
            target(node.left)) ||
          (node.type === "CatchClause" && target(node.param)) ||
          (Array.isArray(node.params) && node.params.some(target))
        )
          mutation = true;
      });
    if (functionBindings !== 1 || dataBindings !== 1 || calls !== 1 || mutation)
      refuse("foreign_history_response_unreviewed");
  } catch {
    refuse("foreign_history_response_unreviewed");
  }
}
function refuse(code: string): never {
  throw new Error(code);
}
