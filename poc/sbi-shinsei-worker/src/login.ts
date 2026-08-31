import {
  AuthenticationBoundaryError,
  LoginResponseError,
  ResponseTooLargeError,
} from "./errors";
import type {
  JscMaterial,
  LoginSession,
  SbiShinseiCredential,
} from "./types";

const ORIGIN = "https://bk.web.sbishinseibank.co.jp" as const;
const LOGIN_URL =
  `${ORIGIN}/SFC/app/ShinseiAuthenticatorRealm/login_auth_request_url`;
const LOGIN_REFERER =
  `${ORIGIN}/SFC/apps/services/www/SFC/desktopbrowser/default/`;
const MAX_LOGIN_RESPONSE_BYTES = 64 * 1024;
const ACCEPTED_LOGIN_MEDIA_TYPES = new Set([
  "application/octet-stream",
  "application/json",
  "text/json",
]);

export interface LoginTransportOptions {
  fetch: (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => Promise<Response>;
}

export class SbiShinseiLoginTransport {
  constructor(private readonly options: LoginTransportOptions) {}

  async login(
    credential: SbiShinseiCredential,
    material: JscMaterial,
  ): Promise<LoginSession> {
    validateJscMaterial(material);
    const nationalId = `${credential.branchNumber}${credential.accountNumber}`;
    const form = new URLSearchParams();
    form.set("fldUserID", nationalId);
    form.set("password", credential.powerDirectPassword);
    form.set("langCode", "JAP");
    form.set("mode", "1");
    form.set("postubFlag", "0");
    form.set("jsc", material.jsc);
    form.set("forward", "");
    form.set("userAgentInfo", material.userAgent);

    const response = await this.options.fetch(LOGIN_URL, {
      method: "POST",
      redirect: "manual",
      headers: {
        accept: "application/json, text/plain, */*",
        "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
        referer: LOGIN_REFERER,
        "user-agent": material.userAgent,
        "x-requested-with": "XMLHttpRequest",
      },
      body: form.toString(),
    });

    if (
      response.status === 401 ||
      response.status === 403 ||
      (response.status >= 300 && response.status < 400)
    ) {
      throw new AuthenticationBoundaryError(
        `PowerDirect login stopped at HTTP ${response.status}`,
      );
    }
    if (!response.ok) {
      throw new LoginResponseError(
        `PowerDirect login returned HTTP ${response.status}`,
      );
    }

    const mediaType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase();
    if (!mediaType || !ACCEPTED_LOGIN_MEDIA_TYPES.has(mediaType)) {
      throw new LoginResponseError(
        "PowerDirect login returned an unrecognized content type",
      );
    }

    const authorization = response.headers.get("authorization");
    if (
      typeof authorization !== "string" ||
      authorization.length === 0 ||
      authorization.length > 16_384
    ) {
      throw new LoginResponseError(
        "PowerDirect login did not return a valid authorization header",
      );
    }

    const raw = await readLimited(response, MAX_LOGIN_RESPONSE_BYTES);
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(raw));
    } catch {
      throw new LoginResponseError("PowerDirect login returned invalid JSON");
    }
    const csrfToken = validateLoginBody(parsed);
    return { authorization, csrfToken };
  }
}

function validateJscMaterial(material: JscMaterial): void {
  if (material.sourceOrigin !== ORIGIN) {
    throw new LoginResponseError("CAFIS material came from an unexpected origin");
  }
  if (
    material.jsc.length < 64 ||
    material.jsc.length > 16_384 ||
    /[\r\n\0]/u.test(material.jsc)
  ) {
    throw new LoginResponseError("CAFIS device token has an invalid shape");
  }
  if (
    material.userAgent.length < 20 ||
    material.userAgent.length > 1_024 ||
    /[\r\n\0]/u.test(material.userAgent)
  ) {
    throw new LoginResponseError("Browser user agent has an invalid shape");
  }
}

function validateLoginBody(value: unknown): string {
  const root = exactRecord(value, ["responseJSON"], "login");
  const response = exactRecord(
    root.responseJSON,
    ["authStatus", "token"],
    "login.responseJSON",
  );
  if (response.authStatus !== "success") {
    throw new AuthenticationBoundaryError("PowerDirect rejected the login");
  }
  if (
    typeof response.token !== "string" ||
    response.token.length === 0 ||
    response.token.length > 16_384
  ) {
    throw new LoginResponseError(
      "PowerDirect login did not return a valid CSRF token",
    );
  }
  return response.token;
}

function exactRecord(
  value: unknown,
  allowedKeys: readonly string[],
  label: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new LoginResponseError(`${label} must be an object`);
  }
  const result = value as Record<string, unknown>;
  const actual = Object.keys(result).sort();
  const expected = [...allowedKeys].sort();
  if (
    actual.length !== expected.length ||
    !actual.every((key, index) => key === expected[index])
  ) {
    throw new LoginResponseError(`${label} has an unknown shape`);
  }
  return result;
}

async function readLimited(
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> {
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    Number.isFinite(Number(declaredLength)) &&
    Number(declaredLength) > maximumBytes
  ) {
    throw new ResponseTooLargeError("PowerDirect login response exceeded size limit");
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new ResponseTooLargeError(
          "PowerDirect login response exceeded size limit",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
