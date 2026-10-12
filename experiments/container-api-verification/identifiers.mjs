// Only fixed-width identifiers cross the persisted/control-plane boundary.
// Parse numeric digits and serialize from a closed alphabet, never arbitrary text.
const digits = "0123456789abcdef";
const invalid = () => {
  throw new Error("verification_identity");
};
export function canonicalHex(value, length) {
  if (
    ![32, 40, 64].includes(length) ||
    typeof value !== "string" ||
    value.length !== length ||
    !/^[a-f0-9]+$/u.test(value)
  )
    invalid();
  return Array.from(value, (digit) => digits[Number.parseInt(digit, 16)]).join("");
}
export function canonicalUuid(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value))
    invalid();
  const hex = canonicalHex(value.replaceAll("-", ""), 32);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20),
  ].join("-");
}
export function canonicalImageRef(value, account) {
  const prefix =
    "registry.cloudflare.com/" +
    canonicalHex(account, 32) +
    "/kogane-container-api-verification-verificationcontainer@sha256:";
  if (typeof value !== "string" || !value.startsWith(prefix)) invalid();
  return prefix + canonicalHex(value.slice(prefix.length), 64);
}
