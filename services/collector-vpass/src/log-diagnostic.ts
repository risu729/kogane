/** Receives only already-redacted collector records. This is not a sanitizer. */
export function logVpassDiagnostic(record: Record<string, unknown>): void {
  try {
    console.log(JSON.stringify(record));
  } catch {
    /* Logging cannot change the result or cause another provider/storage attempt. */
  }
}
