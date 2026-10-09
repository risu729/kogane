import { describe, expect, test } from "bun:test";
import { PAGE_SIZE, accountOptions, matchesSourceAccount, pageWindow } from "../src/filters.ts";

function numbered(length: number): { id: string }[] {
  return Array.from({ length }, (_, index) => ({ id: `row-${index}` }));
}

describe("account option identity", () => {
  test("repeated rows of one source and account collapse to one option", () => {
    const duplicate = { source_id: "src-a", source_account: "acct-1" };
    const other = { source_id: "src-a", source_account: "acct-2" };
    const options = accountOptions([duplicate, { ...duplicate }, other], "");
    const duplicateValue = JSON.stringify(["src-a", "acct-1"]);
    const otherValue = JSON.stringify(["src-a", "acct-2"]);

    expect(options).toHaveLength(2);
    expect(options).toContainEqual({ value: duplicateValue, label: "acct-1 · src-a" });
    expect(options).toContainEqual({ value: otherValue, label: "acct-2 · src-a" });
    expect(matchesSourceAccount(duplicate, { source: "", account: duplicateValue })).toBe(true);
    expect(matchesSourceAccount({ ...duplicate }, { source: "", account: duplicateValue })).toBe(
      true,
    );
    expect(matchesSourceAccount(other, { source: "", account: duplicateValue })).toBe(false);
  });

  test("an empty account keeps a distinct encoded option and placeholder label", () => {
    const empty = { source_id: "src-empty", source_account: "" };
    const named = { source_id: "src-empty", source_account: "named" };
    const options = accountOptions([empty, { ...empty }, named], "");
    const emptyValue = JSON.stringify(["src-empty", ""]);
    const namedValue = JSON.stringify(["src-empty", "named"]);

    expect(options).toHaveLength(2);
    expect(options).toContainEqual({ value: emptyValue, label: "口座名未記録 · src-empty" });
    expect(options).toContainEqual({ value: namedValue, label: "named · src-empty" });
    expect(matchesSourceAccount(empty, { source: "", account: emptyValue })).toBe(true);
    expect(matchesSourceAccount(named, { source: "", account: emptyValue })).toBe(false);
  });

  test("quotes and unicode stay inside the option value and label", () => {
    const quoted = { source_id: 'src-"q"', source_account: '名"前"\\径・α' };
    const unicode = { source_id: "src-uni", source_account: "β頁" };
    const options = accountOptions([quoted, unicode, { ...unicode }], "");
    const quoteValue = JSON.stringify([quoted.source_id, quoted.source_account]);
    const unicodeValue = JSON.stringify([unicode.source_id, unicode.source_account]);

    expect(options).toHaveLength(2);
    expect(options).toContainEqual({
      value: quoteValue,
      label: '名"前"\\径・α · src-"q"',
    });
    expect(options).toContainEqual({ value: unicodeValue, label: "β頁 · src-uni" });
    expect(matchesSourceAccount(quoted, { source: "", account: quoteValue })).toBe(true);
    expect(matchesSourceAccount(quoted, { source: "", account: quoted.source_account })).toBe(
      false,
    );
    expect(matchesSourceAccount(unicode, { source: "", account: quoteValue })).toBe(false);
    expect(matchesSourceAccount(unicode, { source: "", account: unicodeValue })).toBe(true);
  });

  test("reordering rows keeps the same option identities", () => {
    const rows = [
      { source_id: "src-b", source_account: "acct-b" },
      { source_id: "src-a", source_account: "acct-a" },
      { source_id: "src-a", source_account: "acct-c" },
      { source_id: "src-b", source_account: "acct-b" },
    ];
    const options = accountOptions(rows, "");

    expect(options).toHaveLength(3);
    expect(options).toContainEqual({
      value: JSON.stringify(["src-a", "acct-a"]),
      label: "acct-a · src-a",
    });
    expect(options).toContainEqual({
      value: JSON.stringify(["src-b", "acct-b"]),
      label: "acct-b · src-b",
    });
    expect(options).toContainEqual({
      value: JSON.stringify(["src-a", "acct-c"]),
      label: "acct-c · src-a",
    });
    expect(accountOptions([...rows].reverse(), "")).toEqual(options);

    const blank = { source_id: "src-tie", source_account: "" };
    const literal = { source_id: "src-tie", source_account: "口座名未記録" };
    const tiedValues = [
      JSON.stringify(["src-tie", ""]),
      JSON.stringify(["src-tie", "口座名未記録"]),
    ].sort();
    for (const input of [
      [blank, literal],
      [literal, blank],
    ]) {
      const tied = accountOptions(input, "");
      expect(tied).toHaveLength(2);
      expect(tied.map((option) => option.label)).toEqual([
        "口座名未記録 · src-tie",
        "口座名未記録 · src-tie",
      ]);
      expect(tied.map((option) => option.value).sort()).toEqual(tiedValues);
    }
  });
});

describe("page windows at the recorded page size", () => {
  test("lengths 50, 51, and 100 clamp a stale page onto the last real page", () => {
    expect(PAGE_SIZE).toBe(50);

    const expectSlice = (
      length: number,
      requested: number,
      startIndex: number,
      count: number,
      page: number,
      pages: number,
    ) => {
      const input = numbered(length);
      const view = pageWindow(input, requested);
      expect(view).toMatchObject({
        page,
        pages,
        start: startIndex + 1,
        end: startIndex + count,
      });
      expect(view.rows.map((row) => row.id)).toEqual(
        Array.from({ length: count }, (_, index) => `row-${String(startIndex + index)}`),
      );
      expect(view.rows[0]).toBe(input[startIndex]);
      expect(input).toHaveLength(length);
    };

    expectSlice(50, 0, 0, 50, 0, 1);
    expectSlice(50, 4, 0, 50, 0, 1);
    expectSlice(51, 0, 0, 50, 0, 2);
    expectSlice(51, 1, 50, 1, 1, 2);
    expectSlice(51, 4, 50, 1, 1, 2);
    expectSlice(100, 0, 0, 50, 0, 2);
    expectSlice(100, 1, 50, 50, 1, 2);
    expectSlice(100, 4, 50, 50, 1, 2);
  });
});
