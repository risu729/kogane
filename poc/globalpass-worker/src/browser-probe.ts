import puppeteer, { type Page } from "@cloudflare/puppeteer";

const LOGIN_URL =
  "https://www.debit.vpass.ne.jp/p/login/RW1312010001?cc=01006";
const GLOBALPASS_HOST = "www.debit.vpass.ne.jp";
const USER_ID_SELECTOR = "#usrId";
const PASSWORD_SELECTOR = "#password";
const SUBMIT_SELECTOR =
  "button[name=nablarch_form1_2],button[name=nablarch_form1_5]";
const TURNSTILE_SELECTOR = "[name=cf-turnstile-response]";
const TURNSTILE_HOSTS = new Set([
  "challenges.cloudflare.com",
  "brunhild.challenges.cloudflare.com",
]);
const PAGE_TIMEOUT_MS = 20_000;
const TURNSTILE_TIMEOUT_MS = 30_000;
const WINDOWS_CHROME_153_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

type NetworkDiagnostic = {
  event: "http" | "request" | "requestfailed";
  host: string;
  path: string;
  method?: string;
  resourceType?: string;
  status?: number;
  error?: string;
};

function safeUrl(value: string): { host: string; path: string } {
  const url = new URL(value);
  let path = url.pathname.slice(0, 160);
  if (TURNSTILE_HOSTS.has(url.hostname)) {
    if (path.startsWith("/cdn-cgi/challenge-platform/")) {
      path = "/cdn-cgi/challenge-platform/<redacted>";
    } else if (path.startsWith("/turnstile/v0/b/")) {
      path = "/turnstile/v0/b/<build>/api.js";
    }
  }
  return { host: url.hostname, path };
}

async function configurePage(page: Page): Promise<void> {
  page.setDefaultNavigationTimeout(PAGE_TIMEOUT_MS);
  await page.setViewport({ width: 1365, height: 768 });
  await page.setExtraHTTPHeaders({
    "accept-language": "ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7",
  });
  await page.setUserAgent(WINDOWS_CHROME_153_USER_AGENT, {
    brands: [
      { brand: "Not_A Brand", version: "99" },
      { brand: "Chromium", version: "153" },
      { brand: "Google Chrome", version: "153" },
    ],
    fullVersionList: [
      { brand: "Not_A Brand", version: "99.0.0.0" },
      { brand: "Chromium", version: "153.0.0.0" },
      { brand: "Google Chrome", version: "153.0.0.0" },
    ],
    fullVersion: "153.0.0.0",
    platform: "Windows",
    platformVersion: "10.0.0",
    architecture: "x86",
    bitness: "64",
    model: "",
    mobile: false,
  });
}

function observeNetwork(page: Page, diagnostics: NetworkDiagnostic[]): void {
  const record = (value: NetworkDiagnostic): void => {
    if (diagnostics.length < 32) diagnostics.push(value);
  };
  page.on("request", (request) => {
    const target = safeUrl(request.url());
    if (!TURNSTILE_HOSTS.has(target.host)) return;
    record({
      event: "request",
      ...target,
      method: request.method(),
      resourceType: request.resourceType(),
    });
  });
  page.on("requestfailed", (request) => {
    const target = safeUrl(request.url());
    record({
      event: "requestfailed",
      ...target,
      error: request.failure()?.errorText.slice(0, 120) ?? "unknown",
    });
  });
  page.on("response", (response) => {
    const target = safeUrl(response.url());
    if (response.status() < 400 && !TURNSTILE_HOSTS.has(target.host)) return;
    record({ event: "http", ...target, status: response.status() });
  });
}

async function safePageState(page: Page): Promise<Record<string, unknown>> {
  const current = safeUrl(page.url());
  const cookies = await page.cookies();
  const state = await page.evaluate(
    (userSelector, turnstileSelector) => {
      const body = document.body?.innerText ?? "";
      const turnstile = document.querySelector(turnstileSelector);
      return {
        title: document.title.slice(0, 100),
        loginFormVisible: Boolean(document.querySelector(userSelector)),
        turnstileField: turnstile?.tagName ?? null,
        turnstileResponseLength:
          turnstile && "value" in turnstile
            ? String(turnstile.value).length
            : 0,
        turnstileContainerPresent: Boolean(
          document.querySelector(".cf-turnstile"),
        ),
        turnstileContainerText: (
          document.querySelector(".cf-turnstile")?.textContent ?? ""
        )
          .trim()
          .slice(0, 120),
        accessDenied: /Access Denied|アクセスが拒否/iu.test(body),
        frames: Array.from(document.querySelectorAll("iframe"))
          .map((frame) => {
            try {
              const url = new URL(frame.src);
              return { host: url.hostname, path: url.pathname.slice(0, 160) };
            } catch {
              return null;
            }
          })
          .filter(Boolean)
          .slice(0, 8),
      };
    },
    USER_ID_SELECTOR,
    TURNSTILE_SELECTOR,
  );
  return {
    ...current,
    ...state,
    pageFrames: page
      .frames()
      .map((frame) => safeUrl(frame.url()))
      .filter((frame) => frame.host.length > 0)
      .slice(0, 8),
    cookieNames: [...new Set(cookies.map((cookie) => cookie.name))].sort(),
  };
}

async function visibleSubmit(page: Page) {
  const candidates = await page.$$(SUBMIT_SELECTOR);
  for (const candidate of candidates) {
    const visible = await candidate.evaluate((element) => {
      const html = element as HTMLElement;
      const style = getComputedStyle(html);
      const rect = html.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        rect.width > 0 &&
        rect.height > 0
      );
    });
    if (visible) return candidate;
  }
  throw new Error("GLOBAL PASS visible login button was not found");
}

export async function runGlobalPassBrowserProbe(
  env: Env,
): Promise<Record<string, unknown>> {
  const browserEndpoint = {
    fetch: env.BROWSER.fetch.bind(env.BROWSER),
  };
  const browser = await puppeteer.launch(
    browserEndpoint as Parameters<typeof puppeteer.launch>[0],
  );
  const diagnostics: NetworkDiagnostic[] = [];
  let stage = "new-page";
  let credentialPostAttempted = false;
  try {
    const page = await browser.newPage();
    observeNetwork(page, diagnostics);
    stage = "configure";
    await configurePage(page);
    stage = "login-page";
    const navigation = await page.goto(LOGIN_URL, {
      waitUntil: "domcontentloaded",
    });
    stage = "turnstile";
    let turnstileReady = false;
    try {
      await page.waitForFunction(
        (selector) => {
          const input = document.querySelector(selector);
          return Boolean(
            input && "value" in input && String(input.value).length > 20,
          );
        },
        { timeout: TURNSTILE_TIMEOUT_MS },
        TURNSTILE_SELECTOR,
      );
      turnstileReady = true;
    } catch {
      // The safe result below records that no token became available.
    }

    const browserState = await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      webdriver: Reflect.get(navigator, "webdriver") ?? null,
      language: navigator.language,
    }));
    const beforeLogin = await safePageState(page);
    if (!turnstileReady) {
      return {
        mode: "login",
        stage,
        loginPageStatus: navigation?.status() ?? null,
        turnstileReady,
        credentialPostAttempted,
        authenticated: false,
        browser: browserState,
        page: beforeLogin,
        network: diagnostics,
      };
    }

    stage = "fill";
    await page.waitForSelector(USER_ID_SELECTOR, { timeout: 5_000 });
    await page.waitForSelector(PASSWORD_SELECTOR, { timeout: 5_000 });
    await page.type(USER_ID_SELECTOR, env.GLOBALPASS_ID, { delay: 45 });
    await page.type(PASSWORD_SELECTOR, env.GLOBALPASS_PASSWORD, { delay: 45 });
    const submit = await visibleSubmit(page);

    stage = "submit";
    const postResponse = page.waitForResponse(
      (response) => {
        const url = new URL(response.url());
        return (
          response.request().method() === "POST" &&
          url.hostname === GLOBALPASS_HOST
        );
      },
      { timeout: PAGE_TIMEOUT_MS },
    );
    const navigationAfterLogin = page
      .waitForNavigation({ waitUntil: "domcontentloaded", timeout: PAGE_TIMEOUT_MS })
      .catch(() => null);
    credentialPostAttempted = true;
    await submit.click();
    const loginResponse = await postResponse;
    await navigationAfterLogin;
    stage = "result";
    const headers = loginResponse.headers();
    const pageState = await safePageState(page);
    const authenticated =
      pageState["loginFormVisible"] === false &&
      pageState["accessDenied"] === false;
    return {
      mode: "login",
      stage,
      loginPageStatus: navigation?.status() ?? null,
      turnstileReady,
      credentialPostAttempted,
      login: {
        status: loginResponse.status(),
        target: safeUrl(loginResponse.url()),
        contentType: headers["content-type"] ?? null,
        location: headers["location"]
          ? safeUrl(new URL(headers["location"], LOGIN_URL).toString())
          : null,
      },
      authenticated,
      browser: browserState,
      page: pageState,
      network: diagnostics,
    };
  } catch (error) {
    return {
      mode: "login",
      stage,
      credentialPostAttempted,
      authenticated: false,
      error: "GLOBAL PASS Browser Run probe failed",
      errorType: error instanceof Error ? error.name : "UnknownError",
      network: diagnostics,
    };
  } finally {
    await browser.close();
  }
}
