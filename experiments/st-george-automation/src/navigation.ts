import type { Page } from "playwright";

// Playwright page.route only sees the first URL in a redirect chain.
// Chromium Fetch pauses every document request, including redirect hops,
// before it reaches the network. This does not fetch/replay response bodies.
export async function navigateGuarded(page: Page, url: string, allowed: (url: string) => boolean) {
  const session = await page.context().newCDPSession(page);
  const { frameTree } = await session.send("Page.getFrameTree");
  let guardFailed = false;
  const pending: Promise<void>[] = [];
  const guard = (event: {
    requestId: string;
    frameId: string;
    request: { method: string; url: string };
  }) => {
    const blocked =
      event.frameId === frameTree.frame.id &&
      (event.request.method !== "GET" || !allowed(event.request.url));
    pending.push(
      session
        .send(
          blocked ? "Fetch.failRequest" : "Fetch.continueRequest",
          blocked
            ? { requestId: event.requestId, errorReason: "BlockedByClient" }
            : { requestId: event.requestId },
        )
        .then(
          () => {},
          () => {
            guardFailed = true;
          },
        ),
    );
  };
  session.on("Fetch.requestPaused", guard);
  try {
    await session.send("Fetch.enable", {
      patterns: [{ resourceType: "Document", requestStage: "Request" }],
    });
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
    if (guardFailed) throw new Error("navigation-guard-failed");
  } finally {
    await Promise.allSettled(pending);
    session.off("Fetch.requestPaused", guard);
    await session.send("Fetch.disable").catch(() => {});
    await session.detach().catch(() => {});
  }
}
