// Every per-card debit account answer the service can make passes the wire
// contract the page checks before it renders (ADR 0114): random synthetic
// evidence rows, as the three reads return them, go through
// `reviewCardDebitAccounts` (and so the domain rule), and the JSON answer is
// validated. A refusal here would be a valid answer the page refuses to show.
// Every value is invented.
import { expect, test } from "bun:test";
import { CARD_DEBIT_ACCOUNT_REASONS } from "../../domain/src/card-debit-account.ts";
import { validApiResponse } from "../../observation-shared/src/api-validation.ts";
import { CARD_DEBIT_ACCOUNTS_PATH } from "../../observation-shared/src/card-debit-accounts-contract.ts";
import type { Grant } from "../src/grants.ts";
import {
  CARD_DEBIT_ACCOUNT_CANDIDATES_SQL,
  CARD_DEBIT_ACCOUNT_CARDS_SQL,
  CARD_DEBIT_ACCOUNT_READINGS_SQL,
  reviewCardDebitAccounts,
} from "../src/query/card-debit-accounts.ts";

const WHOLE: Grant = {
  principal: "synthetic-reader",
  scopes: { sources: "*", accounts: "*" },
  capabilities: ["records.read"],
  budget: { maxRows: 1000, maxProposalTargets: 1, maxExplainDepth: 6 },
};
const BANKS = [
  ["smbc-bank", "smbc-bank:synthetic-a"],
  ["smbc-bank", "smbc-bank:synthetic-b"],
  ["sbi-shinsei-bank", "sbi-shinsei:synthetic-c"],
] as const;
// Few values, so ties in capture time and debit date are common.
const CAPTURES = ["2098-01-12T00:00:00Z", "2098-02-12T00:00:00Z", "2098-03-12T00:00:00Z"];
const DEBIT_DATES = ["2098-01-10", "2098-02-10", "2098-02-30", ""];

/** A small deterministic generator (mulberry32), so a failure replays. */
function generator(seed: number) {
  let state = seed;
  const next = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n: number) => Math.floor(next() * n);
  const pick = <T>(values: readonly T[]): T => values[int(values.length)]!;
  return { int, pick, chance: (p: number) => next() < p };
}

function store(seed: number) {
  const { int, pick, chance } = generator(seed);
  const statements: Record<string, unknown>[] = [];
  const readings: Record<string, unknown>[] = [];
  const candidates: Record<string, unknown>[] = [];
  let readingId = 0;
  let evidenceId = 0;
  let proposal = 0;
  for (let n = 0; n < 1 + int(5); n++) {
    const sourceId = pick(["vpass", "myjcb"] as const);
    const sourceAccount = `${sourceId}:synthetic-${n}`;
    if (chance(0.7))
      statements.push({
        id: n + 1,
        parse_run_id: n + 1,
        source_id: sourceId,
        source_account: sourceAccount,
        unit_ref: "JPY",
        value_status: pick(["exact", "missing"]),
        coefficient: String(int(5) * 1000),
        scale: 0,
        payment_date: pick(DEBIT_DATES.slice(0, 3)),
        as_of: null,
        period: pick(["2098-01", "2098-02", null]),
        account_id: chance(0.5) ? `acct-${n}` : null,
        owner_ref: null,
        evidence_refs_json: null,
      });
    // Readings, as the readings read groups them: each with one row per
    // candidate it was compared with, naming an account or giving a reason.
    if (sourceId === "myjcb" || chance(0.1))
      for (let r = 0; r < int(4); r++) {
        readingId += 1;
        const digits = 1 + int(7);
        const rows = [] as Record<string, unknown>[];
        for (let e = 0; e < 1 + int(3); e++) {
          const outcome = pick(["supports", "names_other_account", "not_proposed"] as const);
          const [bankSourceId, bankSourceAccount] = pick(BANKS);
          rows.push({
            reading_id: readingId,
            source_id: sourceId,
            card_source_account: sourceAccount,
            observed_at: pick(CAPTURES),
            reader_version: "synthetic-1",
            evidence_id: (evidenceId += 1),
            outcome,
            reason: outcome === "not_proposed" ? pick(CARD_DEBIT_ACCOUNT_REASONS) : null,
            proposal_json:
              outcome === "not_proposed"
                ? null
                : JSON.stringify({ bankSourceId, bankSourceAccount, visibleDigitCount: digits }),
          });
        }
        // One reading has one capture time.
        for (const row of rows) row.observed_at = rows[0]!.observed_at;
        readings.push(...rows);
      }
    for (const status of ["accepted", "proposed"])
      for (const [bankSourceId, bankSourceAccount] of BANKS)
        if (chance(0.3))
          candidates.push({
            status,
            card_source_id: sourceId,
            card_source_account: sourceAccount,
            bank_source_id: bankSourceId,
            bank_source_account: bankSourceAccount,
            statements: 1 + int(3),
            latest_key: `${pick(DEBIT_DATES)}\ncs_synthetic-${(proposal += 1) % 7}`,
            latest_period: pick(["2098-01", "2098-02", null]),
          });
  }
  return { statements, readings, candidates };
}

test("every answer the service makes from random evidence passes the wire contract", async () => {
  const seen = new Set<string>();
  for (let seed = 1; seed <= 3000; seed++) {
    const rows = store(seed);
    const outcome = await reviewCardDebitAccounts({
      grant: WHOLE,
      sql: {
        all: async <T>(sql: string) => {
          if (sql === CARD_DEBIT_ACCOUNT_CARDS_SQL) return rows.statements as T[];
          if (sql === CARD_DEBIT_ACCOUNT_READINGS_SQL) return rows.readings as T[];
          if (sql === CARD_DEBIT_ACCOUNT_CANDIDATES_SQL) return rows.candidates as T[];
          throw new Error("unexpected read");
        },
        first: () => Promise.reject(new Error("unexpected read")),
      },
    });
    if (!outcome.ok) throw new Error(outcome.error.code);
    const wire: unknown = JSON.parse(JSON.stringify(outcome.review));
    if (!validApiResponse(CARD_DEBIT_ACCOUNTS_PATH, wire))
      throw new Error(`seed ${seed}: the contract refuses the service's answer`);
    for (const item of outcome.review.items) {
      const { answer, stated } = item;
      seen.add(
        `${stated.status}/${answer.basis}/${"reason" in answer ? answer.reason : answer.codes.join("+")}`,
      );
    }
  }
  // The generator reaches every status, basis, note and unknown reason.
  const all = [...seen].join(" ");
  for (const fragment of [
    "named/",
    "conflicting/",
    "not_named/",
    "absent/",
    "provider-stated/settled_account_differs+newer_reading_unresolved",
    "accepted-settlement/settled_accounts_differ+stated_reading_conflicting",
    "unknown/stated_reading_conflicting",
    "unknown/only_unreviewed_candidates",
    "unknown/no_debit_account_evidence",
  ])
    expect(all).toContain(fragment);
});
