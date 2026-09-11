/** Only collector-generated UUIDs may cross the relay logging boundary. */
export function logEvent(level: "log" | "warn" | "error", serializedRecord: string): void {
  try {
    console[level](serializedRecord);
  } catch {
    /* Logging must not change collection or teardown. */
  }
}

export function relayRunId(url: URL): string | undefined {
  const value = url.searchParams.get("runId");
  return value &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)
    ? value
    : undefined;
}

export function withRunId(relayUrl: string, runId: string): string {
  const url = new URL(relayUrl);
  url.searchParams.set("runId", runId);
  return url.toString();
}
