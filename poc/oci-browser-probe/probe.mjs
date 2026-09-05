import { createInterface } from "node:readline";
import { chromium } from "playwright";

const modes = new Set(["chrome-launch", "chrome-cdp", "chromium-launch"]);
const mode = process.argv[2];
const authenticate = process.argv.includes("--auth");

if (!modes.has(mode)) {
  console.error("usage: node probe.mjs <chrome-launch|chrome-cdp|chromium-launch> [--auth]");
  process.exit(2);
}

const redactUrl = (value) => {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "invalid-url";
  }
};

const readCredentials = async () => {
  console.error("READY_FOR_CREDENTIALS");
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity, terminal: false });
  const iterator = input[Symbol.asyncIterator]();
  const id = (await iterator.next()).value;
  const password = (await iterator.next()).value;
  input.close();
  if (!id || !password) throw new Error("two credential lines are required");
  return { id, password };
};

const launch = async () => {
  if (mode === "chrome-cdp") {
    const endpoint = process.env.KOGANE_CDP_URL ?? "http://127.0.0.1:9222";
    const browser = await chromium.connectOverCDP(endpoint);
    const context = browser.contexts()[0];
    if (!context) throw new Error("CDP browser has no default context");
    return { browser, context };
  }

  const options = { headless: true, args: ["--disable-dev-shm-usage"] };
  if (mode === "chrome-launch") options.executablePath = "/usr/bin/google-chrome-stable";
  const browser = await chromium.launch(options);
  const context = await browser.newContext({ locale: "ja-JP", timezoneId: "Asia/Tokyo" });
  return { browser, context };
};

const result = { timestamp: new Date().toISOString(), mode, authenticate };

let browser;
let context;
let page;
let credentials;

try {
  ({ browser, context } = await launch());
  result.browserVersion = browser.version();
  page = await context.newPage();

  const traceResponse = await page.goto("https://www.cloudflare.com/cdn-cgi/trace", {
    waitUntil: "domcontentloaded",
    timeout: 30_000,
  });
  if (!traceResponse?.ok()) throw new Error(`Cloudflare trace failed: ${traceResponse?.status()}`);
  const trace = await page.locator("body").innerText();
  const fields = Object.fromEntries(
    trace
      .split("\n")
      .map((line) => line.split("=", 2))
      .filter((pair) => pair.length === 2),
  );
  result.egress = { ip: fields.ip, loc: fields.loc, warp: fields.warp, gateway: fields.gateway };

  result.runtime = await page.evaluate(() => ({
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    webdriver: navigator.webdriver,
    languages: navigator.languages,
  }));

  const loginPageResponse = await page.goto("https://www.smbc-card.com/mem/index.jsp", {
    waitUntil: "domcontentloaded",
    timeout: 45_000,
  });
  result.bootstrap = {
    status: loginPageResponse?.status(),
    url: redactUrl(page.url()),
    title: await page.title(),
    hasIdInput:
      (await page
        .locator("input#id_input, input[placeholder*='ID'], input[aria-label*='ID']")
        .count()) > 0,
    hasPasswordInput: (await page.locator("input[type='password']").count()) > 0,
  };

  if (authenticate) {
    credentials = await readCredentials();
    const idInput = page
      .locator("input#id_input, input[placeholder*='ID'], input[aria-label*='ID']")
      .first();
    const passwordInput = page.locator("input#pw_input, input[type='password']").first();
    await idInput.fill(credentials.id);
    await passwordInput.fill(credentials.password);
    credentials.id = "";
    credentials.password = "";
    credentials = undefined;

    const loginResponsePromise = page
      .waitForResponse(
        (response) => {
          try {
            return new URL(response.url()).pathname === "/memapi/jaxrs/xt_login/agree/v1";
          } catch {
            return false;
          }
        },
        { timeout: 30_000 },
      )
      .catch(() => undefined);
    await page.getByRole("button", { name: "ログイン", exact: true }).click();
    const loginResponse = await loginResponsePromise;
    await page.waitForTimeout(5_000);

    const bodyText = await page
      .locator("body")
      .innerText()
      .catch(() => "");
    result.login = {
      responseStatus: loginResponse?.status(),
      responseUrl: loginResponse ? redactUrl(loginResponse.url()) : undefined,
      loginResultHeader: loginResponse?.headers()["x-loginresult"],
      finalUrl: redactUrl(page.url()),
      title: await page.title(),
      authenticated:
        (await page.getByRole("link", { name: "ログアウト", exact: true }).count()) > 0 ||
        bodyText.includes("操作中のカードを変更する"),
      blocked: loginResponse?.status() === 403 || bodyText.includes("Access Denied"),
    };
  }

  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  result.error = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = 1;
} finally {
  if (credentials) {
    credentials.id = "";
    credentials.password = "";
  }
  await page?.close().catch(() => {});
  await browser?.close().catch(() => {});
}
