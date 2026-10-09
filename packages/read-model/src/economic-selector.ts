// The knowledge selector, SQL half (ADR 0058; ADR 0054, "Knowledge selector
// interface"). Read-only: it loads, for one scope, every event the scope
// touches together with everything that decides its revision in force at a
// cut, and hands the rows to `selectAdopted`
// (packages/domain/src/knowledge-selector.ts), which resolves and filters.
//
// What it reads, each statement by key (D1 runs no ANALYZE; the plans are
// checked without table statistics in test/economic-selector.test.ts):
//
//   * `economic_commit_log` by (core_epoch, commit_seq): the log's first and
//     last commit, the commit of a sequence, the commit an instant resolves to
//     (the largest sequence whose known_at is at or before it, read newest
//     first along the primary key), and the commits the loaded seals name;
//   * the seed: event ids whose legs name a scope account, as
//     `account:<id>` (card purchases and every new writer) or as the bare id
//     (card settlements, the 0044 tolerance), through `economic_legs_subject`;
//   * the closure, repeated until it adds nothing: every revision of those
//     events (primary key), the events their `superseded_by` names and the
//     events whose revisions point at them (`economic_event_revisions_superseded_by`),
//     their claims through the 0070 view `economic_revision_claims` (the
//     legacy purchase keys and accepted settlements included), and every
//     other holder of the same (book, key) or (book, alias class)
//     (`economic_claims_key`, `card_purchase_recognition_keys_key`,
//     `card_settlement_candidates_bank`, `economic_claims_alias`);
//   * the legs, times, effects and seals of the closure (primary keys), the
//     account each leg subject names (`accounts` by id), the current identity
//     epoch, and the current revision of each subject a seal pins.
//
// Bounds: every read stops one row past its bound and the load is refused
// (`selector_bound_exceeded`), never cut. The closure reads the whole history
// of every touched event, whatever the cut: what a cut keeps is the domain
// half's decision, so one load answers any cut of the epoch.
import type { KnowledgeCut } from "../../domain/src/economic-contract.ts";
import {
  ADOPTED_SELECTION_INPUT,
  SELECTOR_BOUNDS,
  canonicalCutInstant,
  type LoadedClaim,
  type LoadedCommit,
  type LoadedEffect,
  type LoadedLeg,
  type LoadedPin,
  type LoadedRevision,
  type LoadedSeal,
  type LoadedSubject,
  type LoadedTime,
  type LogExtent,
  type ResolvedCut,
  type SelectionScope,
  type SelectorInput,
} from "../../domain/src/knowledge-selector.ts";
import type { SqlExecutor } from "./reader.ts";

/** The 0070 objects the selector reads; without every one of them it is unavailable. */
export const ECONOMIC_SELECTOR_OBJECTS = [
  ["table", "economic_commit_log"],
  ["table", "economic_revision_seals"],
  ["table", "economic_event_times"],
  ["table", "economic_leg_effects"],
  ["table", "economic_identity_epochs"],
  ["table", "economic_claims"],
  ["view", "economic_revision_claims"],
] as const;

export const ECONOMIC_SELECTOR_PRESENT_SQL = `SELECT count(*) AS present FROM sqlite_master
 WHERE ${ECONOMIC_SELECTOR_OBJECTS.map(([type, name]) => `(type='${type}' AND name='${name}')`).join(" OR ")}`;

export const SELECTOR_EPOCHS_SQL = `SELECT (SELECT core_epoch FROM core_source_revision WHERE id=1) AS core_epoch,
 (SELECT identity_epoch FROM economic_identity_epochs ORDER BY ordinal DESC LIMIT 1) AS identity_epoch`;

/** ?1 core epoch. */
export const LOG_EXTENT_SQL = `SELECT
 (SELECT commit_seq FROM economic_commit_log WHERE core_epoch=?1 ORDER BY commit_seq LIMIT 1) AS first_seq,
 (SELECT known_at FROM economic_commit_log WHERE core_epoch=?1 ORDER BY commit_seq LIMIT 1) AS first_known_at,
 (SELECT commit_seq FROM economic_commit_log WHERE core_epoch=?1 ORDER BY commit_seq DESC LIMIT 1) AS last_seq,
 (SELECT known_at FROM economic_commit_log WHERE core_epoch=?1 ORDER BY commit_seq DESC LIMIT 1) AS last_known_at`;

/**
 * ?1 core epoch, ?2 an instant in the stored known_at form: the largest
 * sequence whose known_at is at or before it, every commit of an equal
 * instant included. known_at never decreases along the sequence, so the read
 * walks the primary key from the newest commit and stops at the first match;
 * it costs the commits made after the instant (no index orders known_at).
 */
export const INSTANT_CUT_SQL = `SELECT commit_seq,known_at FROM economic_commit_log
 WHERE core_epoch=?1 AND known_at<=?2 ORDER BY commit_seq DESC LIMIT 1`;

/** ?1 core epoch, ?2 commit sequence. */
export const COMMIT_AT_SQL = `SELECT known_at FROM economic_commit_log WHERE core_epoch=?1 AND commit_seq=?2`;

/** ?1 JSON array of leg subjects (both forms of each scope account), ?2 row limit. */
export const SEED_EVENTS_SQL = `SELECT DISTINCT l.event_id FROM json_each(?1) s
 CROSS JOIN economic_legs l ON l.subject_ref=s.value LIMIT ?2`;

/** ?1 JSON array of event ids, ?2 row limit. */
export const REVISIONS_SQL = `SELECT r.event_id,r.revision,r.kind,r.state,r.unknown_reason,r.created_at,r.superseded_by
 FROM json_each(?1) e CROSS JOIN economic_event_revisions r ON r.event_id=e.value LIMIT ?2`;

/** ?1 JSON array of `eventId@revision`: the events whose revisions point at them. */
export const POINTED_BY_SQL = `SELECT DISTINCT r.event_id FROM json_each(?1) p
 CROSS JOIN economic_event_revisions r ON r.superseded_by=p.value`;

/** ?1 JSON array of event ids, ?2 row limit: every claim of every revision, through the 0070 view. */
export const CLAIMS_SQL = `SELECT event_id,revision,book,consumption_key,alias_class FROM economic_revision_claims
 WHERE event_id IN (SELECT value FROM json_each(?1)) LIMIT ?2`;

/**
 * ?1 JSON array of `[book, key text]`: every event holding one of those keys
 * in any revision, from each holder source by its key index (SQLite does not
 * push a join term into the UNION view, so the view's three sources are
 * spelled out as the 0070 triggers spell them).
 */
export const KEY_HOLDERS_SQL = `WITH wanted AS MATERIALIZED (
 SELECT DISTINCT json_extract(value,'$[0]') AS book,json_extract(value,'$[1]') AS consumption_key FROM json_each(?1)
)
SELECT x.event_id FROM wanted w CROSS JOIN economic_claims x ON x.book=w.book AND x.consumption_key=w.consumption_key
UNION
SELECT k.event_id FROM wanted w CROSS JOIN card_purchase_recognition_keys k ON k.recognition_key=w.consumption_key
 WHERE w.book='card-usage'
UNION
SELECT d.event_id FROM wanted w CROSS JOIN card_settlement_candidates c ON c.bank_key=w.consumption_key
 CROSS JOIN card_settlement_decisions d ON d.proposal_id=c.id
 WHERE w.book='cash-movement' AND d.status='accepted' AND d.event_id IS NOT NULL`;

/** ?1 JSON array of `[book, alias class text]`. Legacy holders carry no alias class. */
export const ALIAS_HOLDERS_SQL = `SELECT DISTINCT x.event_id FROM json_each(?1) a
 CROSS JOIN economic_claims x ON x.book=json_extract(a.value,'$[0]') AND x.alias_class=json_extract(a.value,'$[1]')`;

/** ?1 JSON array of event ids, ?2 row limit. */
export const LEGS_SQL = `SELECT l.event_id,l.revision,l.leg_index,l.subject_ref,l.unit_ref,l.value_status,l.coefficient,l.scale,
 l.value_reason_code,l.role,l.basis
 FROM json_each(?1) e CROSS JOIN economic_legs l ON l.event_id=e.value LIMIT ?2`;

/** ?1 JSON array of event ids, ?2 row limit. */
export const TIMES_SQL = `SELECT t.event_id,t.revision,t.role,t.temporal_json
 FROM json_each(?1) e CROSS JOIN economic_event_times t ON t.event_id=e.value LIMIT ?2`;

/** ?1 JSON array of event ids, ?2 row limit. */
export const EFFECTS_SQL = `SELECT f.event_id,f.revision,f.leg_index,f.effect,f.of_leg_index
 FROM json_each(?1) e CROSS JOIN economic_leg_effects f ON f.event_id=e.value LIMIT ?2`;

/** ?1 JSON array of event ids, ?2 row limit. */
export const SEALS_SQL = `SELECT s.event_id,s.revision,s.writer_release,s.leg_count,s.claim_count,s.time_count,s.effect_count,
 s.content_digest,s.identity_pins_json,s.identity_epoch,s.core_epoch,s.commit_seq
 FROM json_each(?1) e CROSS JOIN economic_revision_seals s ON s.event_id=e.value LIMIT ?2`;

/** ?1 JSON array of `[core epoch, commit sequence]`. */
export const COMMITS_SQL = `SELECT c.core_epoch,c.commit_seq,c.kind,c.known_at,c.members_json
 FROM json_each(?1) k CROSS JOIN economic_commit_log c
 ON c.core_epoch=json_extract(k.value,'$[0]') AND c.commit_seq=json_extract(k.value,'$[1]')`;

/**
 * ?1 JSON array of leg subjects: the account each names, as `account:<id>`
 * or as the bare id (the tolerance of 0044:142,149 and
 * card-settlement-ownership.ts), each by the `accounts` primary key.
 */
export const SUBJECTS_SQL = `SELECT s.value AS subject_ref,
 (SELECT a.id FROM accounts a WHERE a.id=s.value) AS bare_id,
 CASE WHEN substr(s.value,1,8)='account:' THEN (SELECT a.id FROM accounts a WHERE a.id=substr(s.value,9)) END AS prefixed_id
 FROM json_each(?1) s`;

/**
 * ?1 JSON array of pinned identity subjects: the current revision of each,
 * as core/operations.ts REVISION_OF answers it for `account_mapping:` and
 * `instrument_mapping:` (the highest mapping revision, 0 when none). Any
 * other prefix is not read here (`readable` 0): the selector then calls the
 * pin unreadable and the revision identity_changed, never unchanged.
 */
export const PINS_SQL = `SELECT p.value AS subject,
 CASE WHEN substr(p.value,1,16)='account_mapping:' THEN
   coalesce((SELECT max(m.revision) FROM account_mappings m WHERE m.source_account_id=substr(p.value,17)),0)
  WHEN substr(p.value,1,19)='instrument_mapping:' THEN
   coalesce((SELECT max(m.revision) FROM instrument_mappings m WHERE m.identifier_id=substr(p.value,20)),0)
 END AS current_revision
 FROM json_each(?1) p`;

export const ECONOMIC_SELECTOR_ERRORS = [
  "selector_bound_exceeded",
  "cut_after_log_end",
  "cut_epoch_not_current",
  "invalid_cut",
] as const;
export type EconomicSelectorErrorCode = (typeof ECONOMIC_SELECTOR_ERRORS)[number];

/** A refused load: a bound passed or a cut the log cannot answer. Never a partial read. */
export class EconomicSelectorError extends Error {
  readonly code: EconomicSelectorErrorCode;
  readonly refs: string[];
  constructor(code: EconomicSelectorErrorCode, refs: string[] = []) {
    super(code);
    this.name = "EconomicSelectorError";
    this.code = code;
    this.refs = refs;
  }
}

export interface SelectorMeta {
  currentCoreEpoch: string;
  currentIdentityEpoch: string;
  /** The current core epoch's log. */
  log: LogExtent;
}

interface EpochsRow {
  core_epoch: string | null;
  identity_epoch: string | null;
}
interface ExtentRow {
  first_seq: number | null;
  first_known_at: string | null;
  last_seq: number | null;
  last_known_at: string | null;
}

/** Whether CORE 0070 is applied (every object the selector reads exists). */
export async function economicSelectorAvailable(sql: SqlExecutor): Promise<boolean> {
  const row = await sql.first<{ present: number }>(ECONOMIC_SELECTOR_PRESENT_SQL, []);
  return row?.present === ECONOMIC_SELECTOR_OBJECTS.length;
}

export async function readSelectorMeta(sql: SqlExecutor): Promise<SelectorMeta> {
  const epochs = await sql.first<EpochsRow>(SELECTOR_EPOCHS_SQL, []);
  if (epochs?.core_epoch == null || epochs.identity_epoch == null)
    throw new Error("selector_meta_missing");
  const extent = await sql.first<ExtentRow>(LOG_EXTENT_SQL, [epochs.core_epoch]);
  return {
    currentCoreEpoch: epochs.core_epoch,
    currentIdentityEpoch: epochs.identity_epoch,
    log: {
      firstSeq: extent?.first_seq ?? null,
      firstKnownAt: extent?.first_known_at ?? null,
      lastSeq: extent?.last_seq ?? null,
      lastKnownAt: extent?.last_known_at ?? null,
    },
  };
}

export interface ResolvedSelectorCut {
  requested: KnowledgeCut;
  cut: ResolvedCut;
  knownAt: string | null;
}

/**
 * A cut of the current core epoch as a sequence. A sequence past the log's
 * last commit is refused (it would answer differently once that commit
 * exists); an instant resolves in SQL. A cut of another epoch is refused.
 */
export async function resolveSelectorCut(
  sql: SqlExecutor,
  meta: SelectorMeta,
  requested: KnowledgeCut,
): Promise<ResolvedSelectorCut> {
  if (requested.coreEpoch !== meta.currentCoreEpoch)
    throw new EconomicSelectorError("cut_epoch_not_current", ["cut.coreEpoch"]);
  if ("commitSeq" in requested) {
    if (requested.commitSeq > (meta.log.lastSeq ?? 0))
      throw new EconomicSelectorError("cut_after_log_end", [`commitSeq:${requested.commitSeq}`]);
    const row = await sql.first<{ known_at: string }>(COMMIT_AT_SQL, [
      requested.coreEpoch,
      requested.commitSeq,
    ]);
    if (row === null) throw new EconomicSelectorError("invalid_cut", ["commitSeq"]);
    return {
      requested,
      cut: { coreEpoch: requested.coreEpoch, commitSeq: requested.commitSeq },
      knownAt: row.known_at,
    };
  }
  const bound = canonicalCutInstant(requested.instant);
  if (bound === null) throw new EconomicSelectorError("invalid_cut", ["instant"]);
  const row = await sql.first<{ commit_seq: number; known_at: string }>(INSTANT_CUT_SQL, [
    requested.coreEpoch,
    bound,
  ]);
  return {
    requested,
    cut: { coreEpoch: requested.coreEpoch, commitSeq: row?.commit_seq ?? 0 },
    knownAt: row?.known_at ?? null,
  };
}

/** The rows the domain half reads, cut-independent. */
export interface SelectorRows {
  revisions: LoadedRevision[];
  legs: LoadedLeg[];
  subjects: LoadedSubject[];
  claims: LoadedClaim[];
  times: LoadedTime[];
  effects: LoadedEffect[];
  seals: LoadedSeal[];
  commits: LoadedCommit[];
  pins: LoadedPin[];
}

const POINTER = /^(.+)@([1-9][0-9]*)$/u;

function bounded<T>(rows: T[], name: keyof typeof SELECTOR_BOUNDS, already = 0): T[] {
  const bound = SELECTOR_BOUNDS[name];
  if (already + rows.length > bound)
    throw new EconomicSelectorError("selector_bound_exceeded", [`${name}:>${bound}`]);
  return rows;
}

/** Every leg subject that names one of these accounts: both stored forms. */
export function scopeSubjects(accounts: readonly string[]): string[] {
  return [...new Set(accounts.flatMap((account) => [account, `account:${account}`]))].sort();
}

/**
 * Load every event `scope.accounts` touches, closed under supersession (both
 * directions, across event ids) and under claim holders (the same key or
 * alias class in any revision of any event), with all their child rows.
 */
export async function loadSelectorRows(
  sql: SqlExecutor,
  scope: Pick<SelectionScope, "accounts">,
): Promise<SelectorRows> {
  const limit = (name: keyof typeof SELECTOR_BOUNDS, already = 0) =>
    SELECTOR_BOUNDS[name] - already + 1;
  const seed = bounded(
    await sql.all<{ event_id: string }>(SEED_EVENTS_SQL, [
      JSON.stringify(scopeSubjects(scope.accounts)),
      limit("events"),
    ]),
    "events",
  );
  const events = new Set(seed.map((row) => row.event_id));
  let pending = [...events];
  const revisions: LoadedRevision[] = [];
  const claims: LoadedClaim[] = [];
  const keysSeen = new Set<string>();
  const aliasesSeen = new Set<string>();
  while (pending.length > 0) {
    const ids = JSON.stringify(pending);
    const revisionRows = bounded(
      await sql.all<{
        event_id: string;
        revision: number;
        kind: string;
        state: string;
        unknown_reason: string | null;
        created_at: string;
        superseded_by: string | null;
      }>(REVISIONS_SQL, [ids, limit("revisions", revisions.length)]),
      "revisions",
      revisions.length,
    );
    for (const row of revisionRows)
      revisions.push({
        eventId: row.event_id,
        revision: row.revision,
        kind: row.kind,
        state: row.state,
        unknownReason: row.unknown_reason,
        createdAt: row.created_at,
        supersededBy: row.superseded_by,
      });
    const next = new Set<string>();
    const add = (eventId: string) => {
      if (!events.has(eventId)) next.add(eventId);
    };
    for (const row of revisionRows) {
      const match = row.superseded_by === null ? null : POINTER.exec(row.superseded_by);
      if (match !== null) add(match[1]!);
    }
    const refs = revisionRows.map((row) => `${row.event_id}@${row.revision}`);
    if (refs.length > 0)
      for (const row of await sql.all<{ event_id: string }>(POINTED_BY_SQL, [JSON.stringify(refs)]))
        add(row.event_id);
    const claimRows = bounded(
      await sql.all<{
        event_id: string;
        revision: number;
        book: string;
        consumption_key: string;
        alias_class: string | null;
      }>(CLAIMS_SQL, [ids, limit("claims", claims.length)]),
      "claims",
      claims.length,
    );
    const keys: [string, string][] = [];
    const aliases: [string, string][] = [];
    for (const row of claimRows) {
      claims.push({
        eventId: row.event_id,
        revision: row.revision,
        book: row.book,
        consumptionKey: row.consumption_key,
        aliasClass: row.alias_class,
      });
      const key = JSON.stringify([row.book, row.consumption_key]);
      if (!keysSeen.has(key)) {
        keysSeen.add(key);
        keys.push([row.book, row.consumption_key]);
      }
      if (row.alias_class !== null) {
        const alias = JSON.stringify([row.book, row.alias_class]);
        if (!aliasesSeen.has(alias)) {
          aliasesSeen.add(alias);
          aliases.push([row.book, row.alias_class]);
        }
      }
    }
    if (keys.length > 0)
      for (const row of await sql.all<{ event_id: string }>(KEY_HOLDERS_SQL, [
        JSON.stringify(keys),
      ]))
        add(row.event_id);
    if (aliases.length > 0)
      for (const row of await sql.all<{ event_id: string }>(ALIAS_HOLDERS_SQL, [
        JSON.stringify(aliases),
      ]))
        add(row.event_id);
    for (const eventId of next) events.add(eventId);
    if (events.size > SELECTOR_BOUNDS.events)
      throw new EconomicSelectorError("selector_bound_exceeded", [
        `events:>${SELECTOR_BOUNDS.events}`,
      ]);
    pending = [...next];
  }

  const ids = JSON.stringify([...events].sort());
  const legs = bounded(
    await sql.all<{
      event_id: string;
      revision: number;
      leg_index: number;
      subject_ref: string;
      unit_ref: string;
      value_status: string;
      coefficient: string | null;
      scale: number | null;
      value_reason_code: string | null;
      role: string;
      basis: string;
    }>(LEGS_SQL, [ids, limit("legs")]),
    "legs",
  ).map((row): LoadedLeg => ({
    eventId: row.event_id,
    revision: row.revision,
    legIndex: row.leg_index,
    subjectRef: row.subject_ref,
    unitRef: row.unit_ref,
    valueStatus: row.value_status,
    coefficient: row.coefficient,
    scale: row.scale,
    valueReasonCode: row.value_reason_code,
    role: row.role,
    basis: row.basis,
  }));
  const times = bounded(
    await sql.all<{ event_id: string; revision: number; role: string; temporal_json: string }>(
      TIMES_SQL,
      [ids, limit("times")],
    ),
    "times",
  ).map((row): LoadedTime => ({
    eventId: row.event_id,
    revision: row.revision,
    role: row.role,
    temporalJson: row.temporal_json,
  }));
  const effects = bounded(
    await sql.all<{
      event_id: string;
      revision: number;
      leg_index: number;
      effect: string;
      of_leg_index: number | null;
    }>(EFFECTS_SQL, [ids, limit("effects")]),
    "effects",
  ).map((row): LoadedEffect => ({
    eventId: row.event_id,
    revision: row.revision,
    legIndex: row.leg_index,
    effect: row.effect,
    ofLegIndex: row.of_leg_index,
  }));
  const seals = bounded(
    await sql.all<{
      event_id: string;
      revision: number;
      writer_release: string;
      leg_count: number;
      claim_count: number;
      time_count: number;
      effect_count: number;
      content_digest: string;
      identity_pins_json: string;
      identity_epoch: string;
      core_epoch: string;
      commit_seq: number;
    }>(SEALS_SQL, [ids, limit("revisions")]),
    "revisions",
  ).map((row): LoadedSeal => ({
    eventId: row.event_id,
    revision: row.revision,
    writerRelease: row.writer_release,
    legCount: row.leg_count,
    claimCount: row.claim_count,
    timeCount: row.time_count,
    effectCount: row.effect_count,
    contentDigest: row.content_digest,
    identityPinsJson: row.identity_pins_json,
    identityEpoch: row.identity_epoch,
    coreEpoch: row.core_epoch,
    commitSeq: row.commit_seq,
  }));
  const commitKeys = [
    ...new Map(
      seals.map((seal) => [
        `${seal.coreEpoch}\u0000${seal.commitSeq}`,
        [seal.coreEpoch, seal.commitSeq],
      ]),
    ).values(),
  ];
  const commits =
    commitKeys.length === 0
      ? []
      : bounded(
          await sql.all<{
            core_epoch: string;
            commit_seq: number;
            kind: string;
            known_at: string;
            members_json: string;
          }>(COMMITS_SQL, [JSON.stringify(commitKeys)]),
          "commits",
        ).map((row): LoadedCommit => ({
          coreEpoch: row.core_epoch,
          commitSeq: row.commit_seq,
          kind: row.kind,
          knownAt: row.known_at,
          membersJson: row.members_json,
        }));
  const subjectRefs = [...new Set(legs.map((leg) => leg.subjectRef))].sort();
  bounded(subjectRefs, "subjects");
  const subjects =
    subjectRefs.length === 0
      ? []
      : (
          await sql.all<{
            subject_ref: string;
            bare_id: string | null;
            prefixed_id: string | null;
          }>(SUBJECTS_SQL, [JSON.stringify(subjectRefs)])
        ).map((row): LoadedSubject => {
          // Both forms naming two accounts is ambiguous: neither is chosen.
          if (row.prefixed_id !== null && row.bare_id === null)
            return {
              subjectRef: row.subject_ref,
              accountId: row.prefixed_id,
              form: "account-prefixed",
            };
          if (row.bare_id !== null && row.prefixed_id === null)
            return { subjectRef: row.subject_ref, accountId: row.bare_id, form: "bare-account" };
          return { subjectRef: row.subject_ref, accountId: null, form: "unrecognized" };
        });
  const pinSubjects = new Set<string>();
  for (const seal of seals) {
    try {
      const pins = JSON.parse(seal.identityPinsJson) as unknown;
      if (pins !== null && typeof pins === "object" && !Array.isArray(pins))
        for (const subject of Object.keys(pins)) pinSubjects.add(subject);
    } catch {
      // The domain half reports unreadable pins.
    }
  }
  const pinList = bounded([...pinSubjects].sort(), "pins");
  const pins =
    pinList.length === 0
      ? []
      : (
          await sql.all<{ subject: string; current_revision: number | null }>(PINS_SQL, [
            JSON.stringify(pinList),
          ])
        ).map((row): LoadedPin => ({
          subject: row.subject,
          currentRevision: row.current_revision,
        }));
  return { revisions, legs, subjects, claims, times, effects, seals, commits, pins };
}

/** The domain half's input for one cut of the loaded rows. */
export function selectorInput(
  meta: SelectorMeta,
  cut: ResolvedSelectorCut,
  scope: SelectionScope,
  rows: SelectorRows,
): SelectorInput {
  return {
    contract: ADOPTED_SELECTION_INPUT,
    requestedCut: cut.requested,
    cut: cut.cut,
    cutKnownAt: cut.knownAt,
    currentCoreEpoch: meta.currentCoreEpoch,
    currentIdentityEpoch: meta.currentIdentityEpoch,
    log: meta.log,
    scope,
    ...rows,
  };
}

/**
 * ?1 account id: the sources the account's current mappings come from. The
 * reconstruction query compares them with the reported-state perimeter to
 * tell an account no reported container lists (a card account) from one whose
 * container has no capture yet. `account_mappings` has no index by account,
 * so this reads the mapping table once; it holds one row per source account
 * revision, curated by the operator, not one per observation.
 */
export const ACCOUNT_SOURCES_SQL = `SELECT DISTINCT sa.source_id FROM current_account_mappings m
 CROSS JOIN source_accounts sa ON sa.id=m.source_account_id WHERE m.account_id=?1 ORDER BY sa.source_id`;
