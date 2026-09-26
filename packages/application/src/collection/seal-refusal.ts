// Which errors from the seal statement are CORE's verdict on the run
// (ADR 0024, amendment of 2026-09-26).
//
// The seal is the last write of a registration, and CORE guards it with
// triggers on `fetch_run_seals`. When the completeness trigger
// (`fetch_run_seal_requires_complete_inventory`) refuses, the run as the
// terminal describes it can never be sealed: the terminal is immutable, the
// derivation is fixed for this contract version, and the trigger will say the
// same thing on every later attempt. That is a verdict about the evidence, so
// registration records it as a block instead of rethrowing it on every walk.
//
// The classification is deliberately narrow. Only a trigger refusal
// (`SQLITE_CONSTRAINT_TRIGGER`) whose RAISE code is in the closed list below
// is a verdict; every other error the seal statement can raise — a trigger
// code not listed here, a constraint that is not a trigger, a D1 or network
// failure — is not classified and is rethrown, exactly as before.

/**
 * The seal triggers' RAISE codes that block a run, stored as its
 * `blocked_code` unchanged (each already fits the column's `[a-z0-9_]{1,64}`).
 *
 * `run_inventory_incomplete` is the one trigger in `0001_initial.sql` whose
 * answer depends only on the run's own rows: the inventory, the catalogue and
 * the declared counts disagree. The other seal triggers are not verdicts
 * about the terminal and stay unclassified: `inactive_ingest_route` is
 * configuration (a registration already refuses it earlier, retryable), and
 * `immutable_duplicate_insert` is a race that the seal's own reconciliation
 * reads back.
 */
const SEAL_REFUSAL_CODES = ["run_inventory_incomplete"] as const;
type SealRefusalCode = (typeof SEAL_REFUSAL_CODES)[number];

/**
 * D1's message for a trigger refusal, as workerd formats it
 * (`D1_ERROR: <code>: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)`,
 * measured against Miniflare's D1), with or without the `D1_ERROR: ` prefix
 * (the error's `cause` carries it without), and the short
 * `<code>: SQLITE_CONSTRAINT_TRIGGER` form.
 */
const D1_TRIGGER_MESSAGE =
  /^(?:D1_ERROR: )?([a-z0-9_]{1,64}): SQLITE_CONSTRAINT(?:_TRIGGER| \(extended: SQLITE_CONSTRAINT_TRIGGER\))$/u;

function isSealRefusalCode(value: string): value is SealRefusalCode {
  return (SEAL_REFUSAL_CODES as readonly string[]).includes(value);
}

/** The trigger's RAISE code when `error` is a trigger refusal, else null. */
function triggerCode(error: unknown): string | null {
  if (!(error instanceof Error)) return null;
  const d1 = D1_TRIGGER_MESSAGE.exec(error.message);
  if (d1) return d1[1]!;
  // SQLite's own error (`bun:sqlite`, which the tests run CORE on): the
  // message is the RAISE text and the extended code is on the error.
  if (
    (error as { code?: unknown }).code === "SQLITE_CONSTRAINT_TRIGGER" &&
    /^[a-z0-9_]{1,64}$/u.test(error.message)
  ) {
    return error.message;
  }
  return null;
}

/**
 * The closed code of a seal trigger refusal that blocks the run, or null when
 * `error` is anything else and must be rethrown.
 */
export function sealRefusalCode(error: unknown): SealRefusalCode | null {
  const code = triggerCode(error);
  return code !== null && isSealRefusalCode(code) ? code : null;
}
