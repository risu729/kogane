import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { displayLabel } from "../web/src/labels.ts";
import { StatusBadge } from "../web/src/ui.tsx";

test("prototype-shaped source values render as their original text", () => {
  const labels = { success: "成功" };
  for (const value of ["__proto__", "constructor", "toString"]) {
    expect(displayLabel(labels, value)).toBe(value);
    const markup = renderToStaticMarkup(
      createElement(StatusBadge, { status: value }),
    );
    expect(markup).toContain(`>${value}</span>`);
    expect(markup).not.toContain("badge-ok");
  }
  expect(displayLabel(labels, "success")).toBe("成功");
  expect(
    renderToStaticMarkup(createElement(StatusBadge, { status: "success" })),
  ).toContain("成功");
});

test("own labels take precedence and unknown markup-shaped values remain escaped", () => {
  const labels = JSON.parse('{"__proto__":"明示したラベル"}') as Record<
    string,
    string
  >;
  expect(displayLabel(labels, "__proto__")).toBe("明示したラベル");
  const value = "<script>privateSourceValue</script>";
  const markup = renderToStaticMarkup(
    createElement(StatusBadge, { status: value }),
  );
  expect(markup).toContain("&lt;script&gt;privateSourceValue&lt;/script&gt;");
  expect(markup).not.toContain("<script>");
});
