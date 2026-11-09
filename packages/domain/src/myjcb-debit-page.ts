import type { StatementPageNode } from "./myjcb-statement-page.ts";

export const MYJCB_DEBIT_HEADERS = {
  ordinary: ["ご利用者", "お振替日", "ご利用先など", "お振替金額", "摘要", "承認番号"],
  difference: ["ご利用者", "差額発生日", "ご利用先など", "差額", "摘要", "お取引結果", "承認番号"],
} as const;

export interface MyJcbDebitRow {
  readonly section: "ordinary" | "difference";
  readonly cells: readonly string[];
  readonly locator: string;
}

/** Only the observed, explicit absence on the separate other-statement route. */
export function myJcbDebitOtherIsEmpty(document: StatementPageNode): boolean {
  const headings = descendants(document, "h1");
  const matches = headings.filter(
    (node) =>
      classes(node).includes("heading01-01") &&
      text(node).replace(/\s+/gu, "") === "選択された月のご請求はございません。",
  );
  return (
    headings.length === 1 && matches.length === 1 && descendants(document, "table").length === 0
  );
}

function text(node: StatementPageNode): string {
  return node.nodeName === "#text"
    ? (node.value ?? "")
    : (node.childNodes ?? []).map(text).join("");
}
function descendants(node: StatementPageNode, tag: string): StatementPageNode[] {
  return (node.childNodes ?? []).flatMap((child) => [
    ...(child.tagName === tag ? [child] : []),
    ...descendants(child, tag),
  ]);
}
function classes(node: StatementPageNode): string[] {
  return (node.attrs?.find((a) => a.name === "class")?.value ?? "").split(/\s+/u);
}
function fail(): never {
  throw new Error("myjcb_debit_page_unsupported");
}

export function myJcbDebitSelectedSequence(document: StatementPageNode): number {
  const selects = descendants(document, "select").filter((node) =>
    node.attrs?.some((a) => a.name === "name" && a.value === "seq"),
  );
  if (selects.length !== 1) fail();
  const selected = descendants(selects[0]!, "option").filter((node) =>
    node.attrs?.some((a) => a.name === "selected"),
  );
  const value =
    selected.length === 1 ? selected[0]!.attrs?.find((a) => a.name === "value")?.value : undefined;
  if (value === undefined || !/^(?:[0-9]|1[0-4])$/u.test(value)) fail();
  return Number(value);
}

/** Offered periods only: reject malformed/new sequence codes instead of skipping them. */
export function readMyJcbDebitMenu(
  document: StatementPageNode,
  kind: "ordinary" | "other",
): number[] {
  const selects = descendants(document, "select").filter((node) =>
    node.attrs?.some((a) => a.name === "name" && a.value === "seq"),
  );
  if (selects.length !== 1) fail();
  const sequences: number[] = [];
  for (const option of descendants(selects[0]!, "option")) {
    const value = option.attrs?.find((a) => a.name === "value")?.value;
    if (value === "") continue;
    if (
      value === undefined ||
      !/^(?:[1-9]|1[0-4])$/u.test(value) ||
      sequences.includes(Number(value))
    )
      fail();
    sequences.push(Number(value));
  }
  if (kind === "ordinary") {
    const latest = descendants(document, "a").filter((node) =>
      node.attrs?.some(
        (a) =>
          a.name === "href" && a.value === "/iss-pc/member/debit/details/debitDetail.html?seq=0",
      ),
    );
    if (latest.length !== 1) fail();
    sequences.push(0);
  }
  if (sequences.length === 0) fail();
  return sequences.sort((a, b) => a - b);
}

function validDate(value: string): boolean {
  if (!/^\d{4}\/\d{2}\/\d{2}$/u.test(value)) return false;
  const [year, month, day] = value.split("/").map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

function explicitEmpty(document: StatementPageNode): boolean {
  const selections = descendants(document, "select").filter((node) =>
    node.attrs?.some((a) => a.name === "name" && a.value === "seq"),
  );
  if (selections.length !== 1) return false;
  const selected = descendants(selections[0]!, "option").filter((node) =>
    node.attrs?.some((a) => a.name === "selected"),
  );
  if (selected.length !== 1) return false;
  const label = text(selected[0]!).replace(/\s+/gu, "");
  const markers = descendants(document, "p")
    .filter((node) => classes(node).includes("comment"))
    .map((node) =>
      /^\[(\d{4}年\d{1,2}月\d{1,2}日)～(\d{4}年\d{1,2}月\d{1,2}日分)\]のご利用代金明細はございません$/u.exec(
        text(node).replace(/\s+/gu, ""),
      ),
    )
    .filter((match) => match !== null);
  if (markers.length !== 1 || `${markers[0]![1]}～${markers[0]![2]}` !== label) return false;
  return [markers[0]![1]!, markers[0]![2]!.replace(/分$/u, "")].every((date) => {
    const parts = /^(\d{4})年(\d{1,2})月(\d{1,2})日$/u.exec(date)!;
    return validDate(`${parts[1]}/${parts[2]!.padStart(2, "0")}/${parts[3]!.padStart(2, "0")}`);
  });
}

/** Read only the observed desktop table; mobile markup duplicates its rows. */
export function readMyJcbDebitPage(document: StatementPageNode): readonly MyJcbDebitRow[] {
  const tables: StatementPageNode[] = [];
  function walk(node: StatementPageNode, desktop: boolean): void {
    if (classes(node).includes("sp-disp")) return;
    const pc = desktop || classes(node).includes("pc-disp");
    if (node.tagName === "table" && pc) tables.push(node);
    for (const child of node.childNodes ?? []) walk(child, pc);
  }
  walk(document, false);
  const rows: MyJcbDebitRow[] = [];
  const seen = new Set<string>();
  for (const [tableIndex, table] of tables.entries()) {
    const heads = descendants(table, "th").map((node) => text(node).replace(/\s+/gu, ""));
    const section = (Object.keys(MYJCB_DEBIT_HEADERS) as (keyof typeof MYJCB_DEBIT_HEADERS)[]).find(
      (key) => JSON.stringify(heads) === JSON.stringify(MYJCB_DEBIT_HEADERS[key]),
    );
    if (!section) {
      if (heads.some((head) => /承認番号|お振替金額|差額発生日/u.test(head))) fail();
      continue;
    }
    if (seen.has(section)) fail();
    seen.add(section);
    for (const [rowIndex, tr] of descendants(table, "tr").entries()) {
      const cells = (tr.childNodes ?? [])
        .filter((node) => node.tagName === "td")
        .map((node) => text(node).replace(/\s+/gu, " ").trim());
      if (cells.length === 0) continue;
      if (
        cells.length !== MYJCB_DEBIT_HEADERS[section].length ||
        cells.some((cell) => cell.length > 5000) ||
        !validDate(cells[1]!) ||
        !cells[2] ||
        !/^-?(?:\d+|\d{1,3}(?:,\d{3})+)$/u.test(cells[3]!) ||
        !cells.at(-1) ||
        (section === "difference" && cells[5] !== "銀行振替済")
      )
        fail();
      rows.push({ section, cells, locator: `html:pc-table[${tableIndex}]/tr[${rowIndex}]` });
    }
  }
  // Neither missing tables nor an unobserved empty representation proves zero.
  if (rows.length === 0 && explicitEmpty(document)) return [];
  if (seen.size === 0 || rows.length === 0 || explicitEmpty(document)) fail();
  return rows;
}
