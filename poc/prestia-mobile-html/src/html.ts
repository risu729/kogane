import * as cheerio from "cheerio";

export type FormState = {
  name: string;
  action: string;
  method: string;
  fields: Array<[name: string, value: string]>;
};

export type SafeHtmlSummary = {
  bytes: number;
  forms: string[];
  accessDenied: boolean;
  loginFormPresent: boolean;
  otpFormPresent: boolean;
  homeFormPresent: boolean;
  hashedCifPresent: boolean;
  accountRowCount: number;
  errorBlockPresent: boolean;
  errorCodes: string[];
};

export function decodeHtml(bytes: Uint8Array): string {
  for (const label of ["utf-8", "shift_jis"] as const) {
    try {
      return new TextDecoder(label, { fatal: true }).decode(bytes);
    } catch {
      // Try the next encoding.
    }
  }
  return new TextDecoder("utf-8").decode(bytes);
}

export function extractForms(html: string): FormState[] {
  const $ = cheerio.load(html);
  return $("form")
    .toArray()
    .map((element) => {
      const form = $(element);
      const fields: Array<[string, string]> = [];
      form.find("input, select, textarea").each((_index, fieldElement) => {
        const field = $(fieldElement);
        const name = field.attr("name");
        if (!name || field.attr("disabled") !== undefined) return;
        const type = (field.attr("type") ?? "").toLowerCase();
        if (["button", "file", "image", "reset", "submit"].includes(type)) return;
        if ((type === "checkbox" || type === "radio") && field.attr("checked") === undefined) {
          return;
        }
        const value = field.val();
        if (Array.isArray(value)) {
          for (const item of value) fields.push([name, item]);
        } else {
          fields.push([name, value?.toString() ?? ""]);
        }
      });
      return {
        name: form.attr("name") ?? form.attr("id") ?? "",
        action: form.attr("action") ?? "",
        method: (form.attr("method") ?? "get").toLowerCase(),
        fields,
      };
    });
}

export function findForm(html: string, name: string): FormState | undefined {
  return extractForms(html).find((form) => form.name === name);
}

export function summarizeHtml(bytes: Uint8Array): SafeHtmlSummary {
  const html = decodeHtml(bytes);
  const $ = cheerio.load(html);
  const forms = extractForms(html).map((form) => form.name).filter(Boolean);
  const errorCodes = [...new Set(html.match(/\b(?:AE|AO)\d{3}\b/g) ?? [])].sort();
  const errorBlockPresent = $("#errorMsgArea, #dispErrorMsgArea")
    .toArray()
    .some((element) => $(element).text().trim().length > 0 || $(element).find("a, img").length > 0);
  return {
    bytes: bytes.byteLength,
    forms,
    accessDenied: /Access Denied|Reference #\d+\./i.test(html),
    loginFormPresent: forms.includes("POSNIN1"),
    otpFormPresent: forms.some((name) => name.startsWith("AUOTIN1")),
    homeFormPresent: forms.includes("POMHTOP"),
    hashedCifPresent: $("input[name='hashedCIF']").length > 0 || /\bhashedCIF\b/.test(html),
    accountRowCount: $(".mc_cardTbl_row, [data-account-index]").length,
    errorBlockPresent,
    errorCodes,
  };
}
