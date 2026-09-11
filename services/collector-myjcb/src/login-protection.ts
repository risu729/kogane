import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer";
import { CookieJar } from "./cookie-jar";
import { allowedUrl, assertAllowedRequest, MYJCB_ORIGIN } from "./policy";
import type { PasskeyCredential, PasswordCredential } from "./types";
import { HumanRequiredError, StopConditionError, type StopConditionCode } from "./types";

const LOGIN_TIMEOUT_MS = 45_000;

export interface ProtectedLoginResult {
  readonly jar: CookieJar;
  readonly userAgent: string;
  readonly mypageHtml: string;
  readonly close: () => Promise<void>;
}

export async function loginWithOfficialProtection(
  browserBinding: BrowserRun,
  credential: PasswordCredential,
): Promise<ProtectedLoginResult> {
  const browser = await puppeteer.launch(browserBinding as BrowserWorker, {
    keep_alive: 600_000,
  });
  try {
    const pages = await browser.pages();
    const page = pages[0] ?? (await browser.newPage());
    await page.setViewport({ width: 1365, height: 768, deviceScaleFactor: 1 });
    await page.goto(allowedUrl("login-page").href, {
      waitUntil: "domcontentloaded",
      timeout: LOGIN_TIMEOUT_MS,
    });
    await assertNoHumanChallenge(await page.content(), page.url(), true);
    const form = await page.evaluate(() => {
      const element = document.querySelector<HTMLFormElement>('form[name="loginForm"][action]');
      return element ? { action: element.action, method: element.method || "get" } : undefined;
    });
    if (!form) throw new StopConditionError("MyJCB login form was not found");
    assertAllowedRequest("login-submit", form.method, form.action);

    const userSelector = 'input[name="userId"]';
    const passwordSelector = 'input[name="password"]';
    await page.waitForSelector(userSelector, { timeout: LOGIN_TIMEOUT_MS });
    await page.waitForSelector(passwordSelector, { timeout: LOGIN_TIMEOUT_MS });
    await page.type(userSelector, credential.userId, { delay: 25 });
    await page.type(passwordSelector, credential.password, { delay: 25 });

    const navigation = page
      .waitForNavigation({
        waitUntil: "domcontentloaded",
        timeout: LOGIN_TIMEOUT_MS,
      })
      .catch(() => null);
    await page.evaluate(() => {
      const formElement = document.querySelector<HTMLFormElement>('form[name="loginForm"][action]');
      if (!formElement) throw new Error("login form disappeared");
      formElement.requestSubmit();
    });
    await navigation;

    const current = new URL(page.url());
    const html = await page.content();
    if (current.origin !== MYJCB_ORIGIN || current.pathname !== allowedUrl("mypage").pathname) {
      await assertNoHumanChallenge(html, page.url(), false);
      throw new StopConditionError(`Unexpected MyJCB login landing path: ${current.pathname}`);
    }
    const jar = new CookieJar();
    jar.importBrowserCookies(await page.cookies(), current);
    const userAgent = await page.evaluate(() => navigator.userAgent);
    return { jar, userAgent, mypageHtml: html, close: async () => browser.close() };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

export async function loginWithBitwardenPasskey(
  browserBinding: BrowserRun,
  credential: PasskeyCredential,
): Promise<ProtectedLoginResult> {
  const browser = await puppeteer.launch(browserBinding as BrowserWorker, {
    keep_alive: 600_000,
  });
  try {
    const { page, cdp } = await passkeyStage("passkey-browser-setup", async () => {
      const pages = await browser.pages();
      const page = pages[0] ?? (await browser.newPage());
      await page.setViewport({ width: 1365, height: 768, deviceScaleFactor: 1 });
      return { page, cdp: await page.createCDPSession() };
    });
    await passkeyStage("passkey-cdp-enable", async () => {
      await cdp.send("WebAuthn.enable", { enableUI: false });
    });
    const { authenticatorId } = await passkeyStage(
      "passkey-authenticator-add",
      async () =>
        await cdp.send("WebAuthn.addVirtualAuthenticator", {
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
        }),
    );
    await passkeyStage("passkey-credential-add", async () => {
      await cdp.send("WebAuthn.addCredential", {
        authenticatorId,
        credential: {
          credentialId: bitwardenCredentialIdToBase64(credential.credentialId),
          isResidentCredential: true,
          rpId: credential.rpId,
          privateKey: base64UrlToBase64(credential.privateKey),
          userHandle: base64UrlToBase64(credential.userHandle),
          signCount: -1,
          backupEligibility: true,
          backupState: true,
          ...(credential.userName === undefined ? {} : { userName: credential.userName }),
          ...(credential.userDisplayName === undefined
            ? {}
            : { userDisplayName: credential.userDisplayName }),
        },
      });
    });
    let assertionObserved = false;
    cdp.on("WebAuthn.credentialAsserted", (event) => {
      if (event.authenticatorId === authenticatorId) assertionObserved = true;
    });

    await passkeyStage("passkey-login-page", async () => {
      await page.goto(allowedUrl("login-page").href, {
        waitUntil: "domcontentloaded",
        timeout: LOGIN_TIMEOUT_MS,
      });
      await assertNoHumanChallenge(await page.content(), page.url(), true);
    });
    const selector = "#passkeyLoginButtonAD";
    const control = await passkeyStage("passkey-control", async () => {
      await page.waitForSelector(selector, { timeout: LOGIN_TIMEOUT_MS });
      return await page.evaluate((passkeySelector) => {
        const element = document.querySelector<HTMLAnchorElement>(passkeySelector);
        return element
          ? { tagName: element.tagName, text: element.textContent?.trim() ?? "" }
          : undefined;
      }, selector);
    });
    if (control?.tagName !== "A" || control.text !== "パスキーでログイン") {
      throw new StopConditionError("MyJCB passkey login control changed", "passkey-control");
    }

    await passkeyStage("passkey-trigger", async () => {
      const navigation = page
        .waitForNavigation({
          waitUntil: "domcontentloaded",
          timeout: LOGIN_TIMEOUT_MS,
        })
        .catch(() => null);
      await page.click(selector);
      await navigation;
      await page
        .waitForFunction(
          (mypagePath) => location.pathname === mypagePath,
          { timeout: LOGIN_TIMEOUT_MS },
          allowedUrl("mypage").pathname,
        )
        .catch(() => null);
    });

    const current = new URL(page.url());
    const html = await page.content();
    if (current.origin !== MYJCB_ORIGIN || current.pathname !== allowedUrl("mypage").pathname) {
      await assertNoHumanChallenge(html, page.url(), false);
      throw new StopConditionError(
        `Unexpected MyJCB passkey landing path: ${current.pathname}`,
        assertionObserved ? "passkey-landing" : "passkey-assertion",
      );
    }
    const { jar, userAgent } = await passkeyStage("passkey-session-import", async () => {
      const jar = new CookieJar();
      jar.importBrowserCookies(await page.cookies(), current);
      const userAgent = await page.evaluate(() => navigator.userAgent);
      return { jar, userAgent };
    });
    return { jar, userAgent, mypageHtml: html, close: async () => browser.close() };
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function passkeyStage<T>(code: StopConditionCode, action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof HumanRequiredError) throw error;
    if (error instanceof StopConditionError && error.code !== "unknown-upstream-state") throw error;
    throw new StopConditionError(`MyJCB passkey bootstrap stopped at ${code}`, code);
  }
}

export function bitwardenCredentialIdToBase64(value: string): string {
  if (value.startsWith("b64.")) return base64UrlToBase64(value.slice(4));
  const hex = value.replace(/-/gu, "");
  if (!/^[0-9a-f]{32}$/iu.test(hex)) {
    throw new StopConditionError("Bitwarden passkey credentialId is malformed");
  }
  const bytes = new Uint8Array(16);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytesToBase64(bytes);
}

export function base64UrlToBase64(value: string): string {
  const standard = value.replace(/-/gu, "+").replace(/_/gu, "/");
  return standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

async function assertNoHumanChallenge(
  html: string,
  url: string,
  isLoginEntry: boolean,
): Promise<void> {
  const reason = humanChallengeReason(html, isLoginEntry);
  if (reason !== undefined) throw new HumanRequiredError(reason);
  const current = new URL(url);
  if (current.origin !== MYJCB_ORIGIN) {
    throw new StopConditionError(`MyJCB redirected to an unexpected origin: ${current.origin}`);
  }
}

export function humanChallengeReason(html: string, isLoginEntry: boolean): string | undefined {
  const text = html.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ");
  const challenges: [RegExp, string][] = [
    [/(?:CAPTCHA|私はロボットではありません)/iu, "captcha"],
    [/(?:アクセスが制限|Access Denied|不正なアクセス)/iu, "access-denied"],
  ];
  if (!isLoginEntry) {
    challenges.unshift(
      [/(?:ワンタイムパスワード|認証コード|OTP)/iu, "otp"],
      [/(?:秘密の合い言葉|秘密の質問)/u, "secret-question"],
      [/(?:パスキー|passkey)/iu, "passkey"],
    );
  }
  for (const [pattern, reason] of challenges) {
    if (pattern.test(text)) return reason;
  }
  return undefined;
}
