import { visibleText } from "./pagination";

export const NABLARCH_HIDDEN_SENTINEL = "__KOGANE_REDACTED_DYNAMIC_VALUE__";

/**
 * Every way the sanitizer refuses a page, as a closed code. The code is the
 * error's message and its `code`, and it is the only thing about a refused
 * page that leaves this module: the diagnostic log line and the manifest's
 * failure entry carry it, never provider text or a matched value.
 */
export const GLOBALPASS_SANITIZER_CODES = [
  "globalpass_html_contract_invalid",
  "globalpass_html_redaction_failed",
  "globalpass_html_shape_unreviewed",
  "globalpass_html_utf8_invalid",
] as const;
export type GlobalPassSanitizerCode = (typeof GLOBALPASS_SANITIZER_CODES)[number];

/**
 * Which expectation of the sanitizer's contract a refused page failed, one
 * closed code per check in this module. Several expectations share one
 * `GlobalPassSanitizerCode`; the expectation says which of them it was. It is
 * the first failure in check order, not every failure the page has.
 */
export const GLOBALPASS_SANITIZER_EXPECTATIONS = [
  // globalpass_html_utf8_invalid
  "utf8_invalid",
  // globalpass_html_contract_invalid: the page as a whole
  "doctype_missing",
  "activity_heading_missing",
  "forbidden_token",
  "sentinel_present",
  "size_out_of_range",
  // globalpass_html_contract_invalid: URL and event sinks
  "css_url",
  "blocked_element",
  "duplicate_attribute",
  "http_equiv_unallowed",
  "url_attribute",
  "action_unallowed",
  "href_unallowed",
  "src_unallowed",
  "event_handler_unallowed",
  // globalpass_html_contract_invalid: form inputs
  "credential_field",
  "hidden_name_unallowed",
  "hidden_value_missing",
  // globalpass_html_shape_unreviewed
  "variant_unmatched",
  // globalpass_html_redaction_failed
  "redaction_count_mismatch",
  "redacted_value_unexpected",
  "variant_changed",
] as const;
export type GlobalPassSanitizerExpectation = (typeof GLOBALPASS_SANITIZER_EXPECTATIONS)[number];

/** The element a refusal was about, by tag name from a closed list. */
export const GLOBALPASS_SANITIZER_ELEMENTS = [
  "a",
  "button",
  "form",
  "img",
  "input",
  "link",
  "meta",
  "script",
  "select",
  "style",
  "applet",
  "audio",
  "base",
  "embed",
  "fencedframe",
  "frame",
  "frameset",
  "iframe",
  "object",
  "portal",
  "source",
  "svg",
  "track",
  "video",
  "other",
] as const;
export type GlobalPassSanitizerElement = (typeof GLOBALPASS_SANITIZER_ELEMENTS)[number];

/** The attribute a refusal was about, as a closed class, never its name as written. */
export const GLOBALPASS_SANITIZER_ATTRIBUTES = [
  "action",
  "event_handler",
  "href",
  "http_equiv",
  "id",
  "name",
  "src",
  "type",
  "url_attribute",
  "value",
] as const;
export type GlobalPassSanitizerAttribute = (typeof GLOBALPASS_SANITIZER_ATTRIBUTES)[number];

/** Whether the check ran on the page as received or on the redacted output. */
export type GlobalPassSanitizerPhase = "input" | "output";

export interface GlobalPassSanitizerDetail {
  readonly expectation: GlobalPassSanitizerExpectation;
  readonly phase: GlobalPassSanitizerPhase;
  readonly element?: GlobalPassSanitizerElement;
  readonly attribute?: GlobalPassSanitizerAttribute;
}

export class GlobalPassSanitizerError extends Error {
  readonly code: GlobalPassSanitizerCode;
  readonly detail: GlobalPassSanitizerDetail;
  constructor(code: GlobalPassSanitizerCode, detail: GlobalPassSanitizerDetail) {
    super(code);
    this.name = "GlobalPassSanitizerError";
    this.code = code;
    this.detail = detail;
  }
}

function refuse(
  code: GlobalPassSanitizerCode,
  expectation: GlobalPassSanitizerExpectation,
  phase: GlobalPassSanitizerPhase,
  tag?: string,
  attribute?: GlobalPassSanitizerAttribute,
): never {
  throw new GlobalPassSanitizerError(code, {
    expectation,
    phase,
    ...(tag !== undefined ? { element: elementCode(tag) } : {}),
    ...(attribute !== undefined ? { attribute } : {}),
  });
}

function elementCode(tag: string): GlobalPassSanitizerElement {
  const name = tagName(tag);
  return (GLOBALPASS_SANITIZER_ELEMENTS as readonly string[]).includes(name) && name !== "other"
    ? (name as GlobalPassSanitizerElement)
    : "other";
}

function attributeClass(name: string): GlobalPassSanitizerAttribute {
  if (name === "href" || name === "src" || name === "action") return name;
  if (name === "http-equiv") return "http_equiv";
  if (name.startsWith("on")) return "event_handler";
  return "url_attribute";
}

/** The closed code of a sanitizer refusal, or `undefined` for anything else. */
export function sanitizerCode(error: unknown): GlobalPassSanitizerCode | undefined {
  if (!(error instanceof GlobalPassSanitizerError)) return undefined;
  return (GLOBALPASS_SANITIZER_CODES as readonly string[]).includes(error.code)
    ? error.code
    : undefined;
}

/** The failed expectation of a sanitizer refusal, or `undefined` for anything else. */
export function sanitizerExpectation(error: unknown): GlobalPassSanitizerExpectation | undefined {
  if (sanitizerCode(error) === undefined) return undefined;
  const expectation = (error as GlobalPassSanitizerError).detail?.expectation;
  return typeof expectation === "string" &&
    (GLOBALPASS_SANITIZER_EXPECTATIONS as readonly string[]).includes(expectation)
    ? expectation
    : undefined;
}

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const DOCTYPE = /^\s*<!doctype\s+html\b/iu;
/**
 * The activity statement's name, in either language GLOBAL PASS serves. The
 * collector's session is English (`engUseFlg`): every production refusal of
 * 2026-09-28 was `activity_heading_missing` on a logged-in page with the month
 * select, and a live survey of the same pages (2026-09-29) found the title
 * `Account Activities`, the heading `Viewing Monthly Account Activities`, and
 * no 「ご利用明細」 or 「利用明細」 anywhere. A Japanese session names the
 * statement 「ご利用明細」/「利用明細」. Either one marks the activity page. The
 * same survey found the English page differs from the reviewed contract in two
 * more places only, both admitted exactly (`isStaticAction`,
 * `MENU_TOGGLE_ONCLICK`); forms, hidden inputs and every other URL are as
 * reviewed.
 */
const ACTIVITY_HEADING = /ご利用明細|利用明細|Account Activities/u;
const FORBIDDEN_TOKEN = /\b(?:jsessionid|token|csrf|turnstile|session|localStorage)\b/iu;
const CSS_URL = /\burl\s*\(|@import\b/iu;
const INPUT = /<input\b[^>]*>/giu;
const FORM = /<form\b[^>]*>/giu;
const ATTRIBUTE = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;
const ALLOWED_HIDDEN_NAMES = new Set([
  "cc",
  "enguseflg",
  "nablarch_hidden",
  "nablarch_needs_hidden_encryption",
  "nablarch_submit",
  "w131301.referencedate",
]);
const SAME_HOST = "https://www.debit.vpass.ne.jp";
/**
 * The one form with an action, the statement download form. The retained pages
 * write it absolute; the English pages the collector receives write the same
 * path relative (live survey 2026-09-29). Both name one resource on one host.
 */
const STATIC_ACTION_PATH = "/p/statementInquiry/RW1313010301";
const STATIC_ACTION = `${SAME_HOST}${STATIC_ACTION_PATH}`;

function isStaticAction(value: string | undefined): boolean {
  return value === STATIC_ACTION || value === STATIC_ACTION_PATH;
}

/**
 * The English pages' `Manage Services` menu toggle, exactly as the live survey
 * of 2026-09-29 found it. It is the only handler outside the reviewed call
 * grammar (it starts with `if`), and, like every handler, it is stored as
 * `return false;`. Attribute values are compared as written, so both
 * spellings of its `<` are listed: the literal the provider sends and the
 * `&lt;` a DOM serializer (`page.content()`) may write.
 */
const MENU_TOGGLE_ONCLICK = new Set(
  ["<", "&lt;"].map(
    (lessThan) =>
      `if (window.innerWidth ${lessThan} 640) { $(this.parentNode).toggleClass('closed'); } ` +
      "else { $('#chgAccountSettingMenu')[0].click(); } return false;",
  ),
);

const ALLOWED_LINK_HREF_PATHS = new Set([
  "/en//01006/css/master.css",
  "/en//01006/css/nablarch.css",
  "/en//01006/css/normalize.css",
  "/en//01006/img/favicon.ico",
]);
const ALLOWED_ANCHOR_HREF_PATHS = new Set([
  "/p/cashBackInquiry/RW1322010101",
  "/p/chgAccountSetting/RW1315000101",
  "/p/chgAccountSetting/RW1315000102",
  "/p/chgControlRule/RW1315KY0101",
  "/p/chgIdPass/RW1315010101",
  "/p/chgLimit/RW1315030101",
  "/p/chgStopRelease/RW1315040101",
  "/p/contact/RW13K1010101",
  "/p/login/RW1312010201",
  "/p/login/RW1312010301",
  "/p/statementInquiry/RW1313010101",
  "/p/statementInquiry/RW1313010201",
]);
const ALLOWED_IMG_SRC_PATHS = new Set(["/en/01006/img/logo.jpg"]);
const ALLOWED_SCRIPT_SRC_PATHS = new Set([
  "/js/jquery.js",
  "/js/run.js",
  "/js/TabindexOrder.js",
  "/js/W131301.js",
]);
const BLOCKED_NETWORK_ELEMENTS = new Set([
  "applet",
  "audio",
  "base",
  "embed",
  "fencedframe",
  "frame",
  "frameset",
  "iframe",
  "object",
  "portal",
  "source",
  "svg",
  "track",
  "video",
]);

interface Attribute {
  name: string;
  value: string | undefined;
  valueStart: number | undefined;
  valueEnd: number | undefined;
}

interface Shape {
  formCount: number;
  staticActionCount: number;
  hiddenCounts: Map<string, number>;
  dynamicCount: number;
  nonemptyDynamicCount: number;
}

/**
 * Redacts only the varying encrypted Nablarch state observed in the retained
 * activity pages. Empty state and statement-selection evidence remain byte-for-
 * byte unchanged. Any unreviewed page shape fails before bytes can reach R2.
 */
export function sanitizeGlobalPassActivityHtml(html: string): string {
  assertUtf8RoundTrip(html);
  const contract = "globalpass_html_contract_invalid";
  if (!DOCTYPE.test(html)) refuse(contract, "doctype_missing", "input");
  if (!ACTIVITY_HEADING.test(html)) refuse(contract, "activity_heading_missing", "input");
  if (FORBIDDEN_TOKEN.test(html)) refuse(contract, "forbidden_token", "input");
  if (html.includes(NABLARCH_HIDDEN_SENTINEL)) refuse(contract, "sentinel_present", "input");
  assertUrlAndEventContract(html, false);

  const before = inspectShape(html, false);
  const variant = identifyVariant(before, "input");
  let redacted = 0;
  let output = html.replace(INPUT, (tag) => {
    const attributes = parseAttributes(tag);
    if (attributeValue(attributes, "name")?.toLowerCase() !== "nablarch_hidden") {
      return tag;
    }
    const values = attributes.filter((attribute) => attribute.name === "value");
    if (values.length !== 1) {
      refuse("globalpass_html_contract_invalid", "hidden_value_missing", "input", tag, "value");
    }
    const value = values[0]!;
    if (value.value === "") return tag;
    if (value.valueStart === undefined || value.valueEnd === undefined) {
      refuse("globalpass_html_contract_invalid", "hidden_value_missing", "input", tag, "value");
    }
    redacted += 1;
    return tag.slice(0, value.valueStart) + NABLARCH_HIDDEN_SENTINEL + tag.slice(value.valueEnd);
  });
  if (redacted !== before.nonemptyDynamicCount) {
    refuse("globalpass_html_redaction_failed", "redaction_count_mismatch", "output");
  }
  output = canonicalizeInteractiveAttributes(output);
  assertUrlAndEventContract(output, true);
  const after = inspectShape(output, true);
  if (
    identifyVariant(after, "output") !== variant ||
    after.nonemptyDynamicCount !== before.nonemptyDynamicCount
  ) {
    refuse("globalpass_html_redaction_failed", "variant_changed", "output");
  }
  return output;
}

function inspectShape(html: string, sanitized: boolean): Shape {
  const phase: GlobalPassSanitizerPhase = sanitized ? "output" : "input";
  const contract = "globalpass_html_contract_invalid";
  const bytes = new TextEncoder().encode(html);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_HTML_BYTES) {
    refuse(contract, "size_out_of_range", phase);
  }
  const hiddenCounts = new Map<string, number>();
  let dynamicCount = 0;
  let nonemptyDynamicCount = 0;
  for (const tag of html.match(INPUT) ?? []) {
    const attributes = parseAttributes(tag);
    for (const name of ["name", "id", "type", "value"] as const) {
      if (attributes.filter((attribute) => attribute.name === name).length > 1) {
        refuse(contract, "duplicate_attribute", phase, tag, name);
      }
    }
    const type = attributeValue(attributes, "type", phase)?.toLowerCase();
    const name = attributeValue(attributes, "name", phase)?.toLowerCase();
    const id = attributeValue(attributes, "id", phase)?.toLowerCase();
    if (
      type === "password" ||
      name === "password" ||
      id === "password" ||
      name === "usrid" ||
      id === "usrid"
    ) {
      refuse(contract, "credential_field", phase, tag);
    }
    if (type !== "hidden") continue;
    if (!name || !ALLOWED_HIDDEN_NAMES.has(name)) {
      refuse(contract, "hidden_name_unallowed", phase, tag, "name");
    }
    hiddenCounts.set(name, (hiddenCounts.get(name) ?? 0) + 1);
    if (name !== "nablarch_hidden") continue;
    dynamicCount += 1;
    const value = attributeValue(attributes, "value", phase);
    if (value === undefined) refuse(contract, "hidden_value_missing", phase, tag, "value");
    if (value !== "") {
      nonemptyDynamicCount += 1;
      if (sanitized && value !== NABLARCH_HIDDEN_SENTINEL) {
        refuse(
          "globalpass_html_redaction_failed",
          "redacted_value_unexpected",
          phase,
          tag,
          "value",
        );
      }
    }
  }

  let formCount = 0;
  let staticActionCount = 0;
  for (const tag of html.match(FORM) ?? []) {
    formCount += 1;
    const attributes = parseAttributes(tag);
    if (attributes.filter((attribute) => attribute.name === "action").length > 1) {
      refuse(contract, "duplicate_attribute", phase, tag, "action");
    }
    const action = attributeValue(attributes, "action", phase) ?? "";
    if (action === "") continue;
    if (!isStaticAction(action)) refuse(contract, "action_unallowed", phase, tag, "action");
    staticActionCount += 1;
  }
  return {
    formCount,
    staticActionCount,
    hiddenCounts,
    dynamicCount,
    nonemptyDynamicCount,
  };
}

function identifyVariant(shape: Shape, phase: GlobalPassSanitizerPhase): "a" | "b" {
  const common =
    count(shape, "cc") === 1 &&
    count(shape, "enguseflg") === 1 &&
    count(shape, "nablarch_needs_hidden_encryption") === 1;
  const variantA =
    common &&
    shape.formCount === 6 &&
    shape.staticActionCount === 1 &&
    shape.dynamicCount === 6 &&
    shape.nonemptyDynamicCount === 4 &&
    count(shape, "nablarch_submit") === 6 &&
    count(shape, "w131301.referencedate") === 1;
  const variantB =
    common &&
    shape.formCount === 5 &&
    shape.staticActionCount === 0 &&
    shape.dynamicCount === 4 &&
    shape.nonemptyDynamicCount === 3 &&
    count(shape, "nablarch_submit") === 4 &&
    count(shape, "w131301.referencedate") === 0;
  if (variantA) return "a";
  if (variantB) return "b";
  return refuse("globalpass_html_shape_unreviewed", "variant_unmatched", phase);
}

function count(shape: Shape, name: string): number {
  return shape.hiddenCounts.get(name) ?? 0;
}

function assertUrlAndEventContract(html: string, canonical: boolean): void {
  const phase: GlobalPassSanitizerPhase = canonical ? "output" : "input";
  const contract = "globalpass_html_contract_invalid";
  if (CSS_URL.test(html)) refuse(contract, "css_url", phase);
  const extraUrlAttributes = new Set([
    "archive",
    "background",
    "cite",
    "code",
    "codebase",
    "data",
    "datasrc",
    "dynsrc",
    "formaction",
    "icon",
    "imagesrcset",
    "longdesc",
    "lowsrc",
    "manifest",
    "ping",
    "poster",
    "profile",
    "srcdoc",
    "srcset",
    "usemap",
    "xlink:href",
    "xmlns",
    "xmlns:xlink",
  ]);
  for (const tag of html.match(/<[A-Za-z][^>]*>/gu) ?? []) {
    const attributes = parseAttributes(tag);
    const element = tagName(tag);
    if (BLOCKED_NETWORK_ELEMENTS.has(element)) refuse(contract, "blocked_element", phase, tag);
    const sensitiveNames = new Set(
      attributes
        .map((attribute) => attribute.name)
        .filter(
          (name) =>
            name === "href" ||
            name === "src" ||
            name === "action" ||
            name === "http-equiv" ||
            extraUrlAttributes.has(name) ||
            name.startsWith("on"),
        ),
    );
    for (const name of sensitiveNames) {
      if (attributes.filter((attribute) => attribute.name === name).length !== 1) {
        refuse(contract, "duplicate_attribute", phase, tag, attributeClass(name));
      }
    }
    const httpEquiv = attributes.find((attribute) => attribute.name === "http-equiv");
    if (httpEquiv) {
      const allowed = new Set([
        "cache-control",
        "content-language",
        "content-script-type",
        "content-style-type",
        "content-type",
        "expires",
        "pragma",
        "x-ua-compatible",
      ]);
      if (
        element !== "meta" ||
        httpEquiv.value === undefined ||
        !allowed.has(httpEquiv.value.trim().toLowerCase())
      ) {
        refuse(contract, "http_equiv_unallowed", phase, tag, "http_equiv");
      }
    }
    for (const attribute of attributes) {
      const value = attribute.value;
      if (extraUrlAttributes.has(attribute.name)) {
        refuse(contract, "url_attribute", phase, tag, "url_attribute");
      }
      if (attribute.name === "action") {
        if (element !== "form" || (value !== "" && !isStaticAction(value))) {
          refuse(contract, "action_unallowed", phase, tag, "action");
        }
      } else if (attribute.name === "href") {
        if (value === undefined || !allowedHref(element, value, canonical)) {
          refuse(contract, "href_unallowed", phase, tag, "href");
        }
      } else if (attribute.name === "src") {
        const allowed =
          element === "img"
            ? ALLOWED_IMG_SRC_PATHS
            : element === "script"
              ? ALLOWED_SCRIPT_SRC_PATHS
              : null;
        if (value === undefined || allowed === null || !allowedSameHostPath(value, allowed)) {
          refuse(contract, "src_unallowed", phase, tag, "src");
        }
      } else if (attribute.name.startsWith("on")) {
        if (value === undefined || !allowedEventHandler(attribute.name, value, canonical)) {
          refuse(contract, "event_handler_unallowed", phase, tag, "event_handler");
        }
      }
    }
  }
}

function tagName(tag: string): string {
  return /^<([A-Za-z][A-Za-z0-9:-]*)/u.exec(tag)?.[1]?.toLowerCase() ?? "";
}

function canonicalizeInteractiveAttributes(html: string): string {
  return html.replace(/<[A-Za-z][^>]*>/gu, (tag) => {
    const replacements: Array<{ start: number; end: number; value: string }> = [];
    for (const attribute of parseAttributes(tag)) {
      if (
        attribute.valueStart === undefined ||
        attribute.valueEnd === undefined ||
        attribute.value === undefined
      )
        continue;
      if (attribute.name === "href" && attribute.value.startsWith("#")) {
        replacements.push({
          start: attribute.valueStart,
          end: attribute.valueEnd,
          value: "#",
        });
      } else if (attribute.name === "onclick" || attribute.name === "onchange") {
        replacements.push({
          start: attribute.valueStart,
          end: attribute.valueEnd,
          value: "return false;",
        });
      }
    }
    let output = tag;
    for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
      output =
        output.slice(0, replacement.start) + replacement.value + output.slice(replacement.end);
    }
    return output;
  });
}

function allowedHref(element: string, value: string, canonical: boolean): boolean {
  if (element === "link") return allowedSameHostPath(value, ALLOWED_LINK_HREF_PATHS);
  if (element !== "a") return false;
  return (
    value === "https://www.smbctb.co.jp/" ||
    (canonical ? value === "#" : /^#[A-Za-z0-9._:-]*$/u.test(value)) ||
    /^javascript:void\(0\);?$/u.test(value) ||
    allowedSameHostPath(value, ALLOWED_ANCHOR_HREF_PATHS)
  );
}

function allowedSameHostPath(value: string, allowed: ReadonlySet<string>): boolean {
  if (value.includes("?") || value.includes("#") || /;jsessionid/iu.test(value)) return false;
  if (value.startsWith("/")) return allowed.has(value);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return (
    parsed.origin === SAME_HOST &&
    parsed.username === "" &&
    parsed.password === "" &&
    parsed.search === "" &&
    parsed.hash === "" &&
    allowed.has(parsed.pathname)
  );
}

function allowedEventHandler(name: string, value: string, canonical: boolean): boolean {
  if (canonical) {
    return (name === "onclick" || name === "onchange") && value === "return false;";
  }
  if (name === "onclick" && MENU_TOGGLE_ONCLICK.has(value)) return true;
  if (
    /https?:|javascript:|data:|fetch|xmlhttprequest|document|cookie|storage|eval|function|=>/iu.test(
      value,
    )
  )
    return false;
  const functionNames = [
    ...value.matchAll(
      /\b(?:window\.)?[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*(?=\s*\()/gu,
    ),
  ].map((match) => match[0]!);
  const allowedFunctions =
    name === "onchange"
      ? new Set(["sel_submit"])
      : name === "onclick"
        ? new Set(["click", "toggleClass", "window.nablarch_submit"])
        : null;
  if (
    !allowedFunctions ||
    functionNames.length === 0 ||
    functionNames.some((functionName) => !allowedFunctions.has(functionName))
  )
    return false;
  const withoutStrings = value.replace(/"[^"]*"|'[^']*'/gu, "");
  const identifiers = withoutStrings.match(/[A-Za-z_$][A-Za-z0-9_$]*/gu) ?? [];
  const allowedIdentifiers = new Set([
    "click",
    "event",
    "false",
    "nablarch_submit",
    "return",
    "sel_submit",
    "this",
    "toggleClass",
    "true",
    "window",
  ]);
  return identifiers.every((identifier) => allowedIdentifiers.has(identifier));
}

function parseAttributes(tag: string): Attribute[] {
  const attributes: Attribute[] = [];
  const firstSpace = tag.search(/\s/u);
  ATTRIBUTE.lastIndex = firstSpace < 0 ? tag.length : firstSpace;
  let match: RegExpExecArray | null;
  while ((match = ATTRIBUTE.exec(tag)) !== null) {
    const name = match[1]!.toLowerCase();
    const full = match[0];
    const value = match[2] ?? match[3] ?? match[4];
    let valueStart: number | undefined;
    let valueEnd: number | undefined;
    if (value !== undefined) {
      const equals = full.indexOf("=");
      let relativeStart = equals + 1;
      while (/\s/u.test(full[relativeStart] ?? "")) relativeStart += 1;
      const quote = full[relativeStart];
      if (quote === '"' || quote === "'") relativeStart += 1;
      valueStart = match.index + relativeStart;
      valueEnd = valueStart + value.length;
    }
    attributes.push({ name, value, valueStart, valueEnd });
  }
  return attributes;
}

function attributeValue(
  attributes: Attribute[],
  name: "action" | "id" | "name" | "type" | "value",
  phase: GlobalPassSanitizerPhase = "input",
): string | undefined {
  const matches = attributes.filter((attribute) => attribute.name === name);
  if (matches.length > 1) {
    refuse("globalpass_html_contract_invalid", "duplicate_attribute", phase, undefined, name);
  }
  return matches[0]?.value;
}

function assertUtf8RoundTrip(html: string): void {
  const bytes = new TextEncoder().encode(html);
  if (new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== html) {
    refuse("globalpass_html_utf8_invalid", "utf8_invalid", "input");
  }
}

/**
 * What a refused page looked like, as closed codes, booleans and counts only.
 * It is computed from the page the sanitizer refused and logged with the
 * refusal (ADR 0026's amendment of 2026-09-28), so a refusal can be diagnosed
 * without fetching the page by hand. It carries no text, attribute value, URL
 * or number read from the page: every count is a count of markup this module
 * matched, and the two lengths are reduced to their number of digits.
 */
export interface GlobalPassRefusalShape {
  /** The failed expectation, or `unknown` for an error that is not a sanitizer refusal. */
  readonly expectation: GlobalPassSanitizerExpectation | "unknown";
  readonly phase: GlobalPassSanitizerPhase | "unknown";
  readonly element?: GlobalPassSanitizerElement;
  readonly attribute?: GlobalPassSanitizerAttribute;
  /** False when the counts could not be computed; the counts are then absent, not zero. */
  readonly summarized: boolean;
  /** Number of decimal digits of the page's UTF-8 byte length (0 for an empty page). */
  readonly byteMagnitude?: number;
  /** Number of decimal digits of the page's visible text length (0 for no text). */
  readonly textMagnitude?: number;
  /** Opening tags counted by element name. `blocked` sums the refused network elements. */
  readonly elements?: Readonly<Record<(typeof COUNTED_ELEMENTS)[number] | "blocked", number>>;
  /** The counts the sanitizer's two reviewed variants are defined by. */
  readonly contract?: Readonly<{
    forms: number;
    staticActionForms: number;
    hiddenInputs: number;
    hiddenUnlisted: number;
    cc: number;
    engUseFlg: number;
    nablarchHidden: number;
    nablarchHiddenNonempty: number;
    nablarchNeedsHiddenEncryption: number;
    nablarchSubmit: number;
    referenceDate: number;
  }>;
  readonly landmarks?: Readonly<{
    doctype: boolean;
    activityHeading: boolean;
    title: boolean;
    activityHeadingInTitle: boolean;
    loginForm: boolean;
    passwordField: boolean;
    monthSelect: boolean;
    sentinel: boolean;
  }>;
  /** Occurrences of each of the sanitizer's forbidden tokens, by the token's own name. */
  readonly forbiddenTokens?: Readonly<Record<(typeof FORBIDDEN_TOKENS)[number], number>>;
}

const COUNTED_ELEMENTS = [
  "table",
  "tr",
  "th",
  "td",
  "form",
  "input",
  "select",
  "button",
  "script",
  "style",
  "a",
  "link",
  "img",
  "meta",
  "title",
] as const;
const FORBIDDEN_TOKENS = [
  "jsessionid",
  "token",
  "csrf",
  "turnstile",
  "session",
  "localStorage",
] as const;
const HIDDEN_NAME_KEYS = {
  cc: "cc",
  enguseflg: "engUseFlg",
  nablarch_hidden: "nablarchHidden",
  nablarch_needs_hidden_encryption: "nablarchNeedsHiddenEncryption",
  nablarch_submit: "nablarchSubmit",
  "w131301.referencedate": "referenceDate",
} as const;

/** The structure of a refused page. Never throws. */
export function globalPassRefusalShape(html: string, error: unknown): GlobalPassRefusalShape {
  const detail = error instanceof GlobalPassSanitizerError ? error.detail : undefined;
  const head = {
    expectation: detail?.expectation ?? ("unknown" as const),
    phase: detail?.phase ?? ("unknown" as const),
    ...(detail?.element !== undefined ? { element: detail.element } : {}),
    ...(detail?.attribute !== undefined ? { attribute: detail.attribute } : {}),
  };
  try {
    return { ...head, summarized: true, ...countShape(String(html)) };
  } catch {
    return { ...head, summarized: false };
  }
}

function countShape(html: string) {
  const tags = html.match(/<[A-Za-z][^>]*>/gu) ?? [];
  const names = tags.map(tagName);
  const elements = Object.fromEntries(
    COUNTED_ELEMENTS.map((name) => [name, names.filter((tag) => tag === name).length]),
  ) as Record<(typeof COUNTED_ELEMENTS)[number], number>;
  const contract = {
    forms: 0,
    staticActionForms: 0,
    hiddenInputs: 0,
    hiddenUnlisted: 0,
    cc: 0,
    engUseFlg: 0,
    nablarchHidden: 0,
    nablarchHiddenNonempty: 0,
    nablarchNeedsHiddenEncryption: 0,
    nablarchSubmit: 0,
    referenceDate: 0,
  };
  let loginForm = false;
  let passwordField = false;
  for (const tag of tags) {
    const element = tagName(tag);
    if (element !== "input" && element !== "form") continue;
    const attributes = parseAttributes(tag);
    const first = (name: string) =>
      attributes.find((attribute) => attribute.name === name)?.value?.toLowerCase();
    if (element === "form") {
      contract.forms += 1;
      if (attributes.some((a) => a.name === "action" && isStaticAction(a.value))) {
        contract.staticActionForms += 1;
      }
      continue;
    }
    const type = first("type");
    const name = first("name");
    const id = first("id");
    if (name === "usrid" || id === "usrid") loginForm = true;
    if (type === "password" || name === "password" || id === "password") passwordField = true;
    if (type !== "hidden") continue;
    contract.hiddenInputs += 1;
    const key =
      name !== undefined && Object.hasOwn(HIDDEN_NAME_KEYS, name)
        ? HIDDEN_NAME_KEYS[name as keyof typeof HIDDEN_NAME_KEYS]
        : undefined;
    if (key === undefined) {
      contract.hiddenUnlisted += 1;
      continue;
    }
    contract[key] += 1;
    if (key === "nablarchHidden" && first("value")) contract.nablarchHiddenNonempty += 1;
  }
  const titles = [...html.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/giu)].map(
    (match) => match[1] ?? "",
  );
  return {
    byteMagnitude: digits(new TextEncoder().encode(html).byteLength),
    textMagnitude: digits(visibleText(html).trim().length),
    elements: {
      ...elements,
      blocked: names.filter((name) => BLOCKED_NETWORK_ELEMENTS.has(name)).length,
    },
    contract,
    landmarks: {
      doctype: DOCTYPE.test(html),
      activityHeading: ACTIVITY_HEADING.test(html),
      title: titles.length > 0,
      activityHeadingInTitle: titles.some((title) => ACTIVITY_HEADING.test(title)),
      loginForm,
      passwordField,
      monthSelect: elements.select > 0,
      sentinel: html.includes(NABLARCH_HIDDEN_SENTINEL),
    },
    forbiddenTokens: Object.fromEntries(
      FORBIDDEN_TOKENS.map((token) => [
        token,
        (html.match(new RegExp(`\\b${token}\\b`, "giu")) ?? []).length,
      ]),
    ) as Record<(typeof FORBIDDEN_TOKENS)[number], number>,
  };
}

function digits(length: number): number {
  return length <= 0 ? 0 : String(Math.floor(length)).length;
}
