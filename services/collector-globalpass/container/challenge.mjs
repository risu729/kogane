import { CollectorFailure } from "./failure.mjs";

const TURNSTILE_HOST = "challenges.cloudflare.com";

async function challengeState(page) {
  return page.evaluate(() => {
    const input = document.querySelector("[name=cf-turnstile-response]");
    const body = document.body?.innerText ?? "";
    return {
      tokenLength: input && "value" in input ? input.value.length : 0,
      denied: /Access Denied|アクセスが拒否/iu.test(body),
    };
  });
}

/**
 * Waits for the Turnstile token, loading the login page afresh for each
 * attempt after the first. Returns the attempt that got a token. Each attempt
 * is logged with a closed code. Throws `globalpass_challenge_denied` when the
 * edge refuses the page (no retry: a refusal is not a slow widget) and
 * `globalpass_challenge_timeout` when no attempt got a token.
 */
export async function obtainChallengeToken(
  page,
  {
    diagnostics,
    lastHttpError,
    loginUrl,
    attempts,
    attemptTimeoutMs,
    httpSeenAtStart = lastHttpError.seen,
    onAttempt = () => undefined,
  },
) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    onAttempt(attempt);
    const startedAt = Date.now();
    // Attempt 1 counts from before the login page loaded, a retry from its reload.
    const seenBefore = attempt === 1 ? httpSeenAtStart : lastHttpError.seen;
    if (attempt > 1) {
      try {
        await page.goto(loginUrl, { waitUntil: "domcontentloaded" });
      } catch (error) {
        throw Object.assign(
          new CollectorFailure(
            "globalpass_login_page_failed",
            "GLOBAL PASS login page reload failed",
            {
              name: error instanceof Error ? error.name : "Error",
              cause: error,
            },
          ),
          { attempts: attempt },
        );
      }
    }
    let waitError;
    try {
      await page.waitForFunction(
        () => {
          const input = document.querySelector("[name=cf-turnstile-response]");
          return Boolean(input && "value" in input && input.value.length > 20);
        },
        undefined,
        { timeout: attemptTimeoutMs },
      );
    } catch (error) {
      waitError = error;
    }
    const turnstileFrames = page.frames().filter((frame) => {
      try {
        return new URL(frame.url()).hostname === TURNSTILE_HOST;
      } catch {
        return false;
      }
    }).length;
    const state = waitError ? await challengeState(page).catch(() => null) : null;
    const code = !waitError
      ? "token"
      : state === null
        ? "page-unreadable"
        : state.denied
          ? "edge-denied"
          : turnstileFrames === 0
            ? "widget-missing"
            : "token-timeout";
    diagnostics.challengeAttempt({
      attempt,
      elapsedMs: Date.now() - startedAt,
      code,
      // Only an HTTP error seen during this attempt.
      lastHttpStatus: lastHttpError.seen > seenBefore ? lastHttpError.status : null,
      lastHttpHost: lastHttpError.seen > seenBefore ? lastHttpError.host : null,
      turnstileFrames,
    });
    if (code === "token") return attempt;
    if (code === "edge-denied") {
      throw Object.assign(
        new CollectorFailure("globalpass_challenge_denied", "GLOBAL PASS login page was denied", {
          cause: waitError,
        }),
        { attempts: attempt },
      );
    }
    // A closed page or browser is not a slow widget: stop instead of retrying.
    if (!(waitError instanceof Error) || waitError.name !== "TimeoutError") {
      throw Object.assign(
        new CollectorFailure(
          "globalpass_challenge_failed",
          "GLOBAL PASS Turnstile wait ended without a token",
          {
            name: waitError instanceof Error ? waitError.name : "Error",
            cause: waitError,
          },
        ),
        { attempts: attempt },
      );
    }
  }
  throw Object.assign(
    new CollectorFailure(
      "globalpass_challenge_timeout",
      "GLOBAL PASS Turnstile token unavailable",
      { name: "TimeoutError" },
    ),
    { attempts },
  );
}
