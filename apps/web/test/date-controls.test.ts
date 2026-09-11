import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RecordControls } from "../src/pages/ViewControls.tsx";
import { EMPTY_FILTERS } from "../src/filters.ts";

function renderDates(from: string, to: string): string {
  return renderToStaticMarkup(
    createElement(RecordControls, {
      rows: [],
      filters: { ...EMPTY_FILTERS, from, to },
      dates: true,
      onChange: () => {},
    }),
  );
}

test("reversed date ranges associate both invalid fields with an actionable error", () => {
  const markup = renderDates("2026-09-07", "2026-09-01");
  const errorId = /<p id="([^"]+)" role="alert">開始日を終了日以前にしてください。<\/p>/u.exec(
    markup,
  )?.[1];
  expect(errorId).toBeDefined();
  const fields = [...markup.matchAll(/<input[^>]+>/gu)].map((match) => match[0]);
  expect(fields).toHaveLength(2);
  for (const field of fields) {
    expect(field).toContain('aria-invalid="true"');
    expect(field).toContain(`aria-describedby="${errorId}"`);
  }
});

test("same-day and open-ended ranges do not announce errors", () => {
  for (const [from, to] of [
    ["2026-09-07", "2026-09-07"],
    ["", "2026-09-07"],
    ["2026-09-07", ""],
    ["", ""],
  ]) {
    const markup = renderDates(from!, to!);
    expect(markup).not.toContain('role="alert"');
    expect(markup).not.toContain("aria-invalid");
    expect(markup).not.toContain("aria-describedby");
  }
});
