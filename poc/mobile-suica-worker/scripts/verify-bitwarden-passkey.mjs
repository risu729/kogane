import { loadBitwardenCredential, verifyLocalCredential } from "./lib/bitwarden-passkey.mjs";

const credential = loadBitwardenCredential("id.jreast.co.jp");
const result = verifyLocalCredential(credential);
if (!result.verified) throw new Error("generated WebAuthn assertion did not verify");
console.log(
  JSON.stringify(
    {
      ok: true,
      rpId: credential.rpId,
      algorithm: "ES256",
      credentialIdBytes: result.credentialIdBytes,
      authenticatorDataBytes: result.authenticatorDataBytes,
      flags: `0x${result.flags.toString(16).padStart(2, "0")}`,
      signCount: result.counter,
    },
    null,
    2,
  ),
);
