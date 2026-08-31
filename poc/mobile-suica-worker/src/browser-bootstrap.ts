import puppeteer, { type BrowserWorker, type Page } from "@cloudflare/puppeteer";
import type { Protocol } from "devtools-protocol";
import type { SessionEnvelope } from "./types";
import type { StoredJreCredential } from "./webauthn";

const mobileSuicaOrigin = "https://www.mobilesuica.com";
const jreIdOrigin = "https://id.jreast.co.jp";

export interface BrowserBootstrapInspection {
  ok: boolean;
  stage: string;
  origin: string;
  pathname: string;
  title: string;
  inputs: Array<{
    name: string;
    type: string;
    autocomplete: string;
    placeholder: string;
    visible: boolean;
  }>;
  buttons: Array<{
    tag: string;
    type: string;
    text: string;
    ariaLabel: string;
    visible: boolean;
  }>;
}

export interface BrowserLoginCheck {
  ok: boolean;
  stage: string;
  challengeResultCode: string;
  assertionResultCode?: string;
  origin: string;
  pathname: string;
  title: string;
  inputLengthMatches?: boolean;
  passkeyButtonFound?: boolean;
  passkeyButtonDisabled?: boolean;
  observedRequests?: Array<{ pathname: string; formKeys: string[] }>;
  visibleButtonTexts?: string[];
}

export async function inspectBrowserBootstrap(
  browserBinding: BrowserRun,
  credential: StoredJreCredential,
): Promise<BrowserBootstrapInspection> {
  const browserWorker: BrowserWorker = {
    fetch: browserBinding.fetch.bind(browserBinding) as typeof fetch,
  };
  const browser = await puppeteer.launch(browserWorker);
  try {
    const page = await openJreLoginPage(browser, credential);
    const summary = await inspectLoginDom(page);
    return {
      ok: true,
      stage: "jre-id-login-dom",
      ...summary,
    };
  } finally {
    await browser.close();
  }
}

export async function checkBrowserPasskeyLogin(
  browserBinding: BrowserRun,
  credential: StoredJreCredential,
): Promise<BrowserLoginCheck> {
  const browserWorker: BrowserWorker = {
    fetch: browserBinding.fetch.bind(browserBinding) as typeof fetch,
  };
  const browser = await puppeteer.launch(browserWorker);
  try {
    const page = await openJreLoginPage(browser, credential);
    const observedRequests: Array<{ pathname: string; formKeys: string[] }> = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.origin !== jreIdOrigin || !url.pathname.startsWith("/idcs/account")) return;
      const body = request.postData();
      observedRequests.push({
        pathname: url.pathname,
        formKeys: body ? [...new URLSearchParams(body).keys()].sort() : [],
      });
    });
    const challengeResponsePromise = page.waitForResponse(
      (response) => isJreLoginResponse(response.url(), response.request().method(), response.request().postData(), false),
      { timeout: 30_000 },
    ).catch(() => undefined);
    const assertionResponsePromise = page.waitForResponse(
      (response) => isJreLoginResponse(response.url(), response.request().method(), response.request().postData(), true),
      { timeout: 45_000 },
    ).catch(() => undefined);
    const switched = await page.evaluate(() => {
      const button = [...document.querySelectorAll<HTMLButtonElement>("button")]
        .find((candidate) => candidate.textContent?.replace(/\s+/gu, "").includes("パスキーでログインする"));
      if (button && !button.disabled) button.click();
      return Boolean(button && !button.disabled);
    });
    if (!switched) throw new Error("JRE ID passkey screen switch was not available");
    await page.waitForFunction(
      () => document.title.includes("パスキーでログイン"),
      { timeout: 10_000 },
    );
    await page.waitForSelector('input[name="id"]', { visible: true, timeout: 10_000 });
    await page.type('input[name="id"]', credential.username, { delay: 20 });
    const clickState = await page.evaluate((expectedLength) => {
      const input = document.querySelector<HTMLInputElement>('input[name="id"]');
      const buttons = [...document.querySelectorAll<HTMLButtonElement>("button")];
      const button = buttons
        .find((candidate) => candidate.textContent?.replace(/\s+/gu, "") === "パスキーでログインする");
      if (button && !button.disabled) button.click();
      return {
        inputLengthMatches: input?.value.length === expectedLength,
        passkeyButtonFound: Boolean(button),
        passkeyButtonDisabled: button?.disabled ?? false,
        visibleButtonTexts: buttons
          .filter((candidate) => {
            const rect = candidate.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          })
          .map((candidate) => candidate.textContent?.replace(/\s+/gu, " ").trim().slice(0, 100) ?? ""),
      };
    }, credential.username.length);
    if (!clickState.passkeyButtonFound) {
      const currentUrl = new URL(page.url());
      return {
        ok: false,
        stage: "jre-id-passkey-submit-not-found",
        challengeResultCode: "not-observed",
        origin: currentUrl.origin,
        pathname: currentUrl.pathname,
        title: await page.title(),
        ...clickState,
        observedRequests,
      };
    }
    const challengeResponse = await challengeResponsePromise;
    if (!challengeResponse) {
      const currentUrl = new URL(page.url());
      return {
        ok: false,
        stage: "jre-id-passkey-request-not-observed",
        challengeResultCode: "not-observed",
        origin: currentUrl.origin,
        pathname: currentUrl.pathname,
        title: await page.title(),
        ...clickState,
        observedRequests,
      };
    }
    const challengeResultCode = await responseResultCode(challengeResponse);
    if (
      challengeResultCode !== "unavailable" &&
      challengeResultCode !== "CO-SC0001" &&
      challengeResultCode !== "CO-SC0002"
    ) {
      return {
        ok: false,
        stage: "jre-id-passkey-challenge-rejected",
        challengeResultCode,
        origin: new URL(page.url()).origin,
        pathname: new URL(page.url()).pathname,
        title: await page.title(),
        ...clickState,
        observedRequests,
      };
    }
    const assertionResponse = await assertionResponsePromise;
    if (!assertionResponse) {
      const currentUrl = new URL(page.url());
      return {
        ok: false,
        stage: "jre-id-assertion-not-observed",
        challengeResultCode,
        origin: currentUrl.origin,
        pathname: currentUrl.pathname,
        title: await page.title(),
        ...clickState,
        observedRequests,
      };
    }
    const assertionResultCode = await responseResultCode(assertionResponse);
    await page.waitForFunction(
      (origin) => location.origin === origin,
      { timeout: 45_000 },
      mobileSuicaOrigin,
    );
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 10_000 }).catch(() => undefined);
    const finalUrl = new URL(page.url());
    return {
      ok: finalUrl.origin === mobileSuicaOrigin,
      stage: "mobile-suica-after-jre-id",
      challengeResultCode,
      assertionResultCode,
      origin: finalUrl.origin,
      pathname: finalUrl.pathname,
      title: await page.title(),
      ...clickState,
      observedRequests,
    };
  } finally {
    await browser.close();
  }
}

export async function bootstrapMobileSuicaSessionWithBrowser(
  browserBinding: BrowserRun,
  credential: StoredJreCredential,
): Promise<SessionEnvelope> {
  const browserWorker: BrowserWorker = {
    fetch: browserBinding.fetch.bind(browserBinding) as typeof fetch,
  };
  const browser = await puppeteer.launch(browserWorker);
  try {
    const page = await openJreLoginPage(browser, credential);
    await performPasskeyLogin(page, credential);
    await clickMobileSuicaHistoryApplication(page);
    await submitMobileSuicaForm(page, "/iq/ir/SuicaDisp.aspx");
    await page.waitForSelector('input[name="baseVariable"]', { timeout: 20_000 });
    const baseVariable = await page.$eval(
      'input[name="baseVariable"]',
      (input) => (input as HTMLInputElement).value,
    );
    if (!baseVariable) throw new Error("Mobile Suica history page had no form state");
    const historyUrl = new URL("/iq/ir/SuicaDisp.aspx", mobileSuicaOrigin).toString();
    const cookies = await page.cookies(historyUrl);
    const cookieHeader = cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
    const userAgent = await page.evaluate(() => navigator.userAgent);
    return {
      capturedAt: new Date().toISOString(),
      cookieHeader,
      formBody: new URLSearchParams({ baseVariable }).toString(),
      userAgent,
    };
  } finally {
    await browser.close();
  }
}

async function performPasskeyLogin(page: Page, credential: StoredJreCredential): Promise<void> {
  const challengeResponsePromise = page.waitForResponse(
    (response) => isJreLoginResponse(response.url(), response.request().method(), response.request().postData(), false),
    { timeout: 30_000 },
  );
  const assertionResponsePromise = page.waitForResponse(
    (response) => isJreLoginResponse(response.url(), response.request().method(), response.request().postData(), true),
    { timeout: 45_000 },
  );
  const switched = await clickButton(page, "パスキーでログインする");
  if (!switched) throw new Error("JRE ID passkey screen switch was not available");
  await page.waitForFunction(() => document.title.includes("パスキーでログイン"), { timeout: 10_000 });
  await page.waitForSelector('input[name="id"]', { visible: true, timeout: 10_000 });
  await page.type('input[name="id"]', credential.username, { delay: 20 });
  if (!await clickButton(page, "パスキーでログインする")) {
    throw new Error("JRE ID passkey submit button was not available");
  }
  const challengeResultCode = await responseResultCode(await challengeResponsePromise);
  if (
    challengeResultCode !== "unavailable" &&
    challengeResultCode !== "CO-SC0001" &&
    challengeResultCode !== "CO-SC0002"
  ) {
    throw new Error(`JRE ID passkey challenge failed; resultCode=${challengeResultCode}`);
  }
  await assertionResponsePromise;
  await page.waitForFunction((origin) => location.origin === origin, { timeout: 45_000 }, mobileSuicaOrigin);
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 10_000 }).catch(() => undefined);
}

async function clickButton(page: Page, text: string): Promise<boolean> {
  return page.evaluate((expected) => {
    const button = [...document.querySelectorAll<HTMLButtonElement>("button")]
      .find((candidate) => candidate.textContent?.replace(/\s+/gu, "") === expected.replace(/\s+/gu, ""));
    if (button && !button.disabled) button.click();
    return Boolean(button && !button.disabled);
  }, text);
}

async function mobileSuicaUrlFromPage(page: Page, pathname: string): Promise<string> {
  const value = await page.evaluate((expectedPath) => {
    const html = document.documentElement.outerHTML;
    const escapedPath = expectedPath.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const match = new RegExp(`(?:https:\\/\\/www\\.mobilesuica\\.com)?${escapedPath}[^'"<>\\s)]*`, "u").exec(html)?.[0];
    return match?.replaceAll("&amp;", "&");
  }, pathname);
  if (!value) {
    const summary = await page.evaluate(() => ({
      pathname: location.pathname,
      title: document.title.replace(/\s+/gu, " ").trim().slice(0, 100),
      internalPaths: [...new Set(
        [...document.querySelectorAll<HTMLAnchorElement>("a[href]")]
          .map((link) => {
            try {
              const url = new URL(link.href, location.href);
              return url.origin === location.origin ? url.pathname : undefined;
            } catch {
              return undefined;
            }
          })
          .filter((entry): entry is string => Boolean(entry)),
      )].sort().slice(0, 30),
    }));
    throw new Error(
      `Mobile Suica page did not contain ${pathname}; ` +
      `current=${summary.pathname}; title=${summary.title}; paths=${summary.internalPaths.join("|")}`,
    );
  }
  const url = new URL(value, mobileSuicaOrigin);
  if (url.origin !== mobileSuicaOrigin || url.pathname !== pathname) {
    throw new Error("Mobile Suica page returned an unexpected internal URL");
  }
  return url.toString();
}

async function submitMobileSuicaForm(page: Page, pathname: string): Promise<void> {
  const navigation = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 });
  const submitted = await page.evaluate((expectedPath) => {
    const form = [...document.forms].find((candidate) => {
      try {
        return new URL(candidate.action, location.href).pathname === expectedPath;
      } catch {
        return false;
      }
    });
    form?.submit();
    return Boolean(form);
  }, pathname);
  if (!submitted) {
    await navigation.catch(() => undefined);
    await mobileSuicaUrlFromPage(page, pathname);
    throw new Error(`Mobile Suica page did not have a form for ${pathname}`);
  }
  await navigation;
  const current = new URL(page.url());
  if (current.origin !== mobileSuicaOrigin || current.pathname !== pathname) {
    throw new Error(`Mobile Suica form for ${pathname} reached ${current.pathname}`);
  }
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 10_000 }).catch(() => undefined);
}

async function clickMobileSuicaHistoryApplication(page: Page): Promise<void> {
  const navigation = page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 30_000 });
  const clicked = await page.evaluate(() => {
    const link = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")]
      .find((candidate) => {
        const source = candidate.getAttribute("href") ?? "";
        return source.includes("/ka/lg/SuicaChangeTransfer.aspx") &&
          source.includes("LoginTransferId=SFRIQIRPC22") &&
          source.includes("returnId=SFRCMMEPC03");
      });
    link?.click();
    return Boolean(link);
  });
  if (!clicked) {
    await navigation.catch(() => undefined);
    throw new Error("Mobile Suica member menu had no SF history application link");
  }
  await navigation;
  const current = new URL(page.url());
  if (current.origin !== mobileSuicaOrigin || current.pathname !== "/ka/lg/SuicaChangeTransfer.aspx") {
    throw new Error(`Mobile Suica SF history application reached ${current.pathname}`);
  }
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 10_000 }).catch(() => undefined);
}

async function openJreLoginPage(
  browser: Awaited<ReturnType<typeof puppeteer.launch>>,
  credential: StoredJreCredential,
): Promise<Page> {
  const page = await browser.newPage();
  await installVirtualAuthenticator(page, credential);
  await page.setViewport({ width: 1365, height: 768, deviceScaleFactor: 1 });
  await page.setExtraHTTPHeaders({ "Accept-Language": "ja-JP,ja;q=0.9,en;q=0.8" });
  await page.goto(`${mobileSuicaOrigin}/`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  const jreHref = await page.evaluate(() => {
    const links = [...document.querySelectorAll<HTMLAnchorElement>("a[href]")];
    const link = links.find((candidate) => {
      const source = `${candidate.getAttribute("href") ?? ""} ${candidate.getAttribute("onclick") ?? ""}`;
      return source.includes("/ka/lg/RequestIdpAuthentication.aspx") && source.includes("returnId=SFRKALGPC02");
    });
    const source = `${link?.getAttribute("href") ?? ""} ${link?.getAttribute("onclick") ?? ""}`;
    return /https:\/\/www\.mobilesuica\.com\/ka\/lg\/RequestIdpAuthentication\.aspx\?[^'"\s)]+/u
      .exec(source)?.[0]
      ?.replaceAll("&amp;", "&");
  });
  if (!jreHref) throw new Error("Mobile Suica home page had no JRE ID authentication link");
  const startUrl = new URL(jreHref);
  if (
    startUrl.origin !== mobileSuicaOrigin ||
    startUrl.pathname !== "/ka/lg/RequestIdpAuthentication.aspx" ||
    startUrl.searchParams.get("returnId") !== "SFRKALGPC02" ||
    !startUrl.searchParams.get("pguid")
  ) {
    throw new Error("Mobile Suica home page had an invalid JRE ID authentication link");
  }
  await page.goto(startUrl.toString(), { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForFunction(
    (origin) => location.origin === origin && location.pathname === "/idcs/contents/login",
    { timeout: 30_000 },
    jreIdOrigin,
  );
  await page.waitForSelector("input, button", { timeout: 20_000 });
  await page.waitForNetworkIdle({ idleTime: 500, timeout: 10_000 }).catch(() => undefined);
  return page;
}

async function installVirtualAuthenticator(
  page: Page,
  credential: StoredJreCredential,
): Promise<void> {
  const client = await page.createCDPSession();
  await client.send("WebAuthn.enable", { enableUI: false });
  const authenticator = await client.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      automaticPresenceSimulation: true,
      isUserVerified: true,
      defaultBackupEligibility: true,
      defaultBackupState: true,
    },
  });
  const value: Protocol.WebAuthn.Credential = {
    credentialId: toBase64(credentialIdBytes(credential.credentialId)),
    isResidentCredential: true,
    rpId: credential.rpId,
    privateKey: toBase64(Buffer.from(credential.privateKeyPkcs8Base64Url, "base64url")),
    userHandle: toBase64(Buffer.from(credential.userHandle.replace(/=+$/u, ""), "base64url")),
    signCount: credential.counter,
    backupEligibility: true,
    backupState: true,
  };
  await client.send("WebAuthn.addCredential", {
    authenticatorId: authenticator.authenticatorId,
    credential: value,
  });
}

async function inspectLoginDom(page: Page): Promise<Omit<BrowserBootstrapInspection, "ok" | "stage">> {
  return page.evaluate(() => {
    const visible = (element: Element): boolean => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const clean = (value: string | null | undefined): string =>
      (value ?? "").replace(/\s+/gu, " ").trim().slice(0, 100);
    return {
      origin: location.origin,
      pathname: location.pathname,
      title: clean(document.title),
      inputs: [...document.querySelectorAll<HTMLInputElement>("input")].map((input) => ({
        name: clean(input.name),
        type: clean(input.type),
        autocomplete: clean(input.autocomplete),
        placeholder: clean(input.placeholder),
        visible: visible(input),
      })),
      buttons: [...document.querySelectorAll<HTMLElement>("button, [role=button], input[type=submit]")].map((button) => ({
        tag: button.tagName.toLowerCase(),
        type: clean(button.getAttribute("type")),
        text: clean(button.textContent),
        ariaLabel: clean(button.getAttribute("aria-label")),
        visible: visible(button),
      })),
    };
  });
}

function credentialIdBytes(value: string): Buffer {
  if (value.startsWith("b64.")) return Buffer.from(value.slice(4), "base64url");
  const hex = value.replaceAll("-", "");
  return /^[0-9a-f]{32}$/iu.test(hex) ? Buffer.from(hex, "hex") : Buffer.from(value, "base64url");
}

function toBase64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function isJreLoginResponse(
  url: string,
  method: string,
  postData: string | undefined,
  assertion: boolean,
): boolean {
  if (url !== `${jreIdOrigin}/idcs/account/login` || method !== "POST") return false;
  const hasAssertion = postData?.includes("Fs2AuthenticationResponse") ?? false;
  return assertion === hasAssertion;
}

async function responseResultCode(response: { json(): Promise<unknown> }): Promise<string> {
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    return "unavailable";
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "missing";
  const resultCode = Reflect.get(value, "resultCode");
  return typeof resultCode === "string" ? resultCode : "missing";
}
