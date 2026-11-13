import { parse, type DefaultTreeAdapterMap } from "parse5";
import { MailboxError, MAILBOX_ORIGIN } from "./mailbox-bootstrap";

export const MAILBOX_ENTRY = "https://m.sbisec.co.jp/edeliv/deisw070.jsp?ePoboxFlag=true";
export const MAILBOX_CONNECT = "https://m.sbisec.co.jp/deisw081";
export const MAILBOX_SSO = `${MAILBOX_ORIGIN}/dp-uw/v1/SSO`;
export const MAILBOX_BOOTSTRAP = `${MAILBOX_ORIGIN}/dp-uw/v1/DPAW010501000`;
const SSO_FIELDS = ["sfn", "ric", "ked", "epr", "itv", "hav", "spm"];
type Node = DefaultTreeAdapterMap["node"];
type Element = DefaultTreeAdapterMap["element"];

/** Read only the exact observed POST carrier; provider script is never evaluated. */
export function mailboxForm(html: string, sourceUrl: string): URLSearchParams {
  try {
    const source =
      sourceUrl === MAILBOX_ENTRY ? "entry" : sourceUrl === MAILBOX_CONNECT ? "connect" : null;
    if (source === null || html.length > 256 * 1024) refuse();
    let invalid = false;
    let legacyDoctype = false;
    const document = parse(html, {
      onParseError: (error) => {
        if (error.code === "non-conforming-doctype") legacyDoctype = true;
        else if (error.code !== "missing-doctype") invalid = true;
      },
    });
    if (legacyDoctype) {
      const doctype = document.childNodes.find((node) => node.nodeName === "#documentType");
      if (
        doctype === undefined ||
        !("publicId" in doctype) ||
        doctype.name !== "html" ||
        doctype.publicId !== "-//W3C//DTD HTML 4.01 Transitional//EN" ||
        doctype.systemId !== "http://www.w3.org/TR/html4/loose.dtd"
      )
        invalid = true;
    }
    if (invalid) refuse();
    const elements: Element[] = [];
    const visit = (node: Node, depth: number): void => {
      if (depth > 64 || "content" in node) refuse();
      if ("tagName" in node) elements.push(node);
      if ("childNodes" in node) for (const child of node.childNodes) visit(child, depth + 1);
    };
    visit(document, 0);
    // Unrelated embedded elements are inert here: neither fetched nor executed.
    // They cannot change the sole form's exact carrier or scoped control set.
    if (elements.some((element) => element.tagName === "base")) refuse();
    const forms = elements.filter((element) => element.tagName === "form");
    if (forms.length !== 1) refuse();
    const form = forms[0]!;
    const attribute = (element: Element, name: string) =>
      element.attrs.find((item) => item.name === name)?.value;
    if (
      form.namespaceURI !== "http://www.w3.org/1999/xhtml" ||
      attribute(form, "method")?.toLowerCase() !== "post" ||
      new URL(attribute(form, "action") ?? "", sourceUrl).href !==
        (source === "entry" ? MAILBOX_CONNECT : MAILBOX_SSO) ||
      (attribute(form, "target") ?? "") !== ""
    )
      refuse();
    const expected = source === "entry" ? ["ePoboxFlag"] : SSO_FIELDS;
    const controls = elements.filter((element) =>
      ["input", "button", "select", "textarea"].includes(element.tagName),
    );
    if (controls.length !== expected.length) refuse();
    const fields = new URLSearchParams();
    for (const control of controls) {
      let parent: Node | null = control.parentNode;
      while (parent !== null && parent !== form)
        parent = "parentNode" in parent ? parent.parentNode : null;
      const name = attribute(control, "name");
      const value = attribute(control, "value");
      if (
        parent !== form ||
        control.tagName !== "input" ||
        control.namespaceURI !== "http://www.w3.org/1999/xhtml" ||
        attribute(control, "type")?.toLowerCase() !== "hidden" ||
        attribute(control, "disabled") !== undefined ||
        attribute(control, "form") !== undefined ||
        name === undefined ||
        !expected.includes(name) ||
        fields.has(name) ||
        value === undefined ||
        value.length === 0 ||
        value.length > 16384
      )
        refuse();
      fields.append(name, value);
    }
    return fields;
  } catch {
    refuse();
  }
}

function refuse(): never {
  throw new MailboxError("sbi_mailbox_handoff_unobserved");
}
