import {
  constants,
  createCipheriv,
  createDecipheriv,
  createHash,
  publicDecrypt,
  publicEncrypt,
  randomInt,
} from "node:crypto";

const RANDOM_ALPHABET =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz@+*<>?!#$%&'()=~|_-^";

export const REQUEST_KEY_SHA256 =
  "6519fb233bf377b097ac4577d43db7782920ae649bb449db8daae9b6b1d0099e";
export const RESPONSE_KEY_SHA256 =
  "43a1c7611ed69ceb1bcdedcb1c8093b0e411411adb31aaecbb12ca0a006c41ef";

export interface FirstLoginAuthInput {
  loginId: string;
  password: string;
  deviceId: string;
  globalId?: string | null;
  companyCode?: string;
  timestamp?: number;
}

export interface ConfigAuthInput {
  deviceId: string;
  globalId?: string | null;
  companyCode?: string;
  timestampMilliseconds?: number;
}

export const CONFIG_AUTH_CONSTANT =
  "OTdhYzY0NThmYTQyMmJhOGVjNTQ1ZjM1MGQyNGU3NTcyMGYzNGRmOTk0ZWIzZDZjMWFjODk5YjU3YmM3MGQzNjZlZTQxYTVlODVhNjI5OTM1ZTk1MGFkODM3ZDdmNDMy";

function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function assertPublicKeyHash(pem: string | Uint8Array, expected: string, label: string): void {
  const actual = sha256Hex(pem);
  if (actual !== expected) {
    throw new Error(`${label} SHA-256 mismatch: expected ${expected}, got ${actual}`);
  }
}

export function transformDeviceId(deviceId: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(deviceId)) {
    throw new Error("deviceId must be a UUID");
  }
  const decimal = BigInt(`0x${deviceId.replaceAll("-", "")}`).toString(10).padStart(39, "0");
  let sum = 0;
  let weight = 2;
  for (let index = decimal.length - 1; index >= 0; index -= 1) {
    sum += Number(decimal[index]) * weight;
    weight = weight === 7 ? 2 : weight + 1;
  }
  const remainder = sum % 11;
  const checkDigit = remainder > 1 ? 11 - remainder : 0;
  const characters = [...deviceId];
  characters.splice(8, 1);
  characters.splice(deviceId.length - 4, 0, String(checkDigit));
  return characters.join("");
}

export function buildFirstLoginPlaintext(input: FirstLoginAuthInput): string {
  const timestamp = input.timestamp ?? Math.floor(Date.now() / 1_000);
  const companyCode = input.companyCode ?? "001";
  const digest = sha256Hex(input.password + timestamp + input.loginId + companyCode);
  return [
    input.loginId,
    input.password,
    transformDeviceId(input.deviceId),
    input.globalId ?? "null",
    "",
    companyCode,
    String(timestamp),
    digest,
  ].join("|");
}

export function buildConfigPlaintext(input: ConfigAuthInput): string {
  const timestamp = input.timestampMilliseconds ?? Date.now();
  const companyCode = input.companyCode ?? "001";
  // StringBuilder.append(null) in the fresh official-app path emits the literal "null".
  const globalId = input.globalId ?? "null";
  const digest = sha256Hex("" + "" + companyCode + CONFIG_AUTH_CONSTANT + timestamp);
  return [
    "",
    "",
    input.deviceId,
    globalId,
    CONFIG_AUTH_CONSTANT,
    companyCode,
    String(timestamp),
    digest,
  ].join("|");
}

function randomAscii16(): Buffer {
  return Buffer.from(
    Array.from({ length: 16 }, () => RANDOM_ALPHABET[randomInt(RANDOM_ALPHABET.length)]).join(""),
    "utf8",
  );
}

export function encryptAuthPlaintext(
  plaintext: string,
  requestPublicKey: string | Uint8Array,
): string {
  const aesKey = randomAscii16();
  const iv = randomAscii16();
  const cipher = createCipheriv("aes-128-cbc", aesKey, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const wrappedKey = publicEncrypt(
    {
      key: requestPublicKey,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    aesKey,
  );
  return Buffer.concat([iv, ciphertext, wrappedKey]).toString("base64").replace(/=+$/, "");
}

export function buildFirstLoginAuth(
  input: FirstLoginAuthInput,
  requestPublicKey: string | Uint8Array,
): string {
  return encryptAuthPlaintext(buildFirstLoginPlaintext(input), requestPublicKey);
}

export function buildConfigAuth(
  input: ConfigAuthInput,
  configPublicKey: string | Uint8Array,
): string {
  return encryptAuthPlaintext(buildConfigPlaintext(input), configPublicKey);
}

export function decryptLoginToken(token: string, responsePublicKey: string | Uint8Array): string {
  const decoded = Buffer.from(token, "base64");
  const rsaWidth = 256;
  if (decoded.length <= rsaWidth + 16) throw new Error("login_token envelope is too short");
  const aesPart = decoded.subarray(0, decoded.length - rsaWidth);
  const wrappedKey = decoded.subarray(decoded.length - rsaWidth);
  const aesKey = publicDecrypt(
    { key: responsePublicKey, padding: constants.RSA_PKCS1_PADDING },
    wrappedKey,
  );
  const iv = aesPart.subarray(0, 16);
  const ciphertext = aesPart.subarray(16);
  const decipher = createDecipheriv("aes-128-cbc", aesKey, iv);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

export function validateLoginTokenShape(plaintext: string): {
  fieldCount: number;
  timestampPlausible: boolean;
} {
  const fields = plaintext.split("|");
  const timestamp = Number(fields[8]);
  return {
    fieldCount: fields.length,
    timestampPlausible:
      Number.isInteger(timestamp) && Math.abs(Math.floor(Date.now() / 1_000) - timestamp) < 86_400,
  };
}
