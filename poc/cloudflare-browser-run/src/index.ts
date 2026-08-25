import puppeteer from "@cloudflare/puppeteer";

const BASE_URL = "https://www.smbc-card.com";
const MYPAGE_PATH = "/memx/mypage/index.html";
const LOGIN_PAGE_PATH = "/mem/index.jsp";
const LOGIN_PATH = "/memapi/jaxrs/xt_login/agree/v1";
const LOGIN_FORM_SELECTOR = `form[action="${LOGIN_PATH}"]`;
const USER_ID_SELECTOR = "#id_input";
const PASSWORD_SELECTOR = "#pw_input";
const SUBMIT_SELECTOR = `${LOGIN_FORM_SELECTOR} input[type="submit"]`;
const PAGE_TIMEOUT_MILLISECONDS = 20_000;
const WINDOWS_CHROME_153_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36";

interface SafePageState {
  hostname: string;
  path: string;
  title: string;
  cookieNames: string[];
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

async function digest(value: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
}

async function validBearer(request: Request, expected: string): Promise<boolean> {
  const authorization = request.headers.get("authorization") ?? "";
  const provided = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length)
    : "";
  const [providedHash, expectedHash] = await Promise.all([
    digest(provided),
    digest(expected),
  ]);
  return crypto.subtle.timingSafeEqual(providedHash, expectedHash);
}

function safeUrl(value: string): { hostname: string; path: string } {
  const url = new URL(value);
  return { hostname: url.hostname, path: url.pathname };
}

async function safePageState(page: import("@cloudflare/puppeteer").Page): Promise<SafePageState> {
  const current = safeUrl(page.url());
  const cookies = await page.cookies();
  return {
    ...current,
    title: await page.title(),
    cookieNames: [...new Set(cookies.map((cookie) => cookie.name))].sort(),
  };
}

async function configurePage(page: import("@cloudflare/puppeteer").Page): Promise<void> {
  page.setDefaultNavigationTimeout(PAGE_TIMEOUT_MILLISECONDS);
  await page.setExtraHTTPHeaders({ "accept-language": "ja,en-US;q=0.9,en;q=0.8" });
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

async function inspectBrowser(env: Env): Promise<Response> {
  const browser = await puppeteer.launch(env.BROWSER);
  try {
    const page = await browser.newPage();
    await configurePage(page);
    const navigation = await page.goto(BASE_URL + LOGIN_PAGE_PATH, {
      waitUntil: "networkidle2",
    });
    const form = await page.$(LOGIN_FORM_SELECTOR);
    const browserState = await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      webdriver: Reflect.get(navigator, "webdriver") ?? null,
      language: navigator.language,
    }));
    return jsonResponse({
      mode: "inspect",
      navigationStatus: navigation?.status() ?? null,
      formFound: form !== null,
      browser: browserState,
      page: await safePageState(page),
    });
  } finally {
    await browser.close();
  }
}

async function loginWithBrowser(env: Env): Promise<Response> {
  const browser = await puppeteer.launch(env.BROWSER);
  let stage = "new-page";
  let loginPostSeen = false;
  try {
    const page = await browser.newPage();
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (request.method() === "POST" && url.hostname === "www.smbc-card.com" && url.pathname === LOGIN_PATH) {
        loginPostSeen = true;
      }
    });
    stage = "configure";
    await configurePage(page);
    stage = "mypage";
    await page.goto(BASE_URL + MYPAGE_PATH, { waitUntil: "domcontentloaded" });
    stage = "login-page";
    const loginPage = await page.goto(BASE_URL + LOGIN_PAGE_PATH, {
      waitUntil: "networkidle2",
    });
    stage = "selectors";
    await page.waitForSelector(USER_ID_SELECTOR, { timeout: 10_000 });
    await page.waitForSelector(PASSWORD_SELECTOR, { timeout: 10_000 });
    await page.waitForSelector(SUBMIT_SELECTOR, { timeout: 10_000 });

    stage = "fill";
    await page.type(USER_ID_SELECTOR, env.VPASS_ID, { delay: 45 });
    await page.type(PASSWORD_SELECTOR, env.VPASS_PASSWORD, { delay: 45 });

    stage = "submit";
    const loginResponsePromise = page.waitForResponse(
      (response) => new URL(response.url()).pathname === LOGIN_PATH,
      { timeout: PAGE_TIMEOUT_MILLISECONDS },
    );
    const navigationPromise = page
      .waitForNavigation({
        waitUntil: "domcontentloaded",
        timeout: PAGE_TIMEOUT_MILLISECONDS,
      })
      .catch(() => null);
    await page.click(SUBMIT_SELECTOR);
    const loginResponse = await loginResponsePromise;
    stage = "navigation";
    await navigationPromise;

    const headers = loginResponse.headers();
    const loginResult = headers["x-loginresult"] ?? null;
    const status = loginResponse.status();
    const authenticated = status >= 300 && status < 400 && loginResult === "0";
    return jsonResponse({
      mode: "login",
      loginPageStatus: loginPage?.status() ?? null,
      login: {
        status,
        loginResult,
        contentType: headers["content-type"] ?? null,
        location: headers["location"] ? safeUrl(new URL(headers["location"], BASE_URL).toString()) : null,
      },
      authenticated,
      page: await safePageState(page),
    });
  } catch (error) {
    return jsonResponse({
      mode: "login",
      error: "browser login probe failed",
      errorType: error instanceof Error ? error.name : "unknown",
      stage,
      loginPostSeen,
    });
  } finally {
    await browser.close();
  }
}

async function handleRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const enabled = typeof env.PROBE_TOKEN === "string" && env.PROBE_TOKEN.length >= 32;
  const hasCredentials =
    typeof env.VPASS_ID === "string" &&
    env.VPASS_ID.length > 0 &&
    typeof env.VPASS_PASSWORD === "string" &&
    env.VPASS_PASSWORD.length > 0;

  if (request.method === "GET" && url.pathname === "/" && url.search === "") {
    return jsonResponse({ enabled, hasCredentials: enabled && hasCredentials });
  }
  if (
    request.method !== "POST" ||
    url.search !== "" ||
    (url.pathname !== "/inspect" && url.pathname !== "/login")
  ) {
    return jsonResponse({ error: "not found" }, 404);
  }
  if (!enabled) return jsonResponse({ error: "probe disabled" }, 503);
  if (!(await validBearer(request, env.PROBE_TOKEN))) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  if (url.pathname === "/inspect") return inspectBrowser(env);
  if (!hasCredentials) return jsonResponse({ error: "credentials unavailable" }, 503);
  return loginWithBrowser(env);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "browser-probe-error",
          path: new URL(request.url).pathname,
          errorType: error instanceof Error ? error.name : "unknown",
        }),
      );
      return jsonResponse({ error: "browser probe failed" }, 502);
    }
  },
} satisfies ExportedHandler<Env>;
