/**
 * The table's own entry for a key from outside it (the server, the URL), or undefined.
 * Inherited object keys (`constructor`, `toString`, `__proto__`) are not
 * entries, so an unexpected code never reads as a built-in function or object.
 */
export function ownEntry<T>(table: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

/** Unknown source values stay visible; inherited object keys are not labels. */
export function displayLabel(labels: Readonly<Record<string, string>>, value: string): string {
  return ownEntry(labels, value) ?? value;
}
