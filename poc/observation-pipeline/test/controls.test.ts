import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RecordControls } from "../web/src/pages/ViewControls.tsx";
import {
  EMPTY_FILTERS,
  type RecordFilters,
  type SourceAccount,
} from "../web/src/filters.ts";

function selectedLabels(
  rows: SourceAccount[],
  filters: RecordFilters,
): string[] {
  const markup = renderToStaticMarkup(
    createElement(RecordControls, {
      rows,
      filters,
      onChange: () => {
        throw new Error("render must not clear selection");
      },
    }),
  );
  return [
    ...markup.matchAll(/<option[^>]*selected=""[^>]*>(.*?)<\/option>/gu),
  ].map((match) => match[1]!);
}

test("a source and account absent after refresh stay visibly selected", () => {
  const filters = {
    ...EMPTY_FILTERS,
    source: "source-A",
    account: JSON.stringify(["source-A", "account-A"]),
  };
  expect(
    selectedLabels(
      [{ source_id: "source-B", source_account: "account-B" }],
      filters,
    ),
  ).toEqual([
    "source-A（今回の記録に含まれません）",
    "account-A · source-A（今回の記録に含まれません）",
  ]);
  expect(selectedLabels([], filters)).toEqual([
    "source-A（今回の記録に含まれません）",
    "account-A · source-A（今回の記録に含まれません）",
  ]);
});

test("an absent account remains distinct from all accounts and recovers when rows return", () => {
  const filters = {
    ...EMPTY_FILTERS,
    source: "source-A",
    account: JSON.stringify(["source-A", ""]),
  };
  expect(
    selectedLabels(
      [{ source_id: "source-A", source_account: "account-B" }],
      filters,
    ),
  ).toEqual([
    "source-A",
    "口座名未記録 · source-A（今回の記録に含まれません）",
  ]);
  expect(
    selectedLabels([{ source_id: "source-A", source_account: "" }], filters),
  ).toEqual(["source-A", "口座名未記録 · source-A"]);
  expect(selectedLabels([], EMPTY_FILTERS)).toEqual([
    "すべての取得元",
    "すべての口座",
  ]);
});
