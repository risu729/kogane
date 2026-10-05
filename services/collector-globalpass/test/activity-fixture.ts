// The collector's synthetic Account Activities page in the two reviewed
// sanitizer variants (A: six forms, the download action, six dynamic inputs;
// B: five forms, four). Synthetic data only: every value is a placeholder.
// sanitize.test.ts checks the sanitizer on it, and
// packages/parsers/test/global-pass-sanitized-contract.test.ts puts the
// activity parser's synthetic statement into it.

export function fixture(variant: "a" | "b"): string {
  const dynamic =
    variant === "a"
      ? ["opaque-1", "opaque-2", "opaque-3", "opaque-4", "", ""]
      : ["opaque-1", "opaque-2", "opaque-3", ""];
  const submits = Array.from(
    { length: variant === "a" ? 6 : 4 },
    () => '<input type="hidden" name="nablarch_submit" value="1">',
  ).join("");
  const forms = Array.from({ length: variant === "a" ? 6 : 5 }, (_, index) => {
    const action =
      variant === "a" && index === 0
        ? ' action="https://www.debit.vpass.ne.jp/p/statementInquiry/RW1313010301"'
        : "";
    return `<form${action}></form>`;
  }).join("");
  return (
    "<!DOCTYPE html><html><head>" +
    '<link rel="stylesheet" href="/en//01006/css/master.css">' +
    '<script src="/js/run.js"></script></head><body><h1>ご利用明細</h1>' +
    '<a href="#activity" onclick="click()">明細</a>' +
    '<select onchange="sel_submit(this)"></select>' +
    '<input type="hidden" name="cc" value="01006">' +
    '<input type="hidden" name="engUseFlg" value="0">' +
    '<input type="hidden" name="nablarch_needs_hidden_encryption" value="1">' +
    dynamic
      .map(
        (value, index) =>
          `<input type="hidden" name="nablarch_hidden" value="${value}" data-index="${index}">`,
      )
      .join("") +
    submits +
    (variant === "a" ? '<input type="hidden" name="W131301.referenceDate" value="2099-01">' : "") +
    forms +
    "</body></html>"
  );
}
