import { createBitwardenAssertion, decryptPasskeyToken } from "./crypto";
import type { SbiCredential, SbiHandshakeKey, WebAuthnRequest } from "./types";

const BROWSER_HEADERS = {
  "accept-language": "ja,en-US;q=0.9,en;q=0.8",
  "cache-control": "no-cache",
  pragma: "no-cache",
  "user-agent":
    "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Mobile Safari/537.36",
} as const;

export function parseCredential(value: string): SbiCredential {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("SBI_CREDENTIAL_JSON is not valid JSON");
  }
  const object = objectValue(parsed, "SBI credential");
  const userHandle = optionalString(object["userHandle"]);
  return {
    rpId: requiredString(object["rpId"], "SBI credential rpId"),
    origin: requiredHttpsOrigin(object["origin"], "SBI credential origin"),
    credentialId: requiredString(object["credentialId"], "SBI credential credentialId"),
    keyValue: requiredString(object["keyValue"], "SBI credential keyValue"),
    ...(userHandle ? { userHandle } : {}),
    counter: nonNegativeInteger(object["counter"], "SBI credential counter"),
  };
}

export async function requestPasskeyAccessToken(options: {
  authEntryUrl: string;
  credential: SbiCredential;
  handshakeKey: SbiHandshakeKey;
  channel: "kabu-app" | "foreign-kabu-app";
}): Promise<string> {
  const entryUrl = requiredHttpsUrl(options.authEntryUrl, "SBI auth entry URL");
  if (!hostnameMatchesRpId(entryUrl.hostname, options.credential.rpId)) {
    throw new Error("SBI auth entry host does not match the passkey RP ID");
  }
  const handshake = options.handshakeKey;
  entryUrl.searchParams.set("channel", options.channel);
  entryUrl.searchParams.set("pk", handshake.publicKeyParam);
  entryUrl.searchParams.set("ap", "true");

  const cookies = new CookieBag();
  const entry = await fetchWithCookies(
    entryUrl,
    {
      headers: {
        ...BROWSER_HEADERS,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "upgrade-insecure-requests": "1",
      },
    },
    cookies,
  );
  if (!entry.ok) {
    throw Object.assign(new Error(`SBI passkey entry failed with HTTP ${entry.status}`), {
      httpStatus: entry.status,
    });
  }
  const entryHtml = await entry.text();
  const pageCsrfToken = extractCsrfToken(entryHtml);

  const challengeUrl = new URL("/api/fido2/auth/challenge", entryUrl);
  challengeUrl.searchParams.set("cccid", options.channel);
  const challengeResponse = await fetchWithCookies(
    challengeUrl,
    {
      method: "POST",
      headers: {
        ...BROWSER_HEADERS,
        accept: "application/json, text/javascript, */*; q=0.01",
        origin: entryUrl.origin,
        referer: entryUrl.toString(),
        "x-requested-with": "XMLHttpRequest",
        ...(pageCsrfToken ? { "x-csrf-token": pageCsrfToken } : {}),
      },
    },
    cookies,
  );
  if (!challengeResponse.ok) {
    throw Object.assign(
      new Error(`SBI passkey challenge failed with HTTP ${challengeResponse.status}`),
      { httpStatus: challengeResponse.status },
    );
  }
  const request = normalizeCredentialRequest(
    await challengeResponse.json(),
    options.credential.rpId,
  );
  const assertion = createBitwardenAssertion(options.credential, request);
  const csrfToken = request.csrfToken ?? pageCsrfToken;
  if (!csrfToken) throw new Error("SBI passkey challenge did not return a CSRF token");

  const assertionUrl = new URL("/fido2/auth", entryUrl);
  assertionUrl.searchParams.set("cccid", options.channel);
  const assertionResponse = await fetchWithCookies(
    assertionUrl,
    {
      method: "POST",
      redirect: "manual",
      headers: {
        ...BROWSER_HEADERS,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "content-type": "application/x-www-form-urlencoded",
        origin: entryUrl.origin,
        referer: entryUrl.toString(),
        "upgrade-insecure-requests": "1",
      },
      body: new URLSearchParams({
        _csrf: csrfToken,
        id: assertion.id,
        rawId: assertion.rawId,
        clientDataJSON: assertion.clientDataJSON,
        authenticatorData: assertion.authenticatorData,
        signature: assertion.signature,
        userHandle: assertion.userHandle,
        type: "public-key",
      }),
    },
    cookies,
  );
  if (assertionResponse.status < 300 || assertionResponse.status >= 400) {
    throw Object.assign(
      new Error(`SBI passkey assertion returned unexpected HTTP ${assertionResponse.status}`),
      { httpStatus: assertionResponse.status },
    );
  }

  const channelUrl = new URL(
    assertionResponse.headers.get("location") ?? `/sso/channel?cccid=${options.channel}`,
    entryUrl,
  );
  const callbackResponse = await fetchWithCookies(
    channelUrl,
    {
      headers: {
        ...BROWSER_HEADERS,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        referer: assertionUrl.toString(),
        "upgrade-insecure-requests": "1",
      },
    },
    cookies,
  );
  if (!callbackResponse.ok) {
    throw Object.assign(
      new Error(`SBI passkey callback failed with HTTP ${callbackResponse.status}`),
      { httpStatus: callbackResponse.status },
    );
  }
  const callbackUrl = extractCallbackUrl(await callbackResponse.text());
  if (!callbackUrl) {
    throw new Error("SBI passkey callback did not contain an encrypted token");
  }
  const encryptedToken = new URL(callbackUrl).searchParams.get("token");
  if (!encryptedToken) {
    throw new Error("SBI passkey callback URL did not contain token");
  }
  return decryptPasskeyToken(encryptedToken, handshake.privateKeyPem);
}

export class CookieBag {
  readonly #values = new Map<string, string>();

  absorb(response: Response): void {
    const headers = response.headers as Headers & {
      getSetCookie?: () => string[];
    };
    const values = headers.getSetCookie?.() ?? splitSetCookie(response.headers.get("set-cookie"));
    for (const value of values) {
      const pair = value.split(";", 1)[0]?.trim();
      const separator = pair?.indexOf("=") ?? -1;
      if (!pair || separator <= 0) continue;
      this.#values.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
  }

  header(): string {
    return [...this.#values].map(([name, value]) => `${name}=${value}`).join("; ");
  }
}

async function fetchWithCookies(
  input: URL,
  init: RequestInit,
  cookies: CookieBag,
): Promise<Response> {
  const headers = new Headers(init.headers);
  const cookie = cookies.header();
  if (cookie) headers.set("cookie", cookie);
  const response = await fetch(input, { ...init, headers });
  cookies.absorb(response);
  return response;
}

function normalizeCredentialRequest(value: unknown, defaultRpId: string): WebAuthnRequest {
  const root = objectValue(value, "SBI passkey challenge");
  const data =
    optionalObject(root["data"]) ??
    optionalObject(root["publicKey"]) ??
    optionalObject(root["publicKeyCredentialRequestOptions"]) ??
    root;
  const publicKey =
    optionalObject(data["publicKey"]) ??
    optionalObject(data["publicKeyCredentialRequestOptions"]) ??
    data;
  const challenge = optionalString(publicKey["challenge"]) ?? optionalString(data["challenge"]);
  if (!challenge) throw new Error("SBI passkey challenge is missing challenge");
  const csrfToken =
    optionalString(root["csrfToken"]) ??
    optionalString(root["_csrf"]) ??
    optionalString(data["csrfToken"]) ??
    optionalString(data["_csrf"]) ??
    optionalString(publicKey["csrfToken"]) ??
    optionalString(publicKey["_csrf"]);
  return {
    challenge,
    rpId: optionalString(publicKey["rpId"]) ?? defaultRpId,
    ...(csrfToken ? { csrfToken } : {}),
  };
}

function extractCsrfToken(html: string): string | undefined {
  const patterns = [
    /<meta[^>]+name=["']_csrf["'][^>]+content=["']([^"']+)["']/iu,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']_csrf["']/iu,
    /<input[^>]+name=["']_csrf["'][^>]+value=["']([^"']+)["']/iu,
    /["']_csrf["']\s*:\s*["']([^"']+)["']/u,
    /csrfToken["']?\s*[:=]\s*["']([^"']+)["']/u,
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return htmlDecode(match[1]);
  }
  return undefined;
}

function extractCallbackUrl(html: string): string | undefined {
  const match =
    html.match(/[a-z][a-z0-9+.-]*:\\\/\\\/auth\\\/callback\?token=[^"'<\\]+/iu) ??
    html.match(/[a-z][a-z0-9+.-]*:\/\/auth\/callback\?token=[^"'<\\]+/iu);
  return match?.[0]?.replaceAll("\\/", "/");
}

function splitSetCookie(value: string | null): string[] {
  if (!value) return [];
  return value.split(/,(?=\s*[^;,=\s]+=[^;,]*)/gu);
}

function htmlDecode(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function hostnameMatchesRpId(hostname: string, rpId: string): boolean {
  return hostname === rpId || hostname.endsWith(`.${rpId}`);
}

function requiredHttpsUrl(value: string, label: string): URL {
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error(`${label} must use HTTPS`);
  return url;
}

function requiredHttpsOrigin(value: unknown, label: string): string {
  const url = requiredHttpsUrl(requiredString(value, label), label);
  return url.origin;
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function optionalObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}
