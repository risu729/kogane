import { parse as parseHtml, type DefaultTreeAdapterMap } from "parse5";
import { parse as parseJavaScript } from "acorn";

export const MAILBOX_ORIGIN = "https://plus.e-shishobako.ne.jp";
export const MAILBOX_APPLICATION = `${MAILBOX_ORIGIN}/dp_apl/usr/`;
const MAX_HTML_CHARACTERS = 256 * 1024;
const MAX_SCRIPT_CHARACTERS = 32 * 1024;
const STORAGE_KEYS = [
  "dp-csrf",
  "dp-riyoCd",
  "dp-dId",
  "dp-userName",
  "dp-lastLoginTime",
  "dp-sentakukino",
  "dp-hyoujiseigyo",
  "dp-sfn",
] as const;

export type MailboxFailureCode =
  | "sbi_mailbox_bootstrap_unobserved"
  | "sbi_mailbox_handoff_unobserved"
  | "sbi_mailbox_transport_failed"
  | "sbi_mailbox_response_bound"
  | "sbi_mailbox_progress_failed"
  | "sbi_mailbox_lease_lost"
  | "sbi_mailbox_response_unobserved"
  | "sbi_mailbox_rows_over_bound"
  | "sbi_mailbox_inventory_incomplete"
  | "sbi_mailbox_document_unobserved";

export class MailboxError extends Error {
  constructor(readonly code: MailboxFailureCode) {
    super(code);
    this.name = "MailboxError";
  }
}

/**
 * The part of the witnessed bootstrap grammar a page departed from, in closed
 * names only: never the page's text, script source, key or value.
 */
export type BootstrapRule =
  | "html"
  | "elements"
  | "script-element"
  | "script-parse"
  | "statements"
  | "onload"
  | "storage"
  | "redirect-call"
  | "redirect-function"
  | "redirect-navigation"
  | "redirect-dynamic"
  | "redirect-origin"
  | "redirect-path";

/** A refused bootstrap page, with the rule and, for a count rule, the count. */
export class BootstrapRefusal extends MailboxError {
  constructor(
    readonly rule: BootstrapRule,
    readonly count?: number,
  ) {
    super("sbi_mailbox_bootstrap_unobserved");
  }
}

interface BootstrapMaterial {
  readonly csrf: string;
  readonly riyoCd: string;
}
type HtmlNode = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];
type SyntaxNode = { type: string; [key: string]: unknown };

/** Extract the witnessed literal grammar without executing any provider code. */
export function mailboxBootstrap(html: string): BootstrapMaterial {
  stage = "html";
  try {
    return extractBootstrap(html);
  } catch (error) {
    // Parser diagnostics can contain source fragments and must never escape;
    // only the closed rule and count of our own refusal are kept.
    if (error instanceof BootstrapRefusal) throw new BootstrapRefusal(error.rule, error.count);
    throw new BootstrapRefusal(stage);
  }
}

/** The grammar part being checked; a refusal inside a shared helper names it. */
let stage: BootstrapRule = "html";

function extractBootstrap(html: string): BootstrapMaterial {
  if (html.length > MAX_HTML_CHARACTERS) refuse();
  let invalidHtml = false;
  const document = parseHtml(html, {
    onParseError: (error) => {
      if (error.code !== "missing-doctype") invalidHtml = true;
    },
  });
  if (invalidHtml) refuse();
  const elements: Element[] = [];
  const visit = (node: HtmlNode, depth: number): void => {
    if (depth > 64) refuse();
    if ("tagName" in node) elements.push(node);
    if ("childNodes" in node) for (const child of node.childNodes) visit(child, depth + 1);
    // Template contents are a separate subtree in parse5.
    if ("content" in node) refuse();
  };
  visit(document, 0);
  stage = "elements";
  let fallbackAnchors = 0;
  const text = (node: HtmlNode): string =>
    "value" in node ? node.value : "childNodes" in node ? node.childNodes.map(text).join("") : "";
  for (const element of elements) {
    for (const attribute of element.attrs.filter((item) => item.name.startsWith("on"))) {
      if (
        element.tagName !== "a" ||
        attribute.name !== "onclick" ||
        attribute.value !== "autoRedirect()" ||
        element.attrs.find((item) => item.name === "href")?.value !== "#" ||
        text(element).trim() !== "こちら" ||
        ++fallbackAnchors > 1
      )
        refuse();
    }
    if (
      element.tagName === "form" ||
      element.tagName === "base" ||
      element.attrs.some(
        (attribute) => element.tagName === "meta" && attribute.name === "http-equiv",
      )
    )
      refuse();
  }
  stage = "script-element";
  const scripts = elements.filter((element) => element.tagName === "script");
  if (scripts.length !== 1) refuse(scripts.length);
  const script = scripts[0]!;
  if (
    script.namespaceURI !== "http://www.w3.org/1999/xhtml" ||
    script.attrs.some(
      (attribute) => attribute.name !== "type" || attribute.value !== "text/javascript",
    ) ||
    script.childNodes.some((child) => child.nodeName !== "#text")
  )
    refuse();
  const source = script.childNodes.map((child) => ("value" in child ? child.value : "")).join("");
  if (source.length > MAX_SCRIPT_CHARACTERS) refuse();
  stage = "script-parse";
  const program = syntax(parseJavaScript(source, { ecmaVersion: 2022, sourceType: "script" }));
  stage = "statements";
  const statements = nodes(program.body);
  if (statements.length !== 2) refuse(statements.length);
  stage = "onload";
  const assignment = expression(statements[0]!);
  if (assignment.type !== "AssignmentExpression" || assignment.operator !== "=") refuse();
  member(assignment.left, "window", "onload");
  const handler = syntax(assignment.right);
  functionShape(handler, "FunctionExpression");
  if (handler.id !== null) refuse();
  const actions = nodes(syntax(handler.body).body);
  if (actions.length !== STORAGE_KEYS.length + 1) refuse(actions.length);
  stage = "storage";
  const values = new Map<string, string>();
  for (const action of actions.slice(0, -1)) {
    const call = expression(action);
    if (call.type !== "CallExpression" || call.optional !== false) refuse();
    member(call.callee, "sessionStorage", "setItem");
    const args = nodes(call.arguments);
    if (args.length !== 2) refuse();
    const key = literal(args[0]!);
    const value = literal(args[1]!);
    if (
      !(STORAGE_KEYS as readonly string[]).includes(key) ||
      values.has(key) ||
      value.length === 0 ||
      value.length > 8192 ||
      /[\u0000-\u001f\u007f]/u.test(value)
    )
      refuse();
    values.set(key, value);
  }
  stage = "redirect-call";
  const redirectCall = expression(actions.at(-1)!);
  if (
    redirectCall.type !== "CallExpression" ||
    redirectCall.optional !== false ||
    syntax(redirectCall.callee).type !== "Identifier" ||
    syntax(redirectCall.callee).name !== "autoRedirect" ||
    nodes(redirectCall.arguments).length !== 0
  )
    refuse();
  stage = "redirect-function";
  const redirect = statements[1]!;
  functionShape(redirect, "FunctionDeclaration");
  if (syntax(redirect.id).type !== "Identifier" || syntax(redirect.id).name !== "autoRedirect")
    refuse();
  const redirectBody = nodes(syntax(redirect.body).body);
  if (redirectBody.length !== 1) refuse(redirectBody.length);
  stage = "redirect-navigation";
  const destination = navigationDestination(expression(redirectBody[0]!));
  // The page is never executed: the client opens the application itself, so
  // any spelling of the navigation is accepted only when its destination is a
  // constant string equal to the application (2026-11-27: the witnessed
  // `window.location.href = origin + path` form no longer matched).
  stage = "redirect-dynamic";
  const href = constantString(destination, 0);
  if (href !== MAILBOX_APPLICATION) {
    stage = href.startsWith(`${MAILBOX_ORIGIN}/`) ? "redirect-path" : "redirect-origin";
    refuse();
  }
  return { csrf: values.get("dp-csrf")!, riyoCd: values.get("dp-riyoCd")! };
}

/**
 * The destination of `[window.]location[.href] = X` or
 * `[window.]location.{assign,replace}(X)`; any other statement is refused.
 */
function navigationDestination(statement: SyntaxNode): SyntaxNode {
  if (statement.type === "AssignmentExpression") {
    if (statement.operator !== "=") refuse();
    const target = syntax(statement.left);
    if (!isLocation(target) && !(locationProperty(target) === "href")) refuse();
    return syntax(statement.right);
  }
  if (statement.type === "CallExpression" && statement.optional === false) {
    const method = locationProperty(syntax(statement.callee));
    const args = nodes(statement.arguments);
    if (
      (method === "assign" || method === "replace") &&
      args.length === 1 &&
      args[0]!.type !== "SpreadElement"
    )
      return args[0]!;
  }
  refuse();
}

/** `location` or `window.location`. */
function isLocation(node: SyntaxNode): boolean {
  if (node.type === "Identifier") return node.name === "location";
  return (
    node.type === "MemberExpression" &&
    node.computed === false &&
    node.optional === false &&
    syntax(node.object).type === "Identifier" &&
    syntax(node.object).name === "window" &&
    syntax(node.property).type === "Identifier" &&
    syntax(node.property).name === "location"
  );
}

/** The non-computed property name of a member of `[window.]location`, else undefined. */
function locationProperty(node: SyntaxNode): string | undefined {
  if (
    node.type !== "MemberExpression" ||
    node.computed !== false ||
    node.optional !== false ||
    !isLocation(syntax(node.object)) ||
    syntax(node.property).type !== "Identifier"
  )
    return undefined;
  return String(syntax(node.property).name);
}

/** A string literal, an expression-free template, or a `+` of those; nothing is evaluated. */
function constantString(node: SyntaxNode, depth: number): string {
  if (depth > 8) refuse();
  if (node.type === "Literal") return literal(node);
  if (node.type === "TemplateLiteral") {
    const quasis = nodes(node.quasis);
    if (nodes(node.expressions).length !== 0 || quasis.length !== 1) refuse();
    const cooked = (quasis[0]!.value as { cooked?: unknown } | undefined)?.cooked;
    if (typeof cooked !== "string") refuse();
    return cooked;
  }
  if (node.type === "BinaryExpression" && node.operator === "+")
    return (
      constantString(syntax(node.left), depth + 1) + constantString(syntax(node.right), depth + 1)
    );
  refuse();
}

function syntax(value: unknown): SyntaxNode {
  if (typeof value !== "object" || value === null || !("type" in value)) refuse();
  if (typeof value.type !== "string") refuse();
  return value as SyntaxNode;
}

function nodes(value: unknown): SyntaxNode[] {
  if (!Array.isArray(value)) refuse();
  return value.map(syntax);
}

function expression(statement: SyntaxNode): SyntaxNode {
  if (statement.type !== "ExpressionStatement") refuse();
  return syntax(statement.expression);
}

function literal(node: SyntaxNode): string {
  if (node.type !== "Literal" || typeof node.value !== "string") refuse();
  return node.value;
}

function member(value: unknown, object: string, property: string): void {
  const node = syntax(value);
  if (
    node.type !== "MemberExpression" ||
    node.computed !== false ||
    node.optional !== false ||
    syntax(node.object).type !== "Identifier" ||
    syntax(node.object).name !== object ||
    syntax(node.property).type !== "Identifier" ||
    syntax(node.property).name !== property
  )
    refuse();
}

function functionShape(node: SyntaxNode, type: string): void {
  if (
    node.type !== type ||
    node.async !== false ||
    node.generator !== false ||
    nodes(node.params).length !== 0 ||
    syntax(node.body).type !== "BlockStatement"
  )
    refuse();
}

function refuse(count?: number): never {
  throw new BootstrapRefusal(stage, count === undefined ? undefined : Math.min(count, 99));
}
