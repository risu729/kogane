import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { parseArgs } from "../src/cli.ts";
import { navigateGuarded } from "../src/navigation.ts";
import {
  BANK_ORIGIN,
  LOGIN_URL,
  PORTFOLIO_URL,
  classifyRoute,
  inspectPage,
  navigateFirstTransaction,
  navigatePortfolio,
  observeStops,
} from "../src/probe.ts";

describe("route and command boundaries", () => {
  test("recognizes only exact HTTPS bank routes", () => {
    expect(classifyRoute(PORTFOLIO_URL)).toBe("portfolio");
    expect(classifyRoute(BANK_ORIGIN + "/ibank/accountDetails.action?account=synthetic")).toBe(
      "transactions",
    );
    for (const url of [
      "https://ibanking.stgeorge.com.au.attacker.test/ibank/viewAccountPortfolio.html",
      "http://ibanking.stgeorge.com.au/ibank/viewAccountPortfolio.html",
      "https://user:secret@ibanking.stgeorge.com.au/ibank/viewAccountPortfolio.html",
      PORTFOLIO_URL + "#token",
      BANK_ORIGIN + "/ibank/payment.action",
      BANK_ORIGIN + "/ibank/accountDetails.action/",
      "not a URL",
    ])
      expect(classifyRoute(url)).toBe("unknown");
  });

  test("requires one explicit browser mode and local unauthenticated CDP endpoint", () => {
    expect(parseArgs(["--headed", "--transactions"]).transactions).toBe(true);
    expect(parseArgs(["--cdp", "http://127.0.0.1:9222"]).mode).toBe("cdp");
    for (const args of [
      [],
      ["--probe", "--headed"],
      ["--probe", "--transactions"],
      ["--cdp", "http://remote.test:9222"],
      ["--cdp", "http://secret@localhost:9222"],
      ["--cdp", "http://localhost:9222/?token=secret"],
      ["--password", "secret"],
    ])
      expect(() => parseArgs(args)).toThrow();
  });
});

describe("synthetic browser proof (no bank requests)", () => {
  let browser: Browser;
  beforeAll(async () => {
    browser = await chromium.launch({
      headless: true,
      ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
    });
  });
  afterAll(async () => {
    await browser?.close();
  });

  const secret = "SYNTHETIC_PRIVATE_729";
  const portfolio = `<ul id="acctSummaryList"><li data-currbal="${secret}">
    <h2><a href="/ibank/accountDetails.action?account=${secret}">${secret}</a></h2>
    <dl class="balance-details"><dd>${secret}</dd><dt class="available-balance">Available</dt><dd>${secret}</dd></dl>
    </li></ul>`;
  async function withPage(html: string, url: string, action: (page: Page) => Promise<void>) {
    const context = await browser.newContext();
    const page = await context.newPage();
    await context.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
    await page.goto(url);
    try {
      await action(page);
    } finally {
      await context.close();
    }
  }

  test("portfolio emits only counts, not account data or query material", async () => {
    await withPage(portfolio, PORTFOLIO_URL + "?session=" + secret, async (page) => {
      const report = await inspectPage(page);
      expect(report).toEqual({
        status: "portfolio-observed",
        route: "portfolio",
        selectorEvidence: "historical-third-party",
        containerPresent: true,
        accountCards: 1,
        currentBalanceFields: 1,
        availableBalanceFields: 1,
      });
      expect(JSON.stringify(report)).not.toContain(secret);
    });
  });

  test("HTTP 200 login masquerading as portfolio is not authenticated", async () => {
    await withPage(
      `<input name="userId" value="${secret}"><input name="securityNumber"><input name="password" type="password">`,
      PORTFOLIO_URL,
      async (page) => {
        const report = await inspectPage(page);
        expect(report.status).toBe("manual-login-required");
        expect(JSON.stringify(report)).not.toContain(secret);
        expect((await navigatePortfolio(page)).status).toBe("manual-login-required");
      },
    );
  });

  test("unknown and empty layouts are not successes", async () => {
    await withPage("<ul id=acctSummaryList></ul>", PORTFOLIO_URL, async (page) => {
      expect((await inspectPage(page)).status).toBe("unknown-layout");
    });
    await withPage(portfolio, BANK_ORIGIN + "/ibank/payment.action", async (page) => {
      expect(await inspectPage(page)).toEqual({
        status: "stopped",
        reason: "unexpected-route",
        route: "unknown",
      });
    });
  });

  test("challenge and expired sessions override apparent portfolio", async () => {
    for (const challenge of [
      "<h1>Access denied</h1>",
      "<div role=alert>Your session has expired</div>",
      "<input autocomplete=one-time-code>",
    ]) {
      await withPage(portfolio + challenge, PORTFOLIO_URL, async (page) => {
        expect((await inspectPage(page)).status).toBe("stopped");
      });
    }
  });

  test("observed bank request-error page stops without diagnostic leakage or retry", async () => {
    const requestError = `<title>Request Error | St.George</title>
      <h1>Request error</h1>
      <p>We’re sorry, this request can’t be completed.</p>
      <p>Note: If you are using a VPN or TOR network connection (anonymity network),
      please disconnect from the VPN or TOR network and retry your request.</p>
      <p>192.0.2.1 SYNTHETIC_REFERENCE_729</p>`;
    for (const [url, extra, route] of [
      [LOGIN_URL, "", "login"],
      [PORTFOLIO_URL, portfolio + '<input name="userId">', "portfolio"],
    ] as const) {
      await withPage(requestError + extra, url, async (page) => {
        let requests = 0;
        page.on("request", () => {
          requests += 1;
        });
        const report = await inspectPage(page);
        expect(report).toEqual({ status: "stopped", reason: "bank-request-error", route });
        expect(JSON.stringify(report)).not.toContain("192.0.2.1");
        expect(JSON.stringify(report)).not.toContain("SYNTHETIC_REFERENCE_729");
        expect(await navigatePortfolio(page)).toEqual(report);
        expect(requests).toBe(0);
      });
    }
  });

  test("denied response stops without returning response data", async () => {
    await withPage(portfolio, PORTFOLIO_URL, async (page) => {
      const stops = observeStops(page);
      try {
        await page.route(PORTFOLIO_URL, (route) => route.fulfill({ status: 403, body: secret }));
        await page.goto(PORTFOLIO_URL);
        expect(await inspectPage(page, stops.reason())).toEqual({
          status: "stopped",
          reason: "http-denied",
          route: "portfolio",
        });
      } finally {
        stops.dispose();
      }
    });
  });

  test("automates portfolio GET and observed account anchor GET only", async () => {
    await withPage(portfolio, PORTFOLIO_URL, async (page) => {
      const requests: { method: string; path: string }[] = [];
      await page.route("**/*", (route) => {
        requests.push({
          method: route.request().method(),
          path: new URL(route.request().url()).pathname,
        });
        const body = route.request().url().includes("accountDetails.action")
          ? `<button id=transHistExport>Export</button><table><tbody><tr><td>${secret}</td></tr></tbody></table>`
          : portfolio;
        return route.fulfill({ contentType: "text/html", body });
      });
      expect((await navigatePortfolio(page)).status).toBe("portfolio-observed");
      const report = await navigateFirstTransaction(page);
      expect(report.status).toBe("transaction-layout-candidate");
      expect(JSON.stringify(report)).not.toContain(secret);
      expect(requests).toEqual([
        { method: "GET", path: "/ibank/viewAccountPortfolio.html" },
        { method: "GET", path: "/ibank/accountDetails.action" },
      ]);
    });
  });

  test("rejects unknown or scripted account links without requesting them", async () => {
    await withPage(
      portfolio.replace("/ibank/accountDetails.action", "/ibank/payment.action"),
      PORTFOLIO_URL,
      async (page) => {
        let requests = 0;
        page.on("request", () => {
          requests += 1;
        });
        expect((await navigateFirstTransaction(page)).status).toBe("unknown-layout");
        expect(requests).toBe(0);
      },
    );
  });

  test("blocks redirected forbidden GET before any request reaches its server", async () => {
    let forbiddenHits = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        if (new URL(request.url).pathname === "/allowed") {
          return new Response(null, { status: 302, headers: { location: "/forbidden" } });
        }
        forbiddenHits += 1;
        return new Response("must not be reached");
      },
    });
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const allowed = new URL("/allowed", server.url).href;
      await expect(navigateGuarded(page, allowed, (url) => url === allowed)).rejects.toThrow();
      expect(forbiddenHits).toBe(0);
    } finally {
      await context.close();
      await server.stop(true);
    }
  });

  test("unknown authenticated-looking route is not navigated", async () => {
    await withPage("<p>Unrecognized layout</p>", PORTFOLIO_URL, async (page) => {
      let requests = 0;
      page.on("request", () => {
        requests += 1;
      });
      expect((await navigatePortfolio(page)).status).toBe("unknown-layout");
      expect(requests).toBe(0);
    });
  });

  test("transaction table alone is unverified, not a successful collection", async () => {
    await withPage(
      "<table><tbody><tr><td>synthetic</td></tr></tbody></table>",
      BANK_ORIGIN + "/ibank/accountDetails.action",
      async (page) => {
        expect((await inspectPage(page)).status).toBe("unknown-layout");
      },
    );
  });
});
