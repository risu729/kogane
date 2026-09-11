import type { DateRange } from "./types";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export function validateDate(value: string, name: string): string {
  if (!DATE_PATTERN.test(value)) throw new Error(`${name}_invalid`);
  const [yearText, monthText, dayText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error(`${name}_invalid`);
  }
  return value;
}
export function compactDate(value: string): string {
  return validateDate(value, "date").replaceAll("-", "");
}

export function japanToday(now = new Date()): string {
  return new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function monthRanges(from: string, to: string): DateRange[] {
  const first = validateDate(from, "from");
  const last = validateDate(to, "to");
  if (first > last) throw new Error("date_range_invalid");

  const ranges: DateRange[] = [];
  let cursor = first;
  while (cursor <= last) {
    const [yearText, monthText] = cursor.split("-");
    const year = Number(yearText);
    const month = Number(monthText);
    const nextMonth = new Date(Date.UTC(year, month, 1));
    const monthEnd = new Date(nextMonth.getTime() - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const end = monthEnd < last ? monthEnd : last;
    ranges.push({ start: cursor, end });
    cursor = nextMonth.toISOString().slice(0, 10);
  }
  return ranges;
}
