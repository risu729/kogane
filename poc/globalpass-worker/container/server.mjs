import http from "node:http";
import { once } from "node:events";
import net from "node:net";
import { chromium } from "playwright";
import WebSocket from "ws";

const LOGIN_URL =
  "https://www.debit.vpass.ne.jp/p/login/RW1312010001?cc=01006";
const GLOBALPASS_HOST = "www.debit.vpass.ne.jp";
const TURNSTILE_HOST = "challenges.cloudflare.com";
const TURNSTILE_HELPER_HOST = "brunhild.challenges.cloudflare.com";
const RELAY_HOSTS = new Set([
  GLOBALPASS_HOST,
  TURNSTILE_HOST,
  TURNSTILE_HELPER_HOST,
]);
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const DAILY_MONTHS = 2;
let collecting = false;

async function writeLine(response, value) {
  if (!response.write(`${JSON.stringify(value)}\n`)) {
    await once(response, "drain");
  }
}

async function readJson(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_REQUEST_BYTES) throw new Error("request too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function validRequest(value) {
  return (
    value &&
    (value.mode === "daily" || value.mode === "backfill") &&
    typeof value.user === "string" &&
    value.user.length > 0 &&
    typeof value.password === "string" &&
    value.password.length > 0 &&
    typeof value.relayToken === "string" &&
    value.relayToken.length >= 32 &&
    typeof value.relayUrl === "string" &&
    value.relayUrl.startsWith("wss://")
  );
}

function startSocksRelay(relayToken, relayUrl) {
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    let phase = "greeting";
    let relay;

    const fail = () => {
      if (!socket.destroyed) socket.destroy();
      if (relay && relay.readyState < WebSocket.CLOSING) relay.close();
    };

    socket.on("data", (chunk) => {
      if (phase === "relay") {
        if (relay?.readyState === WebSocket.OPEN) relay.send(chunk);
        return;
      }
      buffer = Buffer.concat([buffer, chunk]);
      if (phase === "greeting") {
        if (buffer.length < 2) return;
        const methodCount = buffer[1];
        if (buffer.length < 2 + methodCount || buffer[0] !== 5) return fail();
        buffer = buffer.subarray(2 + methodCount);
        socket.write(Buffer.from([5, 0]));
        phase = "request";
      }
      if (phase !== "request" || buffer.length < 5) return;
      if (buffer[0] !== 5 || buffer[1] !== 1 || buffer[3] !== 3) return fail();
      const length = buffer[4];
      if (buffer.length < 7 + length) return;
      const hostname = buffer.subarray(5, 5 + length).toString("utf8");
      const offset = 5 + length;
      const port = buffer.readUInt16BE(offset);
      const remainder = buffer.subarray(offset + 2);
      if (!RELAY_HOSTS.has(hostname) || port !== 443) return fail();

      phase = "connecting";
      const target = new URL(relayUrl);
      target.searchParams.set("host", hostname);
      target.searchParams.set("port", String(port));
      relay = new WebSocket(target, {
        headers: { authorization: `Bearer ${relayToken}` },
      });
      relay.binaryType = "arraybuffer";
      relay.on("open", () => {
        socket.write(Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]));
        phase = "relay";
        if (remainder.length) relay.send(remainder);
      });
      relay.on("message", (data) => socket.write(Buffer.from(data)));
      relay.on("close", () => socket.end());
      relay.on("error", fail);
    });
    socket.on("error", fail);
    socket.on("close", () => {
      if (relay && relay.readyState < WebSocket.CLOSING) relay.close();
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve({
        port: address.port,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function normalizeMonth(label, value) {
  for (const candidate of [label, value]) {
    const match = candidate.match(/(20\d{2})\D*([01]?\d)/u);
    if (!match) continue;
    const month = Number(match[2]);
    if (month >= 1 && month <= 12) {
      return `${match[1]}-${String(month).padStart(2, "0")}`;
    }
  }
  return null;
}

async function findMonthSelect(page) {
  const choices = await page.locator("select").evaluateAll((selects) =>
    selects.map((select, index) => ({
      index,
      options: [...select.options].map((option) => ({
        label: option.textContent?.trim() ?? "",
        value: option.value,
      })),
    })),
  );
  const ranked = choices
    .map((choice) => ({
      ...choice,
      months: choice.options
        .map((option) => ({
          ...option,
          month: normalizeMonth(option.label, option.value),
        }))
        .filter((option) => option.month !== null),
    }))
    .sort((left, right) => right.months.length - left.months.length);
  if (!ranked[0] || ranked[0].months.length < 2) {
    throw new Error("GLOBAL PASS activity month selector was not found");
  }
  return ranked[0];
}

async function openActivity(page) {
  try {
    await findMonthSelect(page);
    return;
  } catch {
    // The home screen exposes an activity link, not the month selector.
  }
  const candidates = page.getByRole("link", { name: /ご利用明細|利用明細/u });
  const count = await candidates.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    if (!(await candidate.isVisible())) continue;
    await candidate.click();
    await page.waitForLoadState("domcontentloaded");
    return;
  }
  throw new Error("GLOBAL PASS activity link was not found after login");
}

async function visibleLoginButton(page) {
  const candidates = page.locator(
    "button[name=nablarch_form1_2],button[name=nablarch_form1_5]",
  );
  const count = await candidates.count();
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    if (await candidate.isVisible()) return candidate;
  }
  throw new Error("GLOBAL PASS visible login button was not found");
}

async function selectMonth(page, index, value) {
  const select = page.locator("select").nth(index);
  const changePost = page
    .waitForResponse(
      (response) =>
        new URL(response.url()).hostname === GLOBALPASS_HOST &&
        response.request().method() === "POST",
      { timeout: 2_500 },
    )
    .then(() => true)
    .catch(() => false);
  await select.selectOption(value);
  if (!(await changePost)) {
    const form = select.locator("xpath=ancestor::form[1]");
    if ((await form.count()) !== 1) {
      throw new Error("GLOBAL PASS month selector has no enclosing form");
    }
    const submits = form.locator(
      'button[type="submit"],input[type="submit"]',
    );
    let clicked = false;
    const count = await submits.count();
    for (let submitIndex = 0; submitIndex < count; submitIndex += 1) {
      const submit = submits.nth(submitIndex);
      if (!(await submit.isVisible())) continue;
      const label = (
        (await submit.textContent()) ??
        (await submit.getAttribute("value")) ??
        ""
      ).trim();
      if (!/表示|照会|検索|選択/u.test(label)) continue;
      await submit.click();
      clicked = true;
      break;
    }
    if (!clicked) {
      throw new Error(
        "GLOBAL PASS month selection did not POST and has no read-only submit control",
      );
    }
  }
  await page.waitForLoadState("domcontentloaded").catch(() => undefined);
  await page.waitForTimeout(1_500);
  const selected = await page.locator("select").nth(index).inputValue();
  if (selected !== value) {
    throw new Error("GLOBAL PASS month selection did not stick");
  }
}

async function signOut(page) {
  const candidates = page.getByRole("link", { name: /ログアウト/u });
  const count = await candidates.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    if (!(await candidate.isVisible().catch(() => false))) continue;
    await candidate.click().catch(() => undefined);
    await page.waitForLoadState("domcontentloaded").catch(() => undefined);
    return;
  }
}

async function collect(payload, response) {
  const socks = await startSocksRelay(payload.relayToken, payload.relayUrl);
  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
    proxy: {
      server: `socks5://127.0.0.1:${socks.port}`,
      bypass: `${TURNSTILE_HOST},${TURNSTILE_HELPER_HOST}`,
    },
  });
  let page;
  const networkDiagnostic = [];
  const recordNetwork = (value) => {
    if (networkDiagnostic.length < 24) networkDiagnostic.push(value);
  };
  try {
    const context = await browser.newContext({
      locale: "ja-JP",
      timezoneId: "Asia/Tokyo",
      viewport: { width: 1365, height: 768 },
    });
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (
        ["about:", "blob:", "data:"].includes(url.protocol) ||
        RELAY_HOSTS.has(url.hostname)
      ) {
        await route.continue();
      } else {
        await route.abort("blockedbyclient");
      }
    });
    page = await context.newPage();
    page.on("requestfailed", (request) => {
      const url = new URL(request.url());
      recordNetwork({
        event: "requestfailed",
        host: url.hostname,
        path: url.pathname.slice(0, 120),
        resourceType: request.resourceType(),
        error: request.failure()?.errorText?.slice(0, 100) ?? "unknown",
      });
    });
    page.on("response", (pageResponse) => {
      if (pageResponse.status() < 400) return;
      const url = new URL(pageResponse.url());
      recordNetwork({
        event: "http",
        host: url.hostname,
        path: url.pathname.slice(0, 120),
        status: pageResponse.status(),
      });
    });
    page.setDefaultTimeout(45_000);
    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
    try {
      await page.waitForFunction(() => {
        const input = document.querySelector("[name=cf-turnstile-response]");
        return Boolean(input && "value" in input && input.value.length > 20);
      });
    } catch (error) {
      const diagnostic = await page.evaluate(() => {
        const response = document.querySelector("[name=cf-turnstile-response]");
        const body = document.body?.innerText ?? "";
        return {
          urlHost: location.hostname,
          title: document.title.slice(0, 80),
          responseField: response?.tagName ?? null,
          responseLength:
            response && "value" in response ? response.value.length : 0,
          loginFormVisible: Boolean(document.querySelector("#usrId")),
          denied: /Access Denied|アクセスが拒否/iu.test(body),
          frames: [...document.querySelectorAll("iframe")]
            .map((frame) => {
              try {
                const url = new URL(frame.src);
                return { host: url.hostname, path: url.pathname.slice(0, 120) };
              } catch {
                return null;
              }
            })
            .filter(Boolean)
            .slice(0, 8),
        };
      });
      throw new Error(
        `GLOBAL PASS Turnstile token unavailable: ${JSON.stringify({ networkDiagnostic, ...diagnostic })}`,
        { cause: error },
      );
    }
    await page.locator("#usrId").fill(payload.user);
    await page.locator("#password").fill(payload.password);
    await (await visibleLoginButton(page)).click();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForTimeout(2_000);
    const body = await page.locator("body").innerText();
    if (/Access Denied|アクセスが拒否/iu.test(body)) {
      throw new Error("GLOBAL PASS login was denied by the edge");
    }
    if (await page.locator("#usrId").isVisible().catch(() => false)) {
      throw new Error("GLOBAL PASS login returned to the credential form");
    }

    await openActivity(page);
    const selector = await findMonthSelect(page);
    const byMonth = new Map();
    for (const option of selector.months) {
      if (!byMonth.has(option.month)) byMonth.set(option.month, option.value);
    }
    const availableMonths = [...byMonth.keys()].sort().reverse();
    const selectedMonths =
      payload.mode === "backfill"
        ? availableMonths
        : availableMonths.slice(0, DAILY_MONTHS);
    await writeLine(response, {
      type: "metadata",
      availableMonths,
      selectedMonths,
      browserVersion: browser.version(),
    });
    for (const month of selectedMonths) {
      await selectMonth(page, selector.index, byMonth.get(month));
      const html = await page.content();
      if (Buffer.byteLength(html) > MAX_HTML_BYTES) {
        throw new Error(`${month} activity HTML exceeded byte limit`);
      }
      await writeLine(response, { type: "artifact", month, html });
    }
    await signOut(page);
  } finally {
    try {
      await browser.close();
    } finally {
      await socks.close();
    }
  }
}

http
  .createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
      return;
    }
    if (request.method !== "POST" || request.url !== "/collect") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"not found"}');
      return;
    }
    if (collecting) {
      response.writeHead(409, { "content-type": "application/json" });
      response.end('{"error":"collection already running"}');
      return;
    }
    collecting = true;
    try {
      const payload = await readJson(request);
      if (!validRequest(payload)) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end('{"error":"invalid collection request"}');
        return;
      }
      response.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "cache-control": "no-store",
      });
      try {
        await collect(payload, response);
      } catch (error) {
        await writeLine(response, {
          type: "error",
          errorType: error instanceof Error ? error.name : "UnknownError",
          message:
            error instanceof Error ? error.message : "Collection failed",
        });
      }
      response.end();
    } catch {
      if (!response.headersSent) {
        response.writeHead(400, { "content-type": "application/json" });
      }
      response.end('{"error":"invalid request"}');
    } finally {
      collecting = false;
    }
  })
  .listen(8080, "0.0.0.0");
