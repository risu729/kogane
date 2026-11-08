import { once } from "node:events";
import { createBrowserDiagnostics } from "./diagnostics.mjs";
import { obtainChallengeToken } from "./challenge.mjs";
import { signOut } from "./logout.mjs";
import { CollectorFailure, failureCode } from "./failure.mjs";

const DAILY_MONTHS = 2;
// The Turnstile token is waited for at most this long per attempt, and the
// login page is loaded afresh for each of at most CHALLENGE_ATTEMPTS attempts
// (no credential is sent before a token exists). Observed 2026-11-05..07: the
// token came after 25 s once and not within 45 s twice; a fresh page gets a
// fresh challenge instead of waiting on a stuck one.
const CHALLENGE_ATTEMPTS = 3;
const CHALLENGE_ATTEMPT_TIMEOUT_MS = 45_000;
export async function writeLine(response, value) {
  if (!response.write(`${JSON.stringify(value)}\n`)) {
    await once(response, "drain");
  }
}

/**
 * Runs one collection. A failure is answered with one closed `error` record:
 * the failure code (`failure.mjs`), the stage it failed in, how many challenge
 * attempts were made and the last HTTP error status the page saw. No message,
 * URL or provider text.
 */
export async function collect(payload, response, deps) {
  const diagnostics = createBrowserDiagnostics(payload.relayUrl);
  const lastHttpError = { status: null, host: null, seen: 0 };
  const challenge = { attempts: 0 };
  try {
    await diagnostics.step("collection", () =>
      collectBrowser(payload, response, diagnostics, lastHttpError, challenge, deps),
    );
  } catch (error) {
    const stage = diagnostics.failedStage;
    const attempts =
      error instanceof CollectorFailure && Number.isInteger(error.attempts)
        ? error.attempts
        : challenge.attempts;
    await writeLine(response, {
      type: "error",
      operation: "browser-collection",
      errorType: error instanceof Error ? error.name : "UnknownError",
      errorCode: failureCode(error, stage),
      ...(stage ? { stage } : {}),
      challengeAttempts: attempts,
      // The Worker admits 400-599 only; a status outside it (Chrome accepts
      // up to 999) would turn this record into a contract failure.
      ...(Number.isInteger(lastHttpError.status) &&
      lastHttpError.status >= 400 &&
      lastHttpError.status <= 599
        ? { lastHttpStatus: lastHttpError.status }
        : {}),
    });
  }
}

async function collectBrowser(payload, response, diagnostics, lastHttpError, challenge, deps) {
  const { startRelay, launchBrowser, pageSteps, config } = deps;
  const { openActivity, findMonthSelect, selectMonth, walkActivityPages, visibleLoginButton } =
    pageSteps;
  const relay = await diagnostics.step("relay-start", () =>
    startRelay({
      relayToken: payload.relayToken,
      relayUrl: payload.relayUrl,
      allowedHosts: config.allowedHosts,
    }),
  );
  let launched;
  try {
    launched = await diagnostics.step("browser-launch", () => launchBrowser(relay.port));
  } catch (error) {
    // The relay must not outlive a browser that never started.
    diagnostics.relaySummary(relay.stats());
    await relay.close().catch(() => undefined);
    throw error;
  }
  const { browser, context } = launched;
  let page;
  // A flag, not `primaryError !== undefined`: `throw undefined` is still a failure.
  let failed = false;
  let primaryError;
  try {
    await context.route("**/*", async (route) => {
      const url = new URL(route.request().url());
      if (
        ["about:", "blob:", "data:"].includes(url.protocol) ||
        config.allowedHosts.has(url.hostname)
      ) {
        await route.continue();
      } else {
        await route.abort("blockedbyclient");
      }
    });
    page = await context.newPage();
    page.on("response", (pageResponse) => {
      if (pageResponse.status() < 400) return;
      diagnostics.http(pageResponse.status());
      const url = new URL(pageResponse.url());
      lastHttpError.status = pageResponse.status();
      lastHttpError.host = config.httpHostClass(url.hostname);
      lastHttpError.seen += 1;
    });
    page.setDefaultTimeout(45_000);
    // The first challenge attempt counts the login page's own HTTP errors.
    const httpSeenAtLoginPage = lastHttpError.seen;
    await diagnostics.step("login-page", () =>
      page.goto(config.loginUrl, { waitUntil: "domcontentloaded" }),
    );
    const challengeAttempts = await diagnostics.step("challenge", () =>
      obtainChallengeToken(page, {
        diagnostics,
        lastHttpError,
        loginUrl: config.loginUrl,
        attempts: CHALLENGE_ATTEMPTS,
        attemptTimeoutMs: CHALLENGE_ATTEMPT_TIMEOUT_MS,
        httpSeenAtStart: httpSeenAtLoginPage,
        onAttempt: (attempt) => {
          challenge.attempts = attempt;
        },
      }),
    );
    challenge.attempts = challengeAttempts;
    await diagnostics.step("login-submit", async () => {
      await page.locator("#usrId").fill(payload.user);
      await page.locator("#password").fill(payload.password);
      await (await visibleLoginButton(page)).click();
      await page.waitForLoadState("domcontentloaded");
      await page.waitForTimeout(2_000);
      const body = await page.locator("body").innerText();
      if (/Access Denied|アクセスが拒否/iu.test(body)) {
        throw new CollectorFailure(
          "globalpass_login_denied",
          "GLOBAL PASS login was denied by the edge",
        );
      }
      if (
        await page
          .locator("#usrId")
          .isVisible()
          .catch(() => false)
      ) {
        throw new CollectorFailure(
          "globalpass_login_rejected",
          "GLOBAL PASS login returned to the credential form",
        );
      }
    });

    await diagnostics.step("activity-open", () => openActivity(page));
    const selector = await diagnostics.step("month-discovery", () => findMonthSelect(page));
    const byMonth = new Map();
    for (const option of selector.months) {
      if (!byMonth.has(option.month)) byMonth.set(option.month, option.value);
    }
    const availableMonths = [...byMonth.keys()].sort().reverse();
    const selectedMonths =
      payload.mode === "backfill" ? availableMonths : availableMonths.slice(0, DAILY_MONTHS);
    await writeLine(response, {
      type: "metadata",
      runtimeRevision: config.runtimeRevision,
      availableMonths,
      selectedMonths,
      browserVersion: browser.version(),
    });
    for (const month of selectedMonths) {
      await diagnostics.step("statement-read", async () => {
        // Selecting a month renders its page 1 (switching month resets the
        // pager, observed 2026-10-04); the walk sends that page and the rest.
        await selectMonth(page, selector.index, byMonth.get(month));
        await walkActivityPages(page, response, month);
      });
    }
    await writeLine(response, await signOut(page, diagnostics));
  } catch (error) {
    failed = true;
    primaryError = error;
  }
  // A teardown failure is logged, but it never replaces the failure that
  // ended the run, nor takes over its stage.
  const blame = !failed;
  let teardownFailed = false;
  let teardownError;
  try {
    await diagnostics.step("browser-close", () => launched.close(), { blame });
  } catch (error) {
    if (!teardownFailed) teardownError = error;
    teardownFailed = true;
  }
  diagnostics.relaySummary(relay.stats());
  try {
    await diagnostics.step("relay-close", () => relay.close(), { blame });
  } catch (error) {
    if (!teardownFailed) teardownError = error;
    teardownFailed = true;
  }
  if (failed) throw primaryError;
  if (teardownFailed) throw teardownError;
}
