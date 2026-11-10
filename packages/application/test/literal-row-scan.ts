/** SQLite describes a VALUES list as CONSTANT ROW(S) or a zero-row VALUES
 * clause. These rows are SQL literals, not a relation that grows with data. */
export function isLiteralRowsScan(detail: string): boolean {
  return /^SCAN (?:CONSTANT ROW|[0-9]+ CONSTANT ROWS|[0-9]+-ROW VALUES CLAUSE)$/u.test(detail);
}
