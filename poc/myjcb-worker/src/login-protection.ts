import puppeteer, { type BrowserWorker } from "@cloudflare/puppeteer";
import { CookieJar } from "./cookie-jar";
import { allowedUrl, assertAllowedRequest, MYJCB_ORIGIN } from "./policy";
import type { PasswordCredential } from "./types";
import { HumanRequiredError, StopConditionError } from "./types";

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
    const page = pages[0] ?? await browser.newPage();
    await page.setViewport({ width: 1365, height: 768, deviceScaleFactor: 1 });
    await page.goto(allowedUrl("login-page").href, {
      waitUntil: "domcontentloaded",
      timeout: LOGIN_TIMEOUT_MS,
    });
    await assertNoHumanChallenge(await page.content(), page.url(), true);
    const form = await page.evaluate(() => {
      const element = document.querySelector<HTMLFormElement>('form[name="loginForm"][action]');
      return element
        ? { action: element.action, method: element.method || "get" }
        : undefined;
    });
    if (!form) throw new StopConditionError("MyJCB login form was not found");
    assertAllowedRequest("login-submit", form.method, form.action);

    const userSelector = 'input[name="userId"]';
    const passwordSelector = 'input[name="password"]';
    await page.waitForSelector(userSelector, { timeout: LOGIN_TIMEOUT_MS });
    await page.waitForSelector(passwordSelector, { timeout: LOGIN_TIMEOUT_MS });
    await page.type(userSelector, credential.userId, { delay: 25 });
    await page.type(passwordSelector, credential.password, { delay: 25 });

    const navigation = page.waitForNavigation({
      waitUntil: "domcontentloaded",
      timeout: LOGIN_TIMEOUT_MS,
    }).catch(() => null);
    await page.evaluate(() => {
      const formElement = document.querySelector<HTMLFormElement>(
        'form[name="loginForm"][action]',
      );
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

async function assertNoHumanChallenge(
  html: string,
  url: string,
  allowPasskeyChoice: boolean,
): Promise<void> {
  const text = html.replace(/<[^>]+>/gu, " ").replace(/\s+/gu, " ");
  const challenges: [RegExp, string][] = [
    [/(?:ワンタイムパスワード|認証コード|OTP)/iu, "otp"],
    [/(?:秘密の合い言葉|秘密の質問)/u, "secret-question"],
    [/(?:CAPTCHA|私はロボットではありません)/iu, "captcha"],
    [/(?:アクセスが制限|Access Denied|不正なアクセス)/iu, "access-denied"],
  ];
  if (!allowPasskeyChoice) challenges.unshift([/(?:パスキー|passkey)/iu, "passkey"]);
  for (const [pattern, reason] of challenges) {
    if (pattern.test(text)) throw new HumanRequiredError(reason);
  }
  const current = new URL(url);
  if (current.origin !== MYJCB_ORIGIN) {
    throw new StopConditionError(`MyJCB redirected to an unexpected origin: ${current.origin}`);
  }
}
