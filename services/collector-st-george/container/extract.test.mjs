import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chromium } from "playwright";
import { parseStGeorgeSnapshot } from "../../../packages/parsers/src/st-george-contract.ts";
import { extractAccountDetails, extractPortfolio } from "./extract.mjs";

const origin = "https://ibanking.stgeorge.com.au";
const identity =
  '<dl><dt class="bsb-number">BSB</dt><dd>123-456</dd><dt class="account-number">Account</dt><dd>12345678</dd></dl>';
const card =
  "<li>" +
  identity +
  '<h2><a href="javascript:viewAccountDetails(\'accountDetails.action?index=2\')">Synthetic account</a></h2><dl><dt class="account-balance">Current</dt><dd>$123.45</dd><dt class="available-balance">Available</dt><dd>$100.00</dd></dl></li>';
const history =
  '<table id="txnHistoryTable"><thead><tr><th>Date</th><th>Description</th><th>Category</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead><tbody><tr><td></td><td>Closing Balance</td><td></td><td></td><td></td><td>123.45</td></tr><tr><td>12/09/2026</td><td>Synthetic purchase</td><td>Other</td><td>1.00</td><td></td><td>123.45</td></tr><tr><td></td><td>Opening Balance</td><td></td><td></td><td></td><td>124.45</td></tr></tbody></table>';
const details =
  '<div id="accountDetailWrap">' +
  identity +
  '<div class="transaction-pending"><table><tbody><tr><td colspan="3">No Pending transactions found</td></tr></tbody></table></div><div id="transaction-all">' +
  history +
  '</div><div id="other-hidden-tab">' +
  history +
  "</div></div>";
let browser;
before(async () => {
  browser = await chromium.launch({
    headless: true,
    proxy: { server: "http://127.0.0.1:9" },
    ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  });
});
after(async () => {
  await browser?.close();
});
async function withPage(path, html, action) {
  const context = await browser.newContext();
  try {
    await context.route("**/*", (route) => route.fulfill({ contentType: "text/html", body: html }));
    const page = await context.newPage();
    await page.goto(origin + path);
    return await action(page);
  } finally {
    await context.close();
  }
}

test("hashes provider account identity consistently and parses only the canonical history table", async () => {
  const accounts = await withPage(
    "/ibank/viewAccountPortfolio.html",
    '<ul id="acctSummaryList">' + card + "</ul>",
    (page) => page.evaluate(extractPortfolio),
  );
  const detail = await withPage("/ibank/accountDetails.action?index=2", details, (page) =>
    page.evaluate(extractAccountDetails),
  );
  const expectedKey = createHash("sha256")
    .update(["st-george", "123456", "12345678"].join("\0"))
    .digest("hex");
  assert.equal(accounts[0].accountKey, expectedKey);
  assert.equal(detail.accountKey, expectedKey);
  assert.equal(detail.historyState, "observed");
  assert.equal(detail.pendingState, "empty");
  assert.equal(detail.transactions.length, 1);
  assert.equal(detail.openingBalanceText, "124.45");
  assert.equal(detail.closingBalanceText, "123.45");
  const { detailsUrl, ...account } = accounts[0];
  assert.equal(detailsUrl, origin + "/ibank/accountDetails.action?index=2");
  const snapshot = parseStGeorgeSnapshot({
    schema: "st-george-browser-v1",
    observedAt: "2026-09-13T00:00:00Z",
    currency: "AUD",
    currencyEvidence: "source-configured",
    accounts: [{ ...account, ...detail }],
  });
  assert.equal(snapshot.accounts[0].transactions[0].debitText, "1.00");
  assert.ok(!JSON.stringify(snapshot).includes("12345678"));
});

test("masked account identity and arbitrary scripted anchor are refused", async () => {
  for (const html of [
    card.replace("12345678", "XXXX5678"),
    card.replace("viewAccountDetails", "arbitraryFunction"),
  ]) {
    await withPage(
      "/ibank/viewAccountPortfolio.html",
      '<ul id="acctSummaryList">' + html + "</ul>",
      async (page) => {
        await assert.rejects(page.evaluate(extractPortfolio));
      },
    );
  }
});

test("a hidden account card cannot turn a partial portfolio into complete membership", async () => {
  const hidden = card.replace("<li>", '<li style="display:none">');
  await withPage(
    "/ibank/viewAccountPortfolio.html",
    '<ul id="acctSummaryList">' + card + hidden + "</ul>",
    async (page) => {
      await assert.rejects(page.evaluate(extractPortfolio), /st-george-portfolio-unrecognized/);
    },
  );
});

test("unrecognized populated pending rows and malformed history remain unknown", async () => {
  const changed = details
    .replace("No Pending transactions found", "Synthetic pending item")
    .replace('<div id="transaction-all">', '<div id="unrecognized-history">');
  const detail = await withPage("/ibank/accountDetails.action?index=2", changed, (page) =>
    page.evaluate(extractAccountDetails),
  );
  assert.equal(detail.pendingState, "unknown");
  assert.equal(detail.historyState, "unknown");
  assert.deepEqual(detail.transactions, []);
});
