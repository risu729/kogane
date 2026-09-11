/** Deterministic identity row keys: a prefix and a SHA-256 over the JSON of the parts. */
export async function identityKey(prefix: string, parts: unknown[]): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(parts)),
  );
  return `${prefix}_${Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")}`;
}
