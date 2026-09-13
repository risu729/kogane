// These functions are serialized by Playwright into the page. Keep them
// self-contained: no module closures, network calls, eval or bank JS invocation.
export async function extractPortfolio() {
  const fail = () => {
    throw new Error("st-george-portfolio-unrecognized");
  };
  if (
    location.origin !== "https://ibanking.stgeorge.com.au" ||
    location.pathname !== "/ibank/viewAccountPortfolio.html"
  )
    fail();
  const clean = (element) => element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  const visible = (element) => element.getClientRects().length > 0;
  if (
    Array.from(document.querySelectorAll("h1"))
      .filter(visible)
      .some((h) => /^request error$/i.test(clean(h)))
  )
    fail();
  const cards = Array.from(document.querySelectorAll("#acctSummaryList > li"));
  // A hidden/collapsed card cannot silently disappear from a complete balance
  // snapshot. Require the whole source list to be present and inspectable.
  if (cards.some((card) => !visible(card))) fail();
  if (cards.length < 1 || cards.length > 20) fail();
  const accounts = [];
  for (const card of cards) {
    const bsbText = clean(card.querySelector("dt.bsb-number + dd"));
    const numberText = clean(card.querySelector("dt.account-number + dd"));
    if (!/^[\d\s-]+$/.test(bsbText) || !/^[\d\s-]+$/.test(numberText)) fail();
    const bsb = bsbText.replace(/\D/g, "");
    const number = numberText.replace(/\D/g, "");
    if (bsb.length !== 6 || number.length < 4 || number.length > 16) fail();
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode("st-george\0" + bsb + "\0" + number),
    );
    const accountKey = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const anchor = card.querySelector("h2 a");
    const raw = anchor?.getAttribute("href") ?? "";
    const match =
      /^javascript:viewAccountDetails\('(accountDetails\.action\?index=[0-9]+)'\)$/.exec(raw);
    const url = new URL(
      match?.[1] ?? raw,
      "https://ibanking.stgeorge.com.au/ibank/viewAccountPortfolio.html",
    );
    if (
      url.origin !== location.origin ||
      url.pathname !== "/ibank/accountDetails.action" ||
      url.username ||
      url.password ||
      url.hash ||
      Array.from(url.searchParams.keys()).join() !== "index" ||
      !/^\d+$/.test(url.searchParams.get("index") ?? "")
    )
      fail();
    const currentBalanceText = clean(card.querySelector("dt.account-balance + dd"));
    const availableBalanceText = clean(card.querySelector("dt.available-balance + dd"));
    if (!currentBalanceText || !availableBalanceText) fail();
    accounts.push({
      accountKey,
      label: clean(anchor),
      currentBalanceText,
      availableBalanceText,
      detailsUrl: url.href,
    });
  }
  if (new Set(accounts.map((account) => account.accountKey)).size !== accounts.length) fail();
  return accounts;
}

export async function extractAccountDetails() {
  const fail = () => {
    throw new Error("st-george-details-unrecognized");
  };
  if (
    location.origin !== "https://ibanking.stgeorge.com.au" ||
    location.pathname !== "/ibank/accountDetails.action"
  )
    fail();
  const clean = (element) => element?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  const root = document.querySelector("#accountDetailWrap");
  if (!root) fail();
  const bsbText = clean(root.querySelector("dt.bsb-number + dd"));
  const numberText = clean(root.querySelector("dt.account-number + dd"));
  if (!/^[\d\s-]+$/.test(bsbText) || !/^[\d\s-]+$/.test(numberText)) fail();
  const bsb = bsbText.replace(/\D/g, "");
  const number = numberText.replace(/\D/g, "");
  if (bsb.length !== 6 || number.length < 4 || number.length > 16) fail();
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode("st-george\0" + bsb + "\0" + number),
  );
  const accountKey = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  const pendingCell = root.querySelector(".transaction-pending tbody > tr > td[colspan='3']");
  const pendingState = clean(pendingCell) === "No Pending transactions found" ? "empty" : "unknown";
  const tables = root.querySelectorAll("#transaction-all table[id='txnHistoryTable']");
  let historyState = "unknown";
  let openingBalanceText = null;
  let closingBalanceText = null;
  let transactions = [];
  if (tables.length === 1) {
    const table = tables[0];
    const headers = Array.from(table.querySelectorAll("thead th"), clean);
    const rows = Array.from(table.querySelectorAll("tbody > tr"));
    let valid =
      headers.join("|") === "Date|Description|Category|Debit|Credit|Balance" && rows.length <= 502;
    for (const row of rows) {
      const cells = Array.from(row.children)
        .filter((cell) => cell.tagName === "TD")
        .map(clean);
      if (cells.length !== 6) {
        valid = false;
        break;
      }
      const [dateText, description, category, debitText, creditText, balanceText] = cells;
      if (
        !dateText &&
        !debitText &&
        !creditText &&
        !category &&
        (description === "Opening Balance" || description === "Closing Balance")
      ) {
        if (!balanceText) {
          valid = false;
          break;
        }
        if (description === "Opening Balance") {
          if (openingBalanceText !== null) {
            valid = false;
            break;
          }
          openingBalanceText = balanceText;
        } else {
          if (closingBalanceText !== null) {
            valid = false;
            break;
          }
          closingBalanceText = balanceText;
        }
        continue;
      }
      if (
        !/^\d{2}\/\d{2}\/\d{4}$/.test(dateText) ||
        !description ||
        Boolean(debitText) === Boolean(creditText) ||
        !balanceText
      ) {
        valid = false;
        break;
      }
      transactions.push({ dateText, description, category, debitText, creditText, balanceText });
    }
    if (valid && transactions.length > 0) historyState = "observed";
    else {
      transactions = [];
      openingBalanceText = null;
      closingBalanceText = null;
    }
  }
  return {
    accountKey,
    historyState,
    pendingState,
    openingBalanceText,
    closingBalanceText,
    transactions,
  };
}
