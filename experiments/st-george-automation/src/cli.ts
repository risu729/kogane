import { createInterface } from "node:readline/promises";
import { chromium, type Browser } from "playwright";
import {
  BANK_ORIGIN,
  LOGIN_URL,
  inspectPage,
  navigateFirstTransaction,
  navigatePortfolio,
  observeStops,
  type Report,
} from "./probe.ts";

export function parseArgs(args: string[]) {
  let mode: "probe" | "headed" | "cdp" | null = null;
  let endpoint: string | undefined;
  let transactions = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--transactions") {
      transactions = true;
      continue;
    }
    if (arg === "--cdp") {
      if (mode) throw new Error("invalid-options");
      mode = "cdp";
      endpoint = args[++index];
      if (!endpoint) throw new Error("invalid-options");
      const url = new URL(endpoint);
      if (
        url.protocol !== "http:" ||
        !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        url.pathname !== "/"
      )
        throw new Error("invalid-options");
      continue;
    }
    if (arg === "--probe" || arg === "--headed") {
      if (mode) throw new Error("invalid-options");
      mode = arg === "--probe" ? "probe" : "headed";
      continue;
    }
    throw new Error("invalid-options");
  }
  if (!mode || (mode === "probe" && transactions)) throw new Error("invalid-options");
  return { mode, endpoint, transactions };
}

function print(report: Report | { status: "stopped"; reason: string }) {
  process.stdout.write(JSON.stringify(report) + "\n");
}

export async function main(args: string[]) {
  let options;
  try {
    options = parseArgs(args);
  } catch {
    print({ status: "stopped", reason: "invalid-options" });
    return 2;
  }
  if (process.env.DEBUG || process.env.PWDEBUG) {
    // Playwright debug output can contain URLs and sensitive call parameters.
    print({ status: "stopped", reason: "disable-browser-debug-logging" });
    return 2;
  }
  let browser: Browser | undefined;
  let dispose = () => {};
  try {
    if (options.mode === "cdp") {
      browser = await chromium.connectOverCDP(options.endpoint!, { timeout: 15_000 });
    } else {
      browser = await chromium.launch({
        headless: options.mode === "probe",
        timeout: 30_000,
        ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
      });
    }
    const context =
      options.mode === "cdp"
        ? browser.contexts()[0]
        : await browser.newContext({ acceptDownloads: false });
    if (!context) throw new Error("browser-unavailable");
    const candidates = context.pages().filter((candidate) => {
      try {
        return new URL(candidate.url()).origin === BANK_ORIGIN;
      } catch {
        return false;
      }
    });
    if (options.mode === "cdp" && candidates.length !== 1) {
      print({ status: "stopped", reason: "expected-one-bank-tab" });
      return 2;
    }
    const page = options.mode === "cdp" ? candidates[0]! : await context.newPage();
    page.setDefaultTimeout(10_000);
    const stops = observeStops(page);
    dispose = stops.dispose;
    if (options.mode !== "cdp") {
      await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    }
    const initial = await inspectPage(page, stops.reason());
    print(initial);
    if (options.mode === "probe") {
      return initial.status === "manual-login-required" ? 0 : 2;
    }
    if (initial.status === "stopped") return 2;
    if (!process.stdin.isTTY) {
      print({ status: "stopped", reason: "interactive-terminal-required" });
      return 2;
    }
    const terminal = createInterface({ input: process.stdin, output: process.stderr });
    try {
      await terminal.question(
        "Complete normal login in the browser, then press Enter here. Stop if the bank shows a challenge or warning. Do not enter bank details in this terminal.\n",
        { signal: AbortSignal.timeout(300_000) },
      );
    } finally {
      terminal.close();
    }
    if (stops.reason()) {
      print(await inspectPage(page, stops.reason()));
      return 2;
    }
    const portfolio = await navigatePortfolio(page);
    if (stops.reason()) {
      print(await inspectPage(page, stops.reason()));
      return 2;
    }
    print(portfolio);
    if (portfolio.status !== "portfolio-observed") return 2;
    if (options.transactions) {
      const transaction = await navigateFirstTransaction(page);
      if (stops.reason()) {
        print(await inspectPage(page, stops.reason()));
        return 2;
      }
      print(transaction);
      return transaction.status === "transaction-layout-candidate" ? 0 : 2;
    }
    return 0;
  } catch {
    // Browser errors often contain request URLs and page snippets. Do not emit
    // error.message, stack, page content, screenshots, tracing or HAR.
    print({ status: "stopped", reason: "browser-or-navigation-failed" });
    return 2;
  } finally {
    dispose();
    // For CDP connections Playwright close disconnects without closing Chrome.
    await browser?.close().catch(() => {});
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
