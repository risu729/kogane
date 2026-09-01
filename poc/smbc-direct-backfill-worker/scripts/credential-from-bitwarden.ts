interface BitwardenField {
  name?: unknown;
  value?: unknown;
}

interface BitwardenItem {
  login?: { username?: unknown; password?: unknown };
  fields?: BitwardenField[];
}

const input = await Bun.stdin.text();
const item = JSON.parse(input) as BitwardenItem;
const password = item.login?.password;
if (typeof password !== "string" || password.length === 0) {
  throw new Error("Bitwarden item does not contain a login password");
}

let user = typeof item.login?.username === "string" ? item.login.username.trim() : "";
if (!/^\d+-\d+$/u.test(user)) {
  const fields = Array.isArray(item.fields) ? item.fields : [];
  const branch = fieldValue(fields, /^(支店番号|店番号|branch(?: no)?)$/iu);
  const account = /^\d+$/u.test(user)
    ? user
    : fieldValue(fields, /^(口座番号|account(?: no)?)$/iu);
  if (!branch || !account) {
    throw new Error("Bitwarden item does not contain <branch>-<account> or matching custom fields");
  }
  user = `${branch}-${account}`;
}

process.stdout.write(JSON.stringify({ user, password }));

function fieldValue(fields: BitwardenField[], pattern: RegExp): string | null {
  for (const field of fields) {
    if (typeof field.name !== "string" || !pattern.test(field.name.trim())) continue;
    if (typeof field.value === "string" && /^\d+$/u.test(field.value.trim())) return field.value.trim();
  }
  return null;
}
