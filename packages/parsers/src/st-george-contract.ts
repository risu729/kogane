/** Minimized provider DOM projection; no credentials, tokens, URLs or raw HTML. */
export interface StGeorgeTransaction {
  dateText: string;
  description: string;
  category: string;
  debitText: string;
  creditText: string;
  balanceText: string;
}

export interface StGeorgeAccount {
  /** SHA-256 of source namespace, normalized BSB and account number; never index. */
  accountKey: string;
  label: string;
  currentBalanceText: string;
  availableBalanceText: string;
  openingBalanceText: string | null;
  closingBalanceText: string | null;
  historyState: "observed" | "empty" | "unknown";
  pendingState: "empty" | "unknown";
  transactions: StGeorgeTransaction[];
}

export interface StGeorgeSnapshot {
  schema: "st-george-browser-v1";
  observedAt: string;
  currency: "AUD";
  currencyEvidence: "source-configured";
  accounts: StGeorgeAccount[];
}

const fail = (): never => {
  throw new Error("invalid-st-george-snapshot");
};

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fail();
  const actual = Object.keys(value).sort();
  if (actual.join("\0") !== [...keys].sort().join("\0")) return fail();
  return value as Record<string, unknown>;
}

function text(value: unknown, max = 4096): string {
  if (
    typeof value !== "string" ||
    value.length > max ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)
  )
    return fail();
  return value;
}

export function stGeorgeMinor(value: string): number {
  const cleaned = value.trim();
  if (!/^-?\$?(?:\d+|\d{1,3}(?:,\d{3})+)\.\d{2}$/u.test(cleaned)) return fail();
  const normalized = cleaned.replaceAll("$", "").replaceAll(",", "");
  const negative = normalized.startsWith("-");
  const [whole, fraction] = normalized.replace("-", "").split(".");
  const minor = BigInt(whole!) * 100n + BigInt(fraction!);
  const signed = negative ? -minor : minor;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER))
    return fail();
  return Number(signed);
}

export function stGeorgeDate(value: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/u.exec(value);
  if (!match) return fail();
  const iso = match[3] + "-" + match[2] + "-" + match[1];
  const date = new Date(iso + "T00:00:00.000Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== iso) return fail();
  return iso;
}

export function parseStGeorgeSnapshot(value: unknown): StGeorgeSnapshot {
  const root = object(value, ["schema", "observedAt", "currency", "currencyEvidence", "accounts"]);
  if (
    root.schema !== "st-george-browser-v1" ||
    root.currency !== "AUD" ||
    root.currencyEvidence !== "source-configured"
  )
    return fail();
  const observedAt = text(root.observedAt, 40);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(observedAt) ||
    !Number.isFinite(Date.parse(observedAt))
  )
    return fail();
  if (
    new Date(observedAt).toISOString() !==
    observedAt.replace(/Z$/u, observedAt.includes(".") ? "Z" : ".000Z")
  )
    return fail();
  if (!Array.isArray(root.accounts) || root.accounts.length < 1 || root.accounts.length > 20)
    return fail();
  const keys = new Set<string>();
  const accounts: StGeorgeAccount[] = root.accounts.map((input) => {
    const account = object(input, [
      "accountKey",
      "label",
      "currentBalanceText",
      "availableBalanceText",
      "openingBalanceText",
      "closingBalanceText",
      "historyState",
      "pendingState",
      "transactions",
    ]);
    const accountKey = text(account.accountKey, 64);
    if (!/^[a-f0-9]{64}$/u.test(accountKey) || keys.has(accountKey)) return fail();
    keys.add(accountKey);
    const label = text(account.label, 256);
    const currentBalanceText = text(account.currentBalanceText, 64);
    const availableBalanceText = text(account.availableBalanceText, 64);
    stGeorgeMinor(currentBalanceText);
    stGeorgeMinor(availableBalanceText);
    const openingBalanceText =
      account.openingBalanceText === null ? null : text(account.openingBalanceText, 64);
    const closingBalanceText =
      account.closingBalanceText === null ? null : text(account.closingBalanceText, 64);
    if (openingBalanceText !== null) stGeorgeMinor(openingBalanceText);
    if (closingBalanceText !== null) stGeorgeMinor(closingBalanceText);
    const historyState = account.historyState;
    const pendingState = account.pendingState;
    if (
      !["observed", "empty", "unknown"].includes(String(historyState)) ||
      !["empty", "unknown"].includes(String(pendingState))
    )
      return fail();
    if (!Array.isArray(account.transactions) || account.transactions.length > 500) return fail();
    if ((historyState === "observed") !== account.transactions.length > 0) return fail();
    const transactions: StGeorgeTransaction[] = account.transactions.map((inputRow) => {
      const row = object(inputRow, [
        "dateText",
        "description",
        "category",
        "debitText",
        "creditText",
        "balanceText",
      ]);
      const dateText = text(row.dateText, 10);
      stGeorgeDate(dateText);
      const description = text(row.description);
      const category = text(row.category, 256);
      const debitText = text(row.debitText, 64);
      const creditText = text(row.creditText, 64);
      const balanceText = text(row.balanceText, 64);
      if (Boolean(debitText) === Boolean(creditText) || !description) return fail();
      if (stGeorgeMinor(debitText || creditText) < 0) return fail();
      stGeorgeMinor(balanceText);
      return { dateText, description, category, debitText, creditText, balanceText };
    });
    return {
      accountKey,
      label,
      currentBalanceText,
      availableBalanceText,
      openingBalanceText,
      closingBalanceText,
      historyState: historyState as StGeorgeAccount["historyState"],
      pendingState: pendingState as StGeorgeAccount["pendingState"],
      transactions,
    };
  });
  return {
    schema: "st-george-browser-v1",
    observedAt,
    currency: "AUD",
    currencyEvidence: "source-configured",
    accounts,
  };
}
