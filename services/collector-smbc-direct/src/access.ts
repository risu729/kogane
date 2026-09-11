export function accessJwtSubject(assertion: string | null): string | null {
  if (!assertion || assertion.length > 32 * 1024) return null;
  const parts = assertion.split(".");
  if (parts.length !== 3 || !parts[1]) return null;
  try {
    const base64 = parts[1]
      .replaceAll("-", "+")
      .replaceAll("_", "/")
      .padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
    const payload = JSON.parse(atob(base64)) as { sub?: unknown };
    return typeof payload.sub === "string" && payload.sub.length > 0 && payload.sub.length <= 512
      ? payload.sub
      : null;
  } catch {
    return null;
  }
}
