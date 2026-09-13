import type { Download, Page } from "playwright";
import { navigateGuarded } from "./navigation.ts";

export const BANK_ORIGIN = "https://ibanking.stgeorge.com.au";
export const LOGIN_URL = BANK_ORIGIN + "/ibank/loginPage.action";
export const PORTFOLIO_URL = BANK_ORIGIN + "/ibank/viewAccountPortfolio.html";

export type Route = "login" | "portfolio" | "transactions" | "unknown";

// Never return URLs: account identifiers and session material may be in queries.
export function classifyRoute(raw: string): Route {
  try {
    const url = new URL(raw);
    if (url.origin !== BANK_ORIGIN || url.username || url.password || url.hash) return "unknown";
    switch (url.pathname) {
      case "/ibank/loginPage.action":
        return "login";
      case "/ibank/viewAccountPortfolio.html":
        return "portfolio";
      case "/ibank/accountDetails.action":
        return "transactions";
      default:
        return "unknown";
    }
  } catch {
    return "unknown";
  }
}

export type StopReason = "http-denied" | "unexpected-route" | "download";

// Passive guards: no response body, header, cookie, URL or console capture.
// Human authentication requests are not intercepted or replayed.
export function observeStops(page: Page) {
  let reason: StopReason | null = null;
  const response = (event: { status(): number; url(): string }) => {
    if ([401, 403, 429].includes(event.status())) {
      try {
        if (new URL(event.url()).origin === BANK_ORIGIN) reason ??= "http-denied";
      } catch {
        reason ??= "unexpected-route";
      }
    }
  };
  const download = (event: Download) => {
    reason ??= "download";
    void event.cancel().catch(() => {});
  };
  page.on("response", response);
  page.on("download", download);
  return {
    reason: () => reason,
    dispose: () => {
      page.off("response", response);
      page.off("download", download);
    },
  };
}

// This function executes in the bank page. It returns only fixed keys, counts
// and booleans. In particular, no text/value/dataset/href leaves this function.
export function readDomMetadata() {
  const visible = (element: Element) => element.getClientRects().length > 0;
  const count = (selector: string) =>
    Array.from(document.querySelectorAll(selector)).filter(visible).length;
  // Observed on the official bank origin in the 2026-09-13 live attempt.
  // Only classify the fixed visible heading; never return diagnostic text.
  const bankRequestError = Array.from(document.querySelectorAll("h1"))
    .filter(visible)
    .some((element) => /^request\s+error$/i.test(element.textContent?.trim() ?? ""));
  const notice = Array.from(document.querySelectorAll("h1,h2,[role=alert],.error"))
    .filter(visible)
    .some((element) =>
      /captcha|access denied|verify your identity|unusual activity|unusual location|account locked|session (?:has )?expired|session invalid|logged out|signed out|secure code|one.time (?:code|password)|approve.*(?:app|device)/i.test(
        element.textContent ?? "",
      ),
    );
  const challenge =
    notice ||
    count(
      'iframe[src*="recaptcha"],iframe[src*="hcaptcha"],[id*="captcha"],input[autocomplete="one-time-code"]',
    ) > 0;
  const login = {
    accessNumber: count('input[name="userId"]') > 0,
    securityNumber: count('input[name="securityNumber"]') > 0,
    password: count('input[name="password"]') > 0,
  };
  const cards = Array.from(document.querySelectorAll("#acctSummaryList > li")).filter(visible);
  return {
    bankRequestError,
    challenge,
    login,
    publicLoginStructure: {
      visibleForms: count("form"),
      visibleInputs: count("input:not([type=hidden])"),
      passwordInputs: count('input[type="password"]'),
      visibleIframes: count("iframe"),
    },
    portfolio: {
      containerPresent: count("#acctSummaryList") > 0,
      accountCards: cards.length,
      currentBalanceFields: cards.filter(
        (card) => card.hasAttribute("data-currbal") || card.querySelector("dl.balance-details dd"),
      ).length,
      availableBalanceFields: cards.filter((card) =>
        card.querySelector("dt.available-balance + dd"),
      ).length,
    },
    transactions: {
      legacyExportControlPresent: count("#transHistExport") > 0,
      // Generic structures are not asserted to be transaction rows.
      visibleTables: count("table"),
      candidateDataRows: count("table tbody tr"),
      dateInputs: count('input[type="date"]'),
    },
  };
}

export async function inspectPage(page: Page, stopReason: StopReason | null = null) {
  const route = classifyRoute(page.url());
  if (stopReason) return { status: "stopped", reason: stopReason, route } as const;
  if (route === "unknown") return { status: "stopped", reason: "unexpected-route", route } as const;
  const metadata = await page.evaluate(readDomMetadata);
  if (metadata.bankRequestError)
    return { status: "stopped", reason: "bank-request-error", route } as const;
  if (metadata.challenge)
    return { status: "stopped", reason: "challenge-or-expired-session", route } as const;
  if (Object.values(metadata.login).some(Boolean)) {
    return { status: "manual-login-required", route, fieldsPresent: metadata.login } as const;
  }
  if (classifyRoute(page.url()) !== route)
    return { status: "stopped", reason: "unexpected-route", route: "unknown" } as const;
  if (route === "login")
    return { status: "unknown-layout", route, structure: metadata.publicLoginStructure } as const;
  if (
    route === "portfolio" &&
    metadata.portfolio.containerPresent &&
    metadata.portfolio.accountCards > 0
  ) {
    return {
      status: "portfolio-observed",
      route,
      selectorEvidence: "live-2026-09-13",
      ...metadata.portfolio,
    } as const;
  }
  if (route === "transactions" && metadata.transactions.legacyExportControlPresent) {
    return {
      status: "transaction-layout-candidate",
      route,
      selectorEvidence: "live-2026-09-13",
      ...metadata.transactions,
    } as const;
  }
  return { status: "unknown-layout", route } as const;
}

export type Report = Awaited<ReturnType<typeof inspectPage>>;

async function navigateReadOnly(page: Page, url: string) {
  await navigateGuarded(page, url, (candidate) => classifyRoute(candidate) !== "unknown");
}

export async function navigatePortfolio(page: Page) {
  // The user must already have completed authentication on a known page.
  const before = await inspectPage(page);
  if (before.status !== "portfolio-observed" && before.status !== "transaction-layout-candidate") {
    return before;
  }
  await navigateReadOnly(page, PORTFOLIO_URL);
  return inspectPage(page);
}

export function resolveAccountDetailsHref(raw: string): string | null {
  // Live 2026-09-13: this one-argument function only assigns document.location
  // after a duplicate-submit flag. Parse its exact observed literal shape;
  // never evaluate JavaScript or call the bank function.
  const scripted =
    /^javascript:viewAccountDetails\('(accountDetails\.action\?index=[0-9]+)'\)$/.exec(raw);
  try {
    const url = new URL(scripted?.[1] ?? raw, PORTFOLIO_URL);
    return classifyRoute(url.href) === "transactions" ? url.href : null;
  } catch {
    return null;
  }
}

export async function navigateFirstTransaction(page: Page) {
  const before = await inspectPage(page);
  if (before.status !== "portfolio-observed") return before;
  const links = await page.evaluate(() => {
    const links = Array.from(
      document.querySelectorAll<HTMLAnchorElement>("#acctSummaryList > li h2 a"),
    );
    return links
      .filter((link) => link.getClientRects().length > 0)
      .map((link) => link.getAttribute("href") ?? "");
  });
  const href = links.map(resolveAccountDetailsHref).find((candidate) => candidate !== null);
  if (!href) return { status: "unknown-layout", route: "portfolio" } as const;
  // Use only the real account-summary anchor; never invent account identifiers,
  // submit a form, replay a POST, or invoke an export control.
  await navigateReadOnly(page, href);
  return inspectPage(page);
}
