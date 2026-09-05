export const NABLARCH_HIDDEN_SENTINEL = "__KOGANE_REDACTED_DYNAMIC_VALUE__";

const MAX_HTML_BYTES = 2 * 1024 * 1024;
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
const STATIC_ACTION = "https://www.debit.vpass.ne.jp/p/statementInquiry/RW1313010301";
const SAME_HOST = "https://www.debit.vpass.ne.jp";
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
  if (
    !/^\s*<!doctype\s+html\b/iu.test(html) ||
    !/ご利用明細|利用明細/u.test(html) ||
    /\b(?:jsessionid|token|csrf|turnstile|session|localStorage)\b/iu.test(html) ||
    html.includes(NABLARCH_HIDDEN_SENTINEL)
  ) {
    throw new Error("globalpass_html_contract_invalid");
  }
  assertUrlAndEventContract(html, false);

  const before = inspectShape(html, false);
  const variant = identifyVariant(before);
  let redacted = 0;
  let output = html.replace(INPUT, (tag) => {
    const attributes = parseAttributes(tag);
    if (attributeValue(attributes, "name")?.toLowerCase() !== "nablarch_hidden") {
      return tag;
    }
    const values = attributes.filter((attribute) => attribute.name === "value");
    if (values.length !== 1) throw new Error("globalpass_html_contract_invalid");
    const value = values[0]!;
    if (value.value === "") return tag;
    if (value.valueStart === undefined || value.valueEnd === undefined) {
      throw new Error("globalpass_html_contract_invalid");
    }
    redacted += 1;
    return tag.slice(0, value.valueStart) + NABLARCH_HIDDEN_SENTINEL + tag.slice(value.valueEnd);
  });
  if (redacted !== before.nonemptyDynamicCount) {
    throw new Error("globalpass_html_redaction_failed");
  }
  output = canonicalizeInteractiveAttributes(output);
  assertUrlAndEventContract(output, true);
  const after = inspectShape(output, true);
  if (
    identifyVariant(after) !== variant ||
    after.nonemptyDynamicCount !== before.nonemptyDynamicCount
  ) {
    throw new Error("globalpass_html_redaction_failed");
  }
  return output;
}

function inspectShape(html: string, sanitized: boolean): Shape {
  const bytes = new TextEncoder().encode(html);
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_HTML_BYTES) {
    throw new Error("globalpass_html_contract_invalid");
  }
  const hiddenCounts = new Map<string, number>();
  let dynamicCount = 0;
  let nonemptyDynamicCount = 0;
  for (const tag of html.match(INPUT) ?? []) {
    const attributes = parseAttributes(tag);
    if (
      attributes.filter((attribute) => attribute.name === "name").length > 1 ||
      attributes.filter((attribute) => attribute.name === "id").length > 1 ||
      attributes.filter((attribute) => attribute.name === "type").length > 1 ||
      attributes.filter((attribute) => attribute.name === "value").length > 1
    ) {
      throw new Error("globalpass_html_contract_invalid");
    }
    const type = attributeValue(attributes, "type")?.toLowerCase();
    const name = attributeValue(attributes, "name")?.toLowerCase();
    const id = attributeValue(attributes, "id")?.toLowerCase();
    if (
      type === "password" ||
      name === "password" ||
      id === "password" ||
      name === "usrid" ||
      id === "usrid"
    ) {
      throw new Error("globalpass_html_contract_invalid");
    }
    if (type !== "hidden") continue;
    if (!name || !ALLOWED_HIDDEN_NAMES.has(name)) {
      throw new Error("globalpass_html_contract_invalid");
    }
    hiddenCounts.set(name, (hiddenCounts.get(name) ?? 0) + 1);
    if (name !== "nablarch_hidden") continue;
    dynamicCount += 1;
    const value = attributeValue(attributes, "value");
    if (value === undefined) throw new Error("globalpass_html_contract_invalid");
    if (value !== "") {
      nonemptyDynamicCount += 1;
      if (sanitized && value !== NABLARCH_HIDDEN_SENTINEL) {
        throw new Error("globalpass_html_redaction_failed");
      }
    }
  }

  let formCount = 0;
  let staticActionCount = 0;
  for (const tag of html.match(FORM) ?? []) {
    formCount += 1;
    const attributes = parseAttributes(tag);
    if (attributes.filter((attribute) => attribute.name === "action").length > 1) {
      throw new Error("globalpass_html_contract_invalid");
    }
    const action = attributeValue(attributes, "action") ?? "";
    if (action === "") continue;
    if (action !== STATIC_ACTION) throw new Error("globalpass_html_contract_invalid");
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

function identifyVariant(shape: Shape): "a" | "b" {
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
  throw new Error("globalpass_html_shape_unreviewed");
}

function count(shape: Shape, name: string): number {
  return shape.hiddenCounts.get(name) ?? 0;
}

function assertUrlAndEventContract(html: string, canonical: boolean): void {
  if (/\burl\s*\(|@import\b/iu.test(html)) {
    throw new Error("globalpass_html_contract_invalid");
  }
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
    if (BLOCKED_NETWORK_ELEMENTS.has(element)) {
      throw new Error("globalpass_html_contract_invalid");
    }
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
        throw new Error("globalpass_html_contract_invalid");
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
        throw new Error("globalpass_html_contract_invalid");
      }
    }
    for (const attribute of attributes) {
      const value = attribute.value;
      if (extraUrlAttributes.has(attribute.name)) {
        throw new Error("globalpass_html_contract_invalid");
      }
      if (attribute.name === "action") {
        if (element !== "form" || (value !== "" && value !== STATIC_ACTION)) {
          throw new Error("globalpass_html_contract_invalid");
        }
      } else if (attribute.name === "href") {
        if (value === undefined || !allowedHref(element, value, canonical)) {
          throw new Error("globalpass_html_contract_invalid");
        }
      } else if (attribute.name === "src") {
        const allowed =
          element === "img"
            ? ALLOWED_IMG_SRC_PATHS
            : element === "script"
              ? ALLOWED_SCRIPT_SRC_PATHS
              : null;
        if (value === undefined || allowed === null || !allowedSameHostPath(value, allowed)) {
          throw new Error("globalpass_html_contract_invalid");
        }
      } else if (attribute.name.startsWith("on")) {
        if (value === undefined || !allowedEventHandler(attribute.name, value, canonical)) {
          throw new Error("globalpass_html_contract_invalid");
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

function attributeValue(attributes: Attribute[], name: string): string | undefined {
  const matches = attributes.filter((attribute) => attribute.name === name);
  if (matches.length > 1) throw new Error("globalpass_html_contract_invalid");
  return matches[0]?.value;
}

function assertUtf8RoundTrip(html: string): void {
  const bytes = new TextEncoder().encode(html);
  if (new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== html) {
    throw new Error("globalpass_html_utf8_invalid");
  }
}
