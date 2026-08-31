interface CliOptions {
  readonly itemId: string;
  readonly connectionId: string;
  readonly secretName: string;
  readonly put: boolean;
}

export {};

const options = parseArgs(Bun.argv.slice(2));
if (!process.env.BW_SESSION) {
  throw new Error("BW_SESSION is required; unlock Bitwarden in this terminal first");
}

const bw = process.env.BW_BIN ?? "bw";
const itemProcess = Bun.spawn([
  bw,
  "get",
  "item",
  options.itemId,
  "--session",
  process.env.BW_SESSION,
], {
  stdout: "pipe",
  stderr: "inherit",
  stdin: "inherit",
  env: process.env,
});
const [itemOutput, itemExit] = await Promise.all([
  new Response(itemProcess.stdout).text(),
  itemProcess.exited,
]);
if (itemExit !== 0) {
  throw new Error("Bitwarden item read failed");
}

const item: unknown = JSON.parse(itemOutput);
const passkey = extractSinglePasskey(item);
const payload = JSON.stringify({
  connectionId: options.connectionId,
  bootstrapMode: "passkey",
  credentialId: requiredString(passkey, "credentialId"),
  privateKey: requiredString(passkey, "keyValue"),
  rpId: requiredString(passkey, "rpId"),
  userHandle: requiredString(passkey, "userHandle"),
  counter: parseCounter(passkey.counter),
  discoverable: parseDiscoverable(passkey.discoverable),
  ...optionalString(passkey, "userName"),
  ...optionalString(passkey, "userDisplayName"),
});

const parsedPayload = JSON.parse(payload) as Record<string, unknown>;
if (parsedPayload.counter !== 0) {
  throw new Error("Only Bitwarden passkeys with counter=0 can be synced safely");
}
if (parsedPayload.discoverable !== true) {
  throw new Error("MyJCB passwordless login requires a discoverable passkey");
}
if (parsedPayload.rpId !== "my.jcb.co.jp" && parsedPayload.rpId !== "jcb.co.jp") {
  throw new Error("The selected Bitwarden passkey has an unexpected RP ID");
}

if (!options.put) {
  console.log(JSON.stringify({
    ok: true,
    connectionId: options.connectionId,
    secretName: options.secretName,
    rpId: parsedPayload.rpId,
    counter: parsedPayload.counter,
    discoverable: parsedPayload.discoverable,
    bytes: new TextEncoder().encode(payload).byteLength,
    written: false,
  }));
  process.exit(0);
}

const wrangler = Bun.spawn(["bunx", "wrangler", "secret", "put", options.secretName], {
  stdin: new Blob([payload]),
  stdout: "inherit",
  stderr: "inherit",
  env: process.env,
});
const wranglerExit = await wrangler.exited;
if (wranglerExit !== 0) throw new Error("wrangler secret put failed");
console.log(JSON.stringify({
  ok: true,
  connectionId: options.connectionId,
  secretName: options.secretName,
  bytes: new TextEncoder().encode(payload).byteLength,
  written: true,
}));

function parseArgs(args: readonly string[]): CliOptions {
  const values = new Map<string, string>();
  let put = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--put") {
      put = true;
      continue;
    }
    if (!arg?.startsWith("--")) throw new Error("Unexpected positional argument");
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for ${arg}`);
    values.set(arg, value);
    index += 1;
  }
  const itemId = values.get("--item-id");
  const connectionId = values.get("--connection-id");
  const secretName = values.get("--secret-name");
  if (!itemId || !/^[0-9a-f-]{36}$/iu.test(itemId)) throw new Error("--item-id is required");
  if (!connectionId || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(connectionId)) {
    throw new Error("--connection-id is required and must be pseudonymous");
  }
  if (!secretName || !/^MYJCB_ACCOUNT_[A-Z0-9_]{1,48}_JSON$/u.test(secretName)) {
    throw new Error("--secret-name must match MYJCB_ACCOUNT_<NAME>_JSON");
  }
  return { itemId, connectionId, secretName, put };
}

function extractSinglePasskey(item: unknown): Record<string, unknown> {
  if (!isRecord(item) || !isRecord(item.login)) throw new Error("Bitwarden item is not a login");
  const credentials = item.login.fido2Credentials;
  if (!Array.isArray(credentials) || credentials.length !== 1 || !isRecord(credentials[0])) {
    throw new Error("Bitwarden item must contain exactly one passkey");
  }
  return credentials[0];
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || field === "") throw new Error(`Passkey ${key} is missing`);
  return field;
}

function optionalString(
  value: Record<string, unknown>,
  key: "userName" | "userDisplayName",
): Partial<Record<typeof key, string>> {
  const field = value[key];
  return typeof field === "string" && field !== "" ? { [key]: field } : {};
}

function parseCounter(value: unknown): number {
  const counter = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isSafeInteger(counter) || counter < 0) throw new Error("Passkey counter is invalid");
  return counter;
}

function parseDiscoverable(value: unknown): boolean {
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new Error("Passkey discoverable flag is invalid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
