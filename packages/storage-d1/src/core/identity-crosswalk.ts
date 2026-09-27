// The one-time crosswalk between importer-era and collector-era account
// identities (ADR 0030).
//
// The retired importer derived Vpass card tokens and MoneyForward account
// identities under a key that is lost; the collectors derive new values for
// the same cards and accounts, so each resolves to a second account entity.
// Where both producers captured the same provider rows, the stored evidence
// already says which old value a new one continues. This module states that
// overlap once, as SQL, for the three readers that must agree on it:
//
//   * the read-only proposal script (`crosswalkProposalsSql` +
//     `crosswalkProposals`), which prints counts and a verdict;
//   * the `identity.crosswalk.accept` plan (`crosswalkPairSql`), which pins
//     the counts an operator reviewed;
//   * the commit, whose reservation re-evaluates the same pair SQL inside the
//     write (`crosswalkPreconditionSql`), so evidence that changed after the
//     plan writes nothing.
//
// A proposal is a heuristic: nothing here writes. An accepted crosswalk is a
// row of `account_identity_crosswalk` (migration 0058), which
// `accountEntityId` in identity-store.ts reads when it resolves a new value.
//
// Output is counts only. The row keys compared below are provider rows
// (external ids, and for MoneyForward the date, description and amount text),
// and they never leave the SQL: every reader selects counts.
import type { D1Like } from "../d1.ts";
import { identityKey } from "./identity-keys.ts";

/** The sources whose account identity was an importer-keyed HMAC. */
export const CROSSWALK_SOURCES = ["vpass", "moneyforward-me"] as const;
export type CrosswalkSource = (typeof CROSSWALK_SOURCES)[number];

/** The producer whose identities are the importer era; every other one is the collector era. */
export const CROSSWALK_OLD_PRODUCER = "collector-r2-importer";

/**
 * The identity value shapes, both derivations: `v1` is the importer's keyed
 * HMAC (and a collector holding that key), `v2` the collectors' derivation of
 * ADR 0029. The values are opaque: only the prefix and the 64 hex digits are
 * checked, never how they were derived.
 */
const VALUE_PATTERNS: Readonly<Record<CrosswalkSource, RegExp>> = {
  vpass: /^vpass-card-v[12]-[0-9a-f]{64}$/u,
  "moneyforward-me": /^moneyforward-account-v[12]-[0-9a-f]{64}$/u,
};

export function isCrosswalkSource(value: unknown): value is CrosswalkSource {
  return typeof value === "string" && (CROSSWALK_SOURCES as readonly string[]).includes(value);
}

export function isCrosswalkValue(source: CrosswalkSource, value: unknown): value is string {
  return typeof value === "string" && VALUE_PATTERNS[source].test(value);
}

/** The source-account key the identity resolver gives one identity value. */
export function crosswalkAccountKey(source: CrosswalkSource, value: string): string[] {
  return source === "vpass" ? ["vpass:card", value] : [`moneyforward-me:${value}`];
}

/** The identity value a resolved source-account key carries, or null. */
export function crosswalkKeyValue(sourceId: string, key: readonly string[]): string | null {
  if (sourceId === "vpass" && key.length === 2 && key[0] === "vpass:card")
    return isCrosswalkValue("vpass", key[1]) ? key[1]! : null;
  if (
    sourceId === "moneyforward-me" &&
    key.length === 1 &&
    key[0]!.startsWith("moneyforward-me:")
  ) {
    const value = key[0]!.slice("moneyforward-me:".length);
    return isCrosswalkValue("moneyforward-me", value) ? value : null;
  }
  return null;
}

/**
 * The account entity an importer-era value names: the one derived from the
 * importer's source-account reference for it, exactly as `accountEntityId`
 * derives it for the importer's own rows (ADR 0023, ADR 0027).
 */
export async function importerEntityId(source: CrosswalkSource, value: string): Promise<string> {
  return identityKey("account", [
    await identityKey("sa", [source, CROSSWALK_OLD_PRODUCER, crosswalkAccountKey(source, value)]),
  ]);
}

/** The crosswalk row id: one per (source, old, new). */
export async function crosswalkId(
  source: CrosswalkSource,
  fromRef: string,
  toRef: string,
): Promise<string> {
  return identityKey("xw", [source, fromRef, toRef]);
}

/** The decision subject an accepted crosswalk is recorded under. */
export function crosswalkSubjectRef(
  source: CrosswalkSource,
  fromRef: string,
  toRef: string,
): string {
  return `proposal:identity-crosswalk|${source}|${fromRef}|${toRef}`;
}

/**
 * The hot-path read of `accountEntityId`: one SEARCH of the
 * UNIQUE(source_id,to_account_ref) index, pinned without table statistics in
 * packages/storage-d1/test/identity-crosswalk-plan.test.ts.
 */
export const CROSSWALK_FROM_SQL =
  "SELECT from_account_ref FROM account_identity_crosswalk WHERE source_id=? AND to_account_ref=?";

/** The old value an accepted crosswalk maps `toRef` from, or null. One indexed read. */
export async function crosswalkFrom(
  db: D1Like,
  source: CrosswalkSource,
  toRef: string,
): Promise<string | null> {
  const row = await db
    .prepare(CROSSWALK_FROM_SQL)
    .bind(source, toRef)
    .first<{ from_account_ref: string }>();
  return row?.from_account_ref ?? null;
}

// ── SQL ────────────────────────────────────────────────────────────────

/** The identity value of `sa.reference_json`, as `crosswalkKeyValue` reads it. */
const KEY_VALUE_SQL = `CASE
 WHEN sa.source_id='vpass' AND json_array_length(sa.reference_json)=2
  AND json_extract(sa.reference_json,'$[0]')='vpass:card' AND json_type(sa.reference_json,'$[1]')='text'
  THEN json_extract(sa.reference_json,'$[1]')
 WHEN sa.source_id='moneyforward-me' AND json_array_length(sa.reference_json)=1
  AND json_type(sa.reference_json,'$[0]')='text'
  AND substr(json_extract(sa.reference_json,'$[0]'),1,16)='moneyforward-me:'
  THEN substr(json_extract(sa.reference_json,'$[0]'),17)
END`;

/** `VALUE_PATTERNS` as SQL over `x` for the row's source. */
const VALUE_SHAPE_SQL = (x: string) => `(CASE source_id
 WHEN 'vpass' THEN ${x} GLOB 'vpass-card-v[12]-*' AND length(${x})=78 AND substr(${x},15) NOT GLOB '*[^0-9a-f]*'
 WHEN 'moneyforward-me' THEN ${x} GLOB 'moneyforward-account-v[12]-*' AND length(${x})=88 AND substr(${x},25) NOT GLOB '*[^0-9a-f]*'
 ELSE 0 END)`;

/**
 * The provider row a transaction observation shows, independent of the
 * identity it was filed under.
 *
 * - Vpass: the statement line's external id. It is derived from the sanitized
 *   row, the card ordinal, the month, the family and the page, not from the
 *   card token, so the importer's and the collector's capture of one line
 *   carry the same id when both numbered the card and the page alike.
 * - MoneyForward: the external id carries the account identity inside its
 *   fingerprint, so it differs between the two eras for the same row. The key
 *   is instead what that fingerprint covers besides the identity (the
 *   selected month, date, description and amount text) plus the occurrence
 *   counter the id ends with (`moneyforward-monthly:<32 hex>:<n>`).
 */
const ROW_KEY_SQL = `CASE sa.source_id
 WHEN 'vpass' THEN t.external_id
 WHEN 'moneyforward-me' THEN CASE WHEN substr(t.external_id,1,21)='moneyforward-monthly:'
   AND substr(t.external_id,54,1)=':' AND length(t.external_id)>54
  THEN json_array(json_extract(t.extra_json,'$._kogane.selectedMonth'),t.as_of,t.description,
   t.amount_text,substr(t.external_id,55)) END
END`;

/**
 * `crosswalk_rows(source_id, era, key_ref, row_key, month)`: every current
 * transaction observation of the two sources that the identity layer filed
 * under an identity value, once per (identity, row). "Current" is the current
 * identity view, which reads published parse runs of successful fetch runs
 * only (migrations 0022, 0026). `sourceFilter` narrows it to one source.
 */
function crosswalkRowsCte(sourceFilter: string): string {
  return `crosswalk_rows AS MATERIALIZED (
 SELECT DISTINCT source_id,era,key_ref,row_key,month FROM (
  SELECT sa.source_id AS source_id,
   CASE WHEN sa.producer_id='${CROSSWALK_OLD_PRODUCER}' THEN 'old' ELSE 'new' END AS era,
   ${KEY_VALUE_SQL} AS key_ref,
   ${ROW_KEY_SQL} AS row_key,
   substr(t.as_of,1,7) AS month
  FROM current_identity_observations o
  JOIN source_accounts sa ON sa.id=o.source_account_id
  JOIN transaction_observations t ON t.id=o.observation_id
  WHERE o.kind='transaction' AND sa.source_id IN ('vpass','moneyforward-me')${sourceFilter}
 ) WHERE key_ref IS NOT NULL AND row_key IS NOT NULL AND ${VALUE_SHAPE_SQL("key_ref")}
), crosswalk_totals AS MATERIALIZED (
 SELECT source_id,era,key_ref,count(DISTINCT row_key) AS total FROM crosswalk_rows GROUP BY 1,2,3
), crosswalk_pairs AS MATERIALIZED (
 SELECT n.source_id,n.key_ref AS new_ref,o.key_ref AS old_ref,
  count(DISTINCT n.row_key) AS shared,count(DISTINCT n.month) AS months
 FROM crosswalk_rows n JOIN crosswalk_rows o ON o.source_id=n.source_id AND o.row_key=n.row_key
  AND o.era='old' AND o.key_ref<>n.key_ref
 WHERE n.era='new' GROUP BY 1,2,3
)`;
}

/**
 * Every collector-era value with each importer-era value it shares rows with.
 * One row per (new, old) pair, and one row with a null `old_ref` for a new
 * value that shares nothing. A value the importer itself also carries (a
 * collector that held the importer's key) is already the importer's entity
 * and is left out. Counts only.
 */
export const CROSSWALK_PROPOSALS_SQL = `WITH ${crosswalkRowsCte("")}
SELECT n.source_id,n.key_ref AS new_ref,n.total AS new_total,
 p.old_ref,coalesce(p.shared,0) AS shared,coalesce(p.months,0) AS months,o.total AS old_total
FROM crosswalk_totals n
LEFT JOIN crosswalk_pairs p ON p.source_id=n.source_id AND p.new_ref=n.key_ref
LEFT JOIN crosswalk_totals o ON o.source_id=p.source_id AND o.era='old' AND o.key_ref=p.old_ref
WHERE n.era='new' AND NOT EXISTS(SELECT 1 FROM crosswalk_totals same
 WHERE same.source_id=n.source_id AND same.era='old' AND same.key_ref=n.key_ref)
ORDER BY n.source_id,n.key_ref,p.old_ref`;

export interface CrosswalkProposalRow {
  source_id: string;
  new_ref: string;
  new_total: number;
  old_ref: string | null;
  shared: number;
  months: number;
  old_total: number | null;
}

export const CROSSWALK_VERDICTS = ["unique", "ambiguous", "none"] as const;
export type CrosswalkVerdict = (typeof CROSSWALK_VERDICTS)[number];

/** One line of the proposal output. Identity values are opaque hashes; the rest are counts. */
export interface CrosswalkProposal {
  source: string;
  newKeyRef: string;
  /** Null when no importer-era value shares a row. */
  oldKeyRef: string | null;
  sharedRows: number;
  newOnlyRows: number;
  /** Null when there is no old candidate to count. */
  oldOnlyRows: number | null;
  months: number;
  verdict: CrosswalkVerdict;
}

/**
 * The verdict per pair. `unique` needs both directions to be one-to-one: the
 * new value shares rows with exactly one old value, and that old value shares
 * rows with no other new value. Anything else with a shared row is
 * `ambiguous`; a new value that shares nothing is `none`.
 */
export function crosswalkProposals(rows: readonly CrosswalkProposalRow[]): CrosswalkProposal[] {
  const pairs = rows.filter((row) => row.old_ref !== null && row.shared > 0);
  const byNew = new Map<string, number>();
  const byOld = new Map<string, number>();
  for (const row of pairs) {
    const newKey = `${row.source_id}\u0000${row.new_ref}`;
    const oldKey = `${row.source_id}\u0000${row.old_ref}`;
    byNew.set(newKey, (byNew.get(newKey) ?? 0) + 1);
    byOld.set(oldKey, (byOld.get(oldKey) ?? 0) + 1);
  }
  return rows.map((row): CrosswalkProposal => {
    if (row.old_ref === null || row.shared === 0)
      return {
        source: row.source_id,
        newKeyRef: row.new_ref,
        oldKeyRef: null,
        sharedRows: 0,
        newOnlyRows: row.new_total,
        oldOnlyRows: null,
        months: 0,
        verdict: "none",
      };
    const unique =
      byNew.get(`${row.source_id}\u0000${row.new_ref}`) === 1 &&
      byOld.get(`${row.source_id}\u0000${row.old_ref}`) === 1;
    return {
      source: row.source_id,
      newKeyRef: row.new_ref,
      oldKeyRef: row.old_ref,
      sharedRows: row.shared,
      newOnlyRows: row.new_total - row.shared,
      oldOnlyRows: (row.old_total ?? row.shared) - row.shared,
      months: row.months,
      verdict: unique ? "unique" : "ambiguous",
    };
  });
}

/**
 * The same measurement for one (source, new, old) pair, binds
 * `[source, newRef, oldRef]` as plain `?` so it can be spliced after the
 * reservation's numbered parameters. One row, always:
 *
 * - `shared`, `months`: rows (and their months) both values carry;
 * - `new_total`, `old_total`: rows each carries (0 when it carries none);
 * - `other_old`: other importer-era values the new value shares rows with;
 * - `other_new`: other collector-era values the old value shares rows with;
 * - `new_is_old`: 1 when the importer also carries the new value itself.
 */
export const CROSSWALK_PAIR_SQL = `WITH crosswalk_params AS MATERIALIZED (SELECT ? AS source_id,? AS new_ref,? AS old_ref),
${crosswalkRowsCte(" AND sa.source_id=(SELECT source_id FROM crosswalk_params)")}
SELECT
 coalesce((SELECT p.shared FROM crosswalk_pairs p,crosswalk_params x WHERE p.new_ref=x.new_ref AND p.old_ref=x.old_ref),0) AS shared,
 coalesce((SELECT p.months FROM crosswalk_pairs p,crosswalk_params x WHERE p.new_ref=x.new_ref AND p.old_ref=x.old_ref),0) AS months,
 coalesce((SELECT t.total FROM crosswalk_totals t,crosswalk_params x WHERE t.era='new' AND t.key_ref=x.new_ref),0) AS new_total,
 coalesce((SELECT t.total FROM crosswalk_totals t,crosswalk_params x WHERE t.era='old' AND t.key_ref=x.old_ref),0) AS old_total,
 (SELECT count(*) FROM crosswalk_pairs p,crosswalk_params x WHERE p.new_ref=x.new_ref AND p.old_ref<>x.old_ref AND p.shared>0) AS other_old,
 (SELECT count(*) FROM crosswalk_pairs p,crosswalk_params x WHERE p.old_ref=x.old_ref AND p.new_ref<>x.new_ref AND p.shared>0) AS other_new,
 (SELECT count(*) FROM crosswalk_totals t,crosswalk_params x WHERE t.era='old' AND t.key_ref=x.new_ref) AS new_is_old`;

export interface CrosswalkPairRow {
  shared: number;
  months: number;
  new_total: number;
  old_total: number;
  other_old: number;
  other_new: number;
  new_is_old: number;
}

/** The counts an operator reviews and a plan pins. */
export interface CrosswalkCounts {
  sharedRows: number;
  newOnlyRows: number;
  oldOnlyRows: number;
  months: number;
}

export function crosswalkCounts(row: CrosswalkPairRow): CrosswalkCounts {
  return {
    sharedRows: row.shared,
    newOnlyRows: row.new_total - row.shared,
    oldOnlyRows: row.old_total - row.shared,
    months: row.months,
  };
}

/** True when the pair is the one-to-one overlap a crosswalk may record. */
export function crosswalkPairUnique(row: CrosswalkPairRow): boolean {
  return row.shared > 0 && row.other_old === 0 && row.other_new === 0 && row.new_is_old === 0;
}

/**
 * The commit's reservation condition, binds
 * `[source, newRef, oldRef, sharedRows, months, newOnlyRows, oldOnlyRows,
 *   source, fromRef, source, toRef]`: the pair still measures exactly the
 * pinned counts, is still one-to-one, and neither value is in a crosswalk yet.
 */
export const CROSSWALK_PRECONDITION_SQL = `EXISTS(SELECT 1 FROM (${CROSSWALK_PAIR_SQL}) c
 WHERE c.shared=? AND c.months=? AND c.new_total-c.shared=? AND c.old_total-c.shared=?
 AND c.shared>0 AND c.other_old=0 AND c.other_new=0 AND c.new_is_old=0)
 AND NOT EXISTS(SELECT 1 FROM account_identity_crosswalk x WHERE x.source_id=? AND x.from_account_ref=?)
 AND NOT EXISTS(SELECT 1 FROM account_identity_crosswalk x WHERE x.source_id=? AND x.to_account_ref=?)`;

export function crosswalkPreconditionBinds(
  source: CrosswalkSource,
  fromRef: string,
  toRef: string,
  counts: CrosswalkCounts,
): unknown[] {
  return [
    source,
    toRef,
    fromRef,
    counts.sharedRows,
    counts.months,
    counts.newOnlyRows,
    counts.oldOnlyRows,
    source,
    fromRef,
    source,
    toRef,
  ];
}

/**
 * The collector-era source accounts that carry the new value: the subjects
 * whose automatic mapping an accepted crosswalk supersedes. Binds
 * `[source, newRef]`. `protected` is 1 when a manual decision holds the
 * subject, which the crosswalk leaves alone.
 */
export const CROSSWALK_SUBJECTS_SQL = `SELECT sa.id AS source_account_id,
 m.revision,m.account_id,m.method,
 EXISTS(SELECT 1 FROM protected_mapping_subjects p WHERE p.subject_kind='account_mapping' AND p.subject_ref=sa.id) AS protected
FROM source_accounts sa JOIN current_account_mappings m ON m.source_account_id=sa.id
WHERE sa.source_id=?1 AND sa.producer_id<>'${CROSSWALK_OLD_PRODUCER}' AND (${KEY_VALUE_SQL})=?2
ORDER BY sa.id`;

export interface CrosswalkSubjectRow {
  source_account_id: string;
  revision: number;
  account_id: string;
  method: string;
  protected: number;
}
