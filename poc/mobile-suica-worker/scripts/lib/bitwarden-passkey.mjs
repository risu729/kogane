import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
} from "node:crypto";
import { spawnSync } from "node:child_process";

export function loadBitwardenCredential(rpId) {
  if (!process.env.BW_SESSION) {
    throw new Error("BW_SESSION is required; run this only in an unlocked local WSL shell");
  }
  const result = spawnSync("bw", ["list", "items", "--search", "JRE"], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`bw list items failed (${result.status ?? "signal"})`);
  }
  const items = JSON.parse(result.stdout);
  const matches = items.flatMap((item) =>
    (item.login?.fido2Credentials ?? [])
      .filter((credential) => credential.rpId === rpId)
      .map((credential) => ({ item, credential })),
  );
  if (matches.length !== 1) {
    throw new Error(`expected exactly one Bitwarden passkey for ${rpId}; found ${matches.length}`);
  }
  const [{ item, credential }] = matches;
  if (!item.login?.username) throw new Error("matching Bitwarden item has no username");
  validateCredential(credential);
  return {
    username: item.login.username,
    rpId: credential.rpId,
    credentialId: credential.credentialId,
    userHandle: credential.userHandle ?? "",
    counter: Number.parseInt(credential.counter ?? "0", 10) || 0,
    privateKeyPkcs8Base64Url: credential.keyValue.replace(/=+$/u, ""),
  };
}

export function credentialEnvelope(credential) {
  return {
    schemaVersion: "jre-id-bitwarden-passkey-v1",
    syncedAt: new Date().toISOString(),
    ...credential,
  };
}

export function createAssertion(credential, challenge) {
  const clientDataJSON = Buffer.from(JSON.stringify({
    type: "webauthn.get",
    challenge,
    origin: "https://id.jreast.co.jp",
    crossOrigin: false,
  }));
  const authenticatorData = Buffer.concat([
    createHash("sha256").update(credential.rpId).digest(),
    Buffer.from([0x1d]),
    uint32be(credential.counter),
  ]);
  const signedData = Buffer.concat([
    authenticatorData,
    createHash("sha256").update(clientDataJSON).digest(),
  ]);
  const privateKey = createPrivateKey({
    key: Buffer.from(credential.privateKeyPkcs8Base64Url, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  const rawId = credentialIdBytes(credential.credentialId).toString("base64url");
  return {
    assertion: {
      id: rawId,
      rawId,
      response: {
        authenticatorData: authenticatorData.toString("base64url"),
        clientDataJSON: clientDataJSON.toString("base64url"),
        signature: sign("sha256", signedData, privateKey).toString("base64url"),
        userHandle: credential.userHandle
          ? Buffer.from(credential.userHandle.replace(/=+$/u, ""), "base64url").toString("base64url")
          : "",
      },
    },
    privateKey,
    signedData,
  };
}

export function verifyLocalCredential(credential) {
  const challenge = randomBytes(32).toString("base64url");
  const { assertion, privateKey, signedData } = createAssertion(credential, challenge);
  const signature = Buffer.from(assertion.response.signature, "base64url");
  return {
    verified: verify("sha256", signedData, createPublicKey(privateKey), signature),
    credentialIdBytes: Buffer.from(assertion.rawId, "base64url").byteLength,
    authenticatorDataBytes: Buffer.from(
      assertion.response.authenticatorData,
      "base64url",
    ).byteLength,
    flags: Buffer.from(assertion.response.authenticatorData, "base64url")[32],
    counter: credential.counter,
  };
}

function validateCredential(credential) {
  if (credential.keyAlgorithm !== "ECDSA" || credential.keyCurve !== "P-256") {
    throw new Error("JRE ID passkey must be ECDSA P-256");
  }
  if (credential.keyType !== "public-key") throw new Error("JRE ID credential is not public-key");
  if (!credential.keyValue) throw new Error("Bitwarden did not return the passkey private key");
  credentialIdBytes(credential.credentialId);
}

function credentialIdBytes(value) {
  if (value.startsWith("b64.")) return Buffer.from(value.slice(4), "base64url");
  const hex = value.replaceAll("-", "");
  if (/^[0-9a-f]{32}$/iu.test(hex)) return Buffer.from(hex, "hex");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength === 0) throw new Error("invalid Bitwarden credential ID");
  return decoded;
}

function uint32be(value) {
  const output = Buffer.alloc(4);
  output.writeUInt32BE(value >>> 0);
  return output;
}
