#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { password, isCancel, intro, outro, log } from "@clack/prompts";
import { CookieJar } from "tough-cookie";
import {
  AUTH_KEY_SHA256,
  CONFIG_KEY_SHA256,
  assertPublicKeyHash,
  buildConfigAuth,
  buildFirstLoginAuth,
  decryptLoginToken,
  validateLoginTokenShape,
} from "./mobile-auth";
import { adler32, extractAvailableMonths, isObject, objectAt } from "./vpass-client";

const AUTH_URL = "https://spap.smbc-card.com/api/v3/Fauth";
const CONFIG_URL = "https://spap.smbc-card.com/api/v3/common/Config";
const MEMBER_URL =
  "https://www.smbc-card.com/memapi/jaxrs/web_meisai/web_meisai_top/v1";
const APP_VERSION = "5.12.0";
const MOBILE_UA =
  `com.smbc_card.vpass.android_v${APP_VERSION} ` +
  "Mozilla/5.0 (Linux; Android 15; Pixel 9 Build/AP3A.241105.008; wv) " +
  "AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/142.0.0.0 Mobile Safari/537.36";

function argument(name: string, envName: string): string {
  const inline = Bun.argv.find((value) => value.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = Bun.argv.indexOf(name);
  const value = index >= 0 ? Bun.argv[index + 1] : undefined;
  return value ?? process.env[envName] ?? "";
}

function setCookieHeaders(headers: Headers): string[] {
  const extended = headers as Headers & {
    getSetCookie?: () => string[];
    getAll?: (name: string) => string[];
  };
  if (extended.getSetCookie) return extended.getSetCookie();
  if (extended.getAll) return extended.getAll("set-cookie");
  const combined = headers.get("set-cookie");
  return combined ? [combined] : [];
}

async function bridgeCookies(
  jar: CookieJar,
  response: Response,
): Promise<{ received: number; defaultedPath: number }> {
  const sources = setCookieHeaders(response.headers);
  let defaultedPath = 0;
  for (const source of sources) {
    // ReceivedCookiesInterceptor rebuilds every cookie for smbc-card.com and
    // Cookie.Builder defaults a missing Path attribute to `/`. tough-cookie's
    // RFC default would instead scope a Config cookie to `/api/v3/common`.
    let normalized = `${source.replace(/;\s*domain=[^;]*/gi, "")}; Domain=smbc-card.com`;
    if (!/;\s*path=/i.test(normalized)) {
      normalized += "; Path=/";
      defaultedPath += 1;
    }
    await jar.setCookie(normalized, AUTH_URL);
  }
  return { received: sources.length, defaultedPath };
}

function safeAuthSummary(response: Response, json: unknown, jar: CookieJar) {
  const data = objectAt(json, "data");
  const status = isObject(json) && typeof json["status"] === "number" ? json["status"] : null;
  const type = isObject(json) && typeof json["type"] === "string" ? json["type"] : null;
  return jar.getCookies(MEMBER_URL).then((cookies) => ({
    httpStatus: response.status,
    appStatus: status,
    type,
    loginTokenPresent: typeof data?.["login_token"] === "string",
    cookieCount: cookies.length,
    sessionTimePresent: response.headers.has("x-vappsessiontime"),
  }));
}

function wrappedBody(path: string): object {
  return {
    header: { requestHash: adler32(path), requestTimestamp: Date.now(), corpCode: "" },
    body: { content: {} },
  };
}

async function main(): Promise<void> {
  intro("Vpass Android API read-only probe");
  const authKeyPath =
    argument("--auth-key", "VPASS_AUTH_PUBLIC_KEY_PATH") ||
    argument("--request-key", "VPASS_REQUEST_PUBLIC_KEY_PATH");
  const configKeyPath =
    argument("--config-key", "VPASS_CONFIG_PUBLIC_KEY_PATH") ||
    argument("--response-key", "VPASS_RESPONSE_PUBLIC_KEY_PATH");
  if (!authKeyPath || !configKeyPath) {
    throw new Error("--auth-key and --config-key are required");
  }
  const authKey = new Uint8Array(await readFile(authKeyPath));
  const configKey = new Uint8Array(await readFile(configKeyPath));
  assertPublicKeyHash(authKey, AUTH_KEY_SHA256, "auth public key");
  assertPublicKeyHash(configKey, CONFIG_KEY_SHA256, "Config public key");

  const deviceId = randomUUID();
  const pushSetting = Number(argument("--push", "VPASS_PUSH_SETTING") || "0");
  if (pushSetting !== 0 && pushSetting !== 1) {
    throw new Error("--push must be 0 (disabled) or 1 (enabled)");
  }
  const configOnly = Bun.argv.includes("--config-only");
  let loginId = "";
  let secret = "";
  if (!configOnly) {
    const idResult = await password({
      message: "Vpass ID",
      validate: (value) => (value?.trim() ? undefined : "Vpass ID is required"),
    });
    if (isCancel(idResult)) return;
    const passwordResult = await password({
      message: "Vpass password",
      validate: (value) => (value ? undefined : "Password is required"),
    });
    if (isCancel(passwordResult)) return;
    loginId = idResult.trim();
    secret = passwordResult;
  }
  const jar = new CookieJar();
  const commonHeaders = {
    accept: "application/json",
    "cache-control": "no-cache",
    "content-type": "application/json",
    "user-agent": MOBILE_UA,
    "x-app-version": APP_VERSION,
    "x-os-version": "15",
  };

  // The official LoginRepository calls Config immediately before Fauth. Config uses
  // the production false-key branch (pubkey_relese.pem) and establishes session time.
  const configResponse = await fetch(CONFIG_URL, {
    method: "POST",
    redirect: "manual",
    headers: commonHeaders,
    body: JSON.stringify({
      auth: buildConfigAuth({ deviceId }, configKey),
      appVersion: APP_VERSION,
      osType: "Android",
      osVersion: "35",
    }),
  });
  const configCookieBridge = await bridgeCookies(jar, configResponse);
  const configJson: unknown = await configResponse.json();
  const configStatus =
    isObject(configJson) && typeof configJson["status"] === "number" ? configJson["status"] : null;
  const sessionTime = configResponse.headers.get("x-vappsessiontime");
  const authCookieCount = (await jar.getCookies(AUTH_URL)).length;
  log.info(
    `Config result: ${JSON.stringify({ httpStatus: configResponse.status, appStatus: configStatus, sessionTimePresent: Boolean(sessionTime), authCookieCount, configCookieBridge })}`,
  );
  if (configResponse.status !== 200 || configStatus !== 200 || !sessionTime) {
    loginId = "";
    secret = "";
    throw new Error("Config did not establish a session; stopping without retry");
  }
  if (configOnly) {
    outro("Config probe succeeded; no credential was requested and no response was saved");
    return;
  }

  const auth = buildFirstLoginAuth(
    {
      loginId,
      password: secret,
      deviceId,
      // A fresh VpassPreference has no Firebase device token yet.
      deviceToken: "",
    },
    authKey,
  );
  loginId = "";
  secret = "";
  const authCookie = await jar.getCookieString(AUTH_URL);
  const authResponse = await fetch(AUTH_URL, {
    method: "POST",
    redirect: "manual",
    headers: { ...commonHeaders, cookie: authCookie, "x-vappsessiontime": sessionTime },
    body: JSON.stringify({
      auth,
      is_first_login: 1,
      // The official tutorial persists 0/1 before its first reachable login.
      push: pushSetting,
      auto_login: 0,
      os_type: 2,
      id_type: 2,
    }),
  });
  await bridgeCookies(jar, authResponse);
  const authJson: unknown = await authResponse.json();
  const summary = await safeAuthSummary(authResponse, authJson, jar);
  log.info(`Auth result: ${JSON.stringify(summary)}`);
  if (summary.httpStatus !== 200 || summary.appStatus !== 200 || !summary.loginTokenPresent) {
    throw new Error("Fauth was not accepted; stopping without retry");
  }

  const token = objectAt(authJson, "data")?.["login_token"];
  if (typeof token !== "string") throw new Error("Fauth response has no login_token");
  const tokenShape = validateLoginTokenShape(decryptLoginToken(token, authKey));
  log.info(`Token crypto: ${JSON.stringify(tokenShape)}`);
  if (tokenShape.fieldCount < 10 || !tokenShape.timestampPlausible) {
    throw new Error("Decrypted login_token failed structural validation");
  }

  if (Bun.argv.includes("--check-statements")) {
    const path = "/memapi/jaxrs/web_meisai/web_meisai_top/v1";
    const cookie = await jar.getCookieString(MEMBER_URL);
    const memberResponse = await fetch(MEMBER_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "cache-control": "no-cache",
        "content-type": "application/json",
        cookie,
        "user-agent": MOBILE_UA,
      },
      body: JSON.stringify(wrappedBody(path)),
    });
    const memberJson: unknown = await memberResponse.json();
    const resultCode = objectAt(memberJson, "header")?.["resultCode"];
    const monthCount = extractAvailableMonths(memberJson).length;
    log.info(
      `Statement check: ${JSON.stringify({ httpStatus: memberResponse.status, resultCode, monthCount })}`,
    );
    if (memberResponse.status !== 200 || monthCount === 0) {
      throw new Error("Statement month-list check failed; stopping without retry");
    }
  }
  outro("Probe succeeded; no response body, credential, cookie, or token was written to disk");
}

await main();
