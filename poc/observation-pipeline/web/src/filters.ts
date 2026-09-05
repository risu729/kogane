export interface SourceAccount {
  source_id: string;
  source_account: string;
}
export interface RecordFilters {
  source: string;
  account: string;
  from: string;
  to: string;
}
export const EMPTY_FILTERS: RecordFilters = {
  source: "",
  account: "",
  from: "",
  to: "",
};
export const PAGE_SIZE = 50;
// Compare the recorded calendar date, without browser timezone conversion.
export function recordedDate(value: string | null): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T| )/u.exec(value);
  if (!match) return null;
  const year = Number(match[1]),
    month = Number(match[2]),
    day = Number(match[3]);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > (days[month - 1] ?? 0)) return null;
  return value.slice(0, 10);
}
export function matchesSourceAccount(
  row: SourceAccount,
  filters: Pick<RecordFilters, "source" | "account">,
): boolean {
  return (
    (!filters.source || row.source_id === filters.source) &&
    (!filters.account || JSON.stringify([row.source_id, row.source_account]) === filters.account)
  );
}
export function matchesDates(value: string | null, from: string, to: string): boolean {
  if (!from && !to) return true;
  const date = recordedDate(value);
  return date !== null && (!from || date >= from) && (!to || date <= to);
}
export function sourceOptions(rows: readonly SourceAccount[]): string[] {
  return [...new Set(rows.map((row) => row.source_id))].sort();
}
export function accountOptions(
  rows: readonly SourceAccount[],
  source: string,
): { value: string; label: string }[] {
  const values = new Map<string, string>();
  for (const row of rows) {
    if (source && row.source_id !== source) continue;
    values.set(
      JSON.stringify([row.source_id, row.source_account]),
      `${row.source_account || "口座名未記録"} · ${row.source_id}`,
    );
  }
  return [...values]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label));
}
export function pageWindow<T>(rows: readonly T[], requested: number) {
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const page = Math.min(Math.max(0, requested), pages - 1);
  return {
    page,
    pages,
    rows: rows.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE),
    start: rows.length ? page * PAGE_SIZE + 1 : 0,
    end: Math.min(rows.length, (page + 1) * PAGE_SIZE),
  };
}
