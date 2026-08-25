#!/usr/bin/env bun

import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { password, isCancel, intro, outro, log } from "@clack/prompts";
import { CookieJar } from "tough-cookie";
import {
  REQUEST_KEY_SHA256,
  RESPONSE_KEY_SHA256,
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

async function bridgeCookies(jar: CookieJar, response: Response): Promise<void> {
  for (const source of setCookieHeaders(response.headers)) {
    const normalized = /;\s*domain=/i.test(source)
      ? source
      : `${source}; Domain=smbc-card.com`;
    await jar.setCookie(normalized, AUTH_URL);
  }
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
  const requestKeyPath = argument("--request-key", "VPASS_REQUEST_PUBLIC_KEY_PATH");
  const responseKeyPath = argument("--response-key", "VPASS_RESPONSE_PUBLIC_KEY_PATH");
  if (!requestKeyPath || !responseKeyPath) {
    throw new Error("--request-key and --response-key are required");
  }
  const requestKey = new Uint8Array(await readFile(requestKeyPath));
  const responseKey = new Uint8Array(await readFile(responseKeyPath));
  assertPublicKeyHash(requestKey, REQUEST_KEY_SHA256, "request public key");
  assertPublicKeyHash(responseKey, RESPONSE_KEY_SHA256, "response public key");

  const deviceId = randomUUID();
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
      auth: buildConfigAuth({ deviceId, globalId: null }, responseKey),
      appVersion: APP_VERSION,
      osType: "Android",
      osVersion: "35",
    }),
  });
  await bridgeCookies(jar, configResponse);
  const configJson: unknown = await configResponse.json();
  const configStatus =
    isObject(configJson) && typeof configJson["status"] === "number" ? configJson["status"] : null;
  const sessionTime = configResponse.headers.get("x-vappsessiontime");
  log.info(
    `Config result: ${JSON.stringify({ httpStatus: configResponse.status, appStatus: configStatus, sessionTimePresent: Boolean(sessionTime) })}`,
  );
  if (configResponse.status !== 200 || configStatus !== 200 || !sessionTime) {
    throw new Error("Config did not establish a session; stopping without retry");
  }
  if (Bun.argv.includes("--config-only")) {
    outro("Config probe succeeded; no credential was requested and no response was saved");
    return;
  }

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

  let secret = passwordResult;

  const auth = buildFirstLoginAuth(
    {
      loginId: idResult.trim(),
      password: secret,
      deviceId,
      // Fresh LoginRepository has no LoginInfoRO; StringBuilder renders null literally.
      globalId: null,
    },
    requestKey,
  );
  secret = "";
  const authCookie = await jar.getCookieString(AUTH_URL);
  const authResponse = await fetch(AUTH_URL, {
    method: "POST",
    redirect: "manual",
    headers: { ...commonHeaders, cookie: authCookie, "x-vappsessiontime": sessionTime },
    body: JSON.stringify({
      auth,
      is_first_login: 1,
      // VpassPreference.notificationSetting is -1 when no setting exists on a fresh install.
      push: -1,
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
  const tokenShape = validateLoginTokenShape(decryptLoginToken(token, responseKey));
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
