import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { displayLabel } from "../src/labels.ts";
import { StatusBadge, TransactionStatus } from "../src/ui.tsx";

test("prototype-shaped source values render as their original text", () => {
  const labels = { success: "成功" };
  for (const value of ["__proto__", "constructor", "toString"]) {
    expect(displayLabel(labels, value)).toBe(value);
    const markup = renderToStaticMarkup(createElement(StatusBadge, { status: value }));
    expect(markup).toContain(`>${value}</span>`);
    expect(markup).not.toContain("badge-ok");
  }
  expect(displayLabel(labels, "success")).toBe("成功");
  expect(renderToStaticMarkup(createElement(StatusBadge, { status: "success" }))).toContain("成功");
});

test("own labels take precedence and unknown markup-shaped values remain escaped", () => {
  const labels = JSON.parse('{"__proto__":"明示したラベル"}') as Record<string, string>;
  expect(displayLabel(labels, "__proto__")).toBe("明示したラベル");
  const value = "<script>privateSourceValue</script>";
  const markup = renderToStaticMarkup(createElement(StatusBadge, { status: value }));
  expect(markup).toContain("&lt;script&gt;privateSourceValue&lt;/script&gt;");
  expect(markup).not.toContain("<script>");
});

test("transaction state separates unconfirmed, absent and provider unknown values", () => {
  const render = (status: string | null | undefined) =>
    renderToStaticMarkup(createElement(TransactionStatus, { status }));
  expect(render("unconfirmed")).toContain(">未確定</span>");
  expect(render("confirmed")).toContain(">確定</span>");
  expect(render("posted")).toContain(">履歴に記録</span>");
  expect(render("declined")).toContain(">利用拒否</span>");
  expect(render("notified")).toContain(">利用通知</span>");
  expect(render("unknown")).toContain(">状態不明</span>");
  for (const value of [null, undefined, ""])
    expect(render(value)).toContain(">状態情報なし</span>");
  for (const value of ["future_state", "__proto__", "constructor"])
    expect(render(value)).toContain(`>${value}</span>`);
  expect(render("<script>unsafe</script>")).not.toContain("<script>");
});
