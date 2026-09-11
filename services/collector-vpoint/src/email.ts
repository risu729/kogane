import PostalMime from "postal-mime";

export const VPOINT_EMAIL_SUBJECT = "Vポイントサイト認証コードのお知らせ";

export function isCollectorRecipient(recipient: string, configuredRecipients: string[]): boolean {
  const normalizedRecipient = recipient.trim().toLowerCase();
  return configuredRecipients.some(
    (configured) => normalizedRecipient === configured.trim().toLowerCase(),
  );
}

export async function extractVPointEmailCode(
  raw: ArrayBuffer | Uint8Array,
): Promise<string | null> {
  const email = await PostalMime.parse(raw);
  if (email.subject !== VPOINT_EMAIL_SUBJECT || !email.text) return null;
  const preamble = email.text.split(/-{10,}/u, 1)[0] ?? "";
  const candidates = [...new Set(preamble.match(/(?<![0-9])[0-9]{4,6}(?![0-9])/gu) ?? [])];
  return candidates.length === 1 ? (candidates[0] ?? null) : null;
}
