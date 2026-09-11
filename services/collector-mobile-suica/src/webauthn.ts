import {
  createHash,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign,
  verify,
} from "node:crypto";

export interface StoredJreCredential {
  schemaVersion: "jre-id-bitwarden-passkey-v1";
  syncedAt: string;
  username: string;
  rpId: "id.jreast.co.jp";
  credentialId: string;
  userHandle: string;
  counter: number;
  privateKeyPkcs8Base64Url: string;
}

export interface JreAssertion {
  id: string;
  rawId: string;
  response: {
    authenticatorData: string;
    clientDataJSON: string;
    signature: string;
    userHandle: string;
  };
}

export function parseStoredJreCredential(input: string): StoredJreCredential {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    throw new Error("JRE ID credential secret is not valid JSON");
  }
  if (!isRecord(value)) throw new Error("JRE ID credential secret must be an object");
  if (value.schemaVersion !== "jre-id-bitwarden-passkey-v1") {
    throw new Error("JRE ID credential secret has an unsupported schema version");
  }
  const rpId = requiredString(value.rpId, "rpId");
  if (rpId !== "id.jreast.co.jp") throw new Error("JRE ID credential has an unexpected RP ID");
  const counter = typeof value.counter === "number" ? value.counter : Number.NaN;
  if (!Number.isSafeInteger(counter) || counter < 0 || counter > 0xffff_ffff) {
    throw new Error("JRE ID credential counter is invalid");
  }
  const credential: StoredJreCredential = {
    schemaVersion: value.schemaVersion,
    syncedAt: requiredString(value.syncedAt, "syncedAt"),
    username: requiredString(value.username, "username"),
    rpId,
    credentialId: requiredString(value.credentialId, "credentialId"),
    userHandle: typeof value.userHandle === "string" ? value.userHandle : "",
    counter,
    privateKeyPkcs8Base64Url: requiredString(
      value.privateKeyPkcs8Base64Url,
      "privateKeyPkcs8Base64Url",
    ),
  };
  const privateKey = createPrivateKey({
    key: Buffer.from(credential.privateKeyPkcs8Base64Url, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  if (
    privateKey.asymmetricKeyType !== "ec" ||
    privateKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) {
    throw new Error("JRE ID credential private key is not P-256");
  }
  credentialIdBytes(credential.credentialId);
  return credential;
}

export function createJreAssertion(
  credential: StoredJreCredential,
  challenge: string,
): JreAssertion {
  if (!challenge || Buffer.from(challenge, "base64url").byteLength === 0) {
    throw new Error("JRE ID WebAuthn challenge is invalid");
  }
  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: "webauthn.get",
      challenge,
      origin: "https://id.jreast.co.jp",
      crossOrigin: false,
    }),
  );
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
  };
}

export function checkStoredJreCredential(credential: StoredJreCredential): {
  verified: boolean;
  credentialIdBytes: number;
  authenticatorDataBytes: number;
  flags: string;
  signCount: number;
} {
  const assertion = createJreAssertion(credential, randomBytes(32).toString("base64url"));
  const authenticatorData = Buffer.from(assertion.response.authenticatorData, "base64url");
  const clientDataJSON = Buffer.from(assertion.response.clientDataJSON, "base64url");
  const signedData = Buffer.concat([
    authenticatorData,
    createHash("sha256").update(clientDataJSON).digest(),
  ]);
  const privateKey = createPrivateKey({
    key: Buffer.from(credential.privateKeyPkcs8Base64Url, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  return {
    verified: verify(
      "sha256",
      signedData,
      createPublicKey(privateKey),
      Buffer.from(assertion.response.signature, "base64url"),
    ),
    credentialIdBytes: Buffer.from(assertion.rawId, "base64url").byteLength,
    authenticatorDataBytes: authenticatorData.byteLength,
    flags: `0x${authenticatorData[32]?.toString(16).padStart(2, "0")}`,
    signCount: authenticatorData.readUInt32BE(33),
  };
}

function credentialIdBytes(value: string): Buffer {
  if (value.startsWith("b64.")) return Buffer.from(value.slice(4), "base64url");
  const hex = value.replaceAll("-", "");
  if (/^[0-9a-f]{32}$/iu.test(hex)) return Buffer.from(hex, "hex");
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength === 0) throw new Error("JRE ID credential ID is invalid");
  return decoded;
}

function uint32be(value: number): Buffer {
  const output = Buffer.alloc(4);
  output.writeUInt32BE(value >>> 0);
  return output;
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${name} is required`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
