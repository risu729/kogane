// Small synthetic worlds for the reconstructed state's service, wire contract
// and page tests: every answer is produced by `readReconstructedState` (and
// so by `queryReconstructedState`) over a store holding both a reported state
// (read-model/test/dated-state-fixture.ts) and an economic history written
// through CORE 0070's triggers (economic-history-fixture.ts), so the client is
// tested against what the server really says. One world per account, because
// each world's bank account owns the one SMBC balance container. Every
// account, amount and date is invented.
import type { Grant } from "../src/grants.ts";
import { KNOWN_WRITER_RELEASES } from "../../domain/src/reconstruction-adapter.ts";
import { CARD_PURCHASE_WRITER_RELEASE } from "../../domain/src/card-purchase.ts";
import { DatedStore } from "../../read-model/test/dated-state-fixture.ts";
import {
  EconomicHistory,
  day,
  storeExecutor,
} from "../../read-model/test/economic-history-fixture.ts";
import {
  readReconstructedState,
  reconstructedStateBodyFromQuery,
  type ReconstructedStateOutcome,
} from "../src/query/reconstructed-state-read.ts";

const SMBC = { source: "smbc-bank", dataset: "balance-normalized", parser: "smbc-direct-balance" };
const SETTLEMENT_RELEASE = KNOWN_WRITER_RELEASES["card-settlement-review"][0]!;

/** A bank account with logged history: reconstructed 9,000 against a reported 8,500. */
export const WORLD_BANK = "acct-bank";
/** A card account: no reported container, so `unavailable`. */
export const WORLD_CARD = "acct-card";
/** A bank account whose settlement was accepted before the log: `indeterminate`. */
export const WORLD_PRE_LOG = "acct-pre-log";
/** A bank account in a store with an empty commit log: `indeterminate`, provisional cut. */
export const WORLD_EMPTY_LOG = "acct-empty-log";
/** A bank account in a store without CORE 0070: `unavailable`, nothing computed. */
export const WORLD_NO_GUARD = "acct-no-guard";
export const WORLD_FROM = "2026-03-01";
export const WORLD_TO = "2026-03-31";

/** The reader authority a signed-in browser has (services/app `readerGrant`). */
export const WORLD_GRANT: Grant = {
  principal: "synthetic-reader",
  scopes: { sources: "*", accounts: "*" },
  capabilities: ["summary.read", "records.read", "evidence.read"],
  budget: { maxRows: 1000, maxProposalTargets: 1, maxExplainDepth: 6 },
};

/** A bank account with captures at both ends of March, beside a card account. */
function bankWorld(account: string, endMinor: number): EconomicHistory {
  const store = new DatedStore();
  const start = store.capture({
    ...SMBC,
    fetchedAt: "2026-03-01T03:00:00Z",
    balances: [{ account: "smbc-a", metric: "account_balance", instrument: "JPY", minor: 10_000 }],
  });
  store.identify(start, SMBC.source, account, "identified");
  const end = store.capture({
    ...SMBC,
    fetchedAt: "2026-03-31T03:00:00Z",
    balances: [
      { account: "smbc-a", metric: "account_balance", instrument: "JPY", minor: endMinor },
    ],
  });
  store.identify(end, SMBC.source, account, "identified");
  const statement = store.statement({
    card: "card-a",
    period: "2026-03",
    paymentDate: "2026-03-26",
    minor: 1_000,
    fetchedAt: "2026-03-05T01:00:00Z",
  });
  store.identify(statement, "vpass", WORLD_CARD, "identified");
  return new EconomicHistory(store);
}

/** A settlement the way the reviewed writer stores it, with a posting time row. */
function settle(
  h: EconomicHistory,
  account: string,
  eventId: string,
  fields: Partial<Parameters<EconomicHistory["adopt"]>[0]> = {},
): void {
  h.adopt({
    eventId,
    revision: 1,
    legs: [
      { subject: account, amount: "1000", role: "decrease", basis: "cash-movement" },
      { subject: WORLD_CARD, amount: null, role: "unresolved", basis: "obligation-change" },
    ],
    times: [["posting", day("2026-03-15")]],
    knownAt: "2026-04-01T00:00:00.000Z",
    writerRelease: SETTLEMENT_RELEASE,
    ...fields,
  });
}

/** Every account's world, keyed by account id. */
export function reconstructedStateWorlds(): Map<string, EconomicHistory> {
  const bank = bankWorld(WORLD_BANK, 8_500);
  settle(bank, WORLD_BANK, "ev-settle");
  bank.adopt({
    eventId: "ev-purchase",
    revision: 1,
    kind: "purchase",
    state: "captured",
    legs: [
      {
        subject: `account:${WORLD_CARD}`,
        amount: "700",
        role: "decrease",
        basis: "purchase-recognition",
      },
    ],
    times: [["usage", day("2026-03-10")]],
    knownAt: "2026-04-02T00:00:00.000Z",
    writerRelease: CARD_PURCHASE_WRITER_RELEASE,
  });
  const preLog = bankWorld(WORLD_PRE_LOG, 9_000);
  settle(preLog, WORLD_PRE_LOG, "ev-pre", { logged: false });
  const emptyLog = bankWorld(WORLD_EMPTY_LOG, 9_000);
  const noGuard = bankWorld(WORLD_NO_GUARD, 9_000);
  noGuard.db.exec(
    "DROP VIEW unlogged_economic_revisions; DROP VIEW consumption_claim_conflicts; DROP VIEW live_consumption_claims; DROP VIEW economic_revision_claims",
  );
  return new Map([
    [WORLD_BANK, bank],
    [WORLD_CARD, bank],
    [WORLD_PRE_LOG, preLog],
    [WORLD_EMPTY_LOG, emptyLog],
    [WORLD_NO_GUARD, noGuard],
  ]);
}

/**
 * The outcome for a query string, as `GET /api/v2/reconstructed-state` and
 * the agent tool compute it; an account no world holds is asked of the bank
 * world (where it is `unknown_account`).
 */
export async function reconstructedStateOutcome(
  worlds: Map<string, EconomicHistory>,
  params: URLSearchParams,
  now: string = new Date().toISOString(),
): Promise<ReconstructedStateOutcome> {
  const query = reconstructedStateBodyFromQuery(params);
  if (!query.ok) return query;
  const world = worlds.get(params.get("account") ?? "") ?? worlds.get(WORLD_BANK)!;
  return readReconstructedState({
    grant: WORLD_GRANT,
    sql: storeExecutor(world.db),
    body: query.body,
    now,
  });
}
