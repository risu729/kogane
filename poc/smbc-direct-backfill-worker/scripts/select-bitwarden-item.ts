interface Item {
  id?: unknown;
  name?: unknown;
  login?: {
    username?: unknown;
    password?: unknown;
    uris?: Array<{ uri?: unknown }>;
  };
  fields?: Array<{ name?: unknown; value?: unknown }>;
}

const items = JSON.parse(await Bun.stdin.text()) as unknown;
if (!Array.isArray(items)) throw new Error("Bitwarden item list is invalid");
const candidates = items.filter(isSmbcDirectCandidate);
if (candidates.length !== 1) {
  const labels = candidates.map((item) => (typeof item.name === "string" ? item.name : "unnamed"));
  throw new Error(
    `Expected one SMBC Direct Bitwarden item, found ${candidates.length}: ${labels.join(", ")}`,
  );
}
const id = candidates[0]?.id;
if (typeof id !== "string" || !/^[0-9a-f-]{36}$/iu.test(id)) {
  throw new Error("SMBC Direct Bitwarden item ID is invalid");
}
process.stdout.write(id);

function isSmbcDirectCandidate(value: unknown): value is Item {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as Item;
  if (typeof item.login?.password !== "string" || item.login.password.length === 0) return false;
  if (typeof item.name !== "string" || !/^SMBC(?:\s*)ダイレクト$/iu.test(item.name.trim()))
    return false;
  const uris = (item.login.uris ?? []).flatMap((entry) =>
    typeof entry.uri === "string" ? [entry.uri] : [],
  );
  if (!uris.some((uri) => /^https:\/\/direct\.smbc\.co\.jp\//iu.test(uri))) return false;
  if (typeof item.login.username === "string" && /^\d+-\d+$/u.test(item.login.username.trim())) {
    return true;
  }
  const fields = Array.isArray(item.fields) ? item.fields : [];
  const names = fields.map((field) => (typeof field.name === "string" ? field.name.trim() : ""));
  const hasBranch = names.some((name) => /^(?:支店番号|店番号|branch(?: no)?)$/iu.test(name));
  const hasAccountField = names.some((name) => /^(?:口座番号|account(?: no)?)$/iu.test(name));
  const usernameIsAccount =
    typeof item.login.username === "string" && /^\d+$/u.test(item.login.username.trim());
  return hasBranch && (hasAccountField || usernameIsAccount);
}
