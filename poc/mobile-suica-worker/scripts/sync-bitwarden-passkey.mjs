import { spawnSync } from "node:child_process";
import { credentialEnvelope, loadBitwardenCredential } from "./lib/bitwarden-passkey.mjs";

const credential = loadBitwardenCredential("id.jreast.co.jp");
const secret = `${JSON.stringify(credentialEnvelope(credential))}\n`;
const result = spawnSync("bunx", ["wrangler", "secret", "put", "JRE_ID_CREDENTIAL_JSON"], {
  cwd: new URL("..", import.meta.url),
  input: secret,
  encoding: "utf8",
  env: process.env,
});
if (result.status !== 0) {
  if (result.stderr) process.stderr.write(result.stderr);
  throw new Error(`wrangler secret put failed (${result.status ?? "signal"})`);
}
console.log("JRE ID credential synced from the unlocked local Bitwarden vault.");
