// A synthetic economic history for the knowledge selector's tests: a writer
// that adopts, corrects, withdraws and merges events the way the guarded
// writers do (decision → revision → legs → supersede pointers → claims,
// times, effects → seal → commit row, through the storage builders of
// packages/storage-d1/src/atomic/economic-commit.ts and CORE 0070's
// triggers), and the same without the seal and commit (a revision written
// before the log started, or by an older build). It writes into a
// `DatedStore` (dated-state-fixture.ts), so the reported state and the
// economic history share one database. Every id, amount and date is invented.
import type { SQLQueryBindings } from "bun:sqlite";
import {
  INITIAL_IDENTITY_EPOCH,
  parseConsumptionKey,
  type AliasClass,
  type Book,
  type ConsumptionKey,
  type EventTimeRole,
  type IdentityPins,
  type LegEffect,
  type RevisionRef,
} from "../../domain/src/economic-contract.ts";
import type { EconomicEventKind, LegRole, RecognitionBasis } from "../../domain/src/events.ts";
import type { TemporalValue } from "../../domain/src/time.ts";
import {
  decisionEntry,
  economicFinalizationWrites,
} from "../../storage-d1/src/atomic/economic-commit.ts";
import type { SqlWrite } from "../../storage-d1/src/core/operations.ts";
import type { SqlExecutor } from "../src/reader.ts";
import type { DatedStore } from "./dated-state-fixture.ts";

export const PRINCIPAL = "rule:synthetic-economic-writer-v1";
export const WRITER_RELEASE = "synthetic-economic-writer-v1";

export interface LegSpec {
  subject: string;
  unit?: string;
  /** Decimal text, or null for a value the writer does not know. */
  amount: string | null;
  role: LegRole;
  basis: RecognitionBasis;
  /** An `economic_leg_effects` row; none when omitted (the legacy reading). */
  effect?: LegEffect;
  of?: number;
}

export interface ClaimSpec {
  book: Book;
  observationId: number;
  alias?: AliasClass | null;
}

export interface AdoptSpec {
  eventId: string;
  revision: number;
  kind?: EconomicEventKind;
  state?: string;
  unknownReason?: string | null;
  legs?: LegSpec[];
  times?: [EventTimeRole, TemporalValue][];
  supersedes?: RevisionRef[];
  claims?: ClaimSpec[];
  /** The worker clock of the commit (canonical UTC); the log keeps it non-decreasing. */
  knownAt?: string;
  /** False: no seal and no commit row (before the log, or an older build). */
  logged?: boolean;
  identityEpoch?: string;
  pins?: IdentityPins;
  writerRelease?: string;
  createdAt?: string;
}

export const day = (value: string): TemporalValue => ({
  kind: "local-date",
  value,
  zone: "Asia/Tokyo",
  basis: "provider",
});

function decimal(text: string): { coefficient: string; scale: number } {
  const negative = text.startsWith("-");
  const [integer, fraction = ""] = (negative ? text.slice(1) : text).split(".");
  const digits = `${integer}${fraction}`.replace(/^0+(?=\d)/u, "");
  const coefficient =
    digits === "0" || /^0+$/u.test(digits) ? "0" : `${negative ? "-" : ""}${digits}`;
  return { coefficient, scale: coefficient === "0" ? 0 : fraction.length };
}

export class EconomicHistory {
  constructor(readonly store: DatedStore) {}

  get db() {
    return this.store.db;
  }

  private run(writes: SqlWrite[]): void {
    this.db.transaction(() => {
      for (const write of writes) this.db.run(write.sql, write.binds as SQLQueryBindings[]);
    })();
  }

  /** A bank row with a provider id, for claims; returns its observation id. */
  bankRow(
    externalId: string,
    fetchedAt = "2026-03-01T03:00:00Z",
    sourceAccount = "synthetic-bank",
  ): number {
    const capture = this.store.capture({
      source: "smbc-bank",
      dataset: "synthetic-history",
      parser: "synthetic-bank-history",
      fetchedAt,
    });
    return Number(
      this.db.run(
        `INSERT INTO transaction_observations(parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,currency,description,counterparty,as_of,observed_at,raw_locator,extra_json)
         VALUES(?,?,?,'posted',-1,'-1',0,'JPY',NULL,NULL,'2026-03-01T00:00:00+09:00',NULL,'$.rows[0]','{}')`,
        [capture.parse, sourceAccount, externalId],
      ).lastInsertRowid,
    );
  }

  keyOf(observationId: number): ConsumptionKey {
    const row = this.db
      .query(
        `SELECT json_array(a.source_id,fr.producer_id,ses.external_id_namespace,t.source_account,t.external_id) AS k
         FROM transaction_observations t JOIN parse_runs p ON p.id=t.parse_run_id
         JOIN fetch_artifacts a ON a.id=p.fetch_artifact_id JOIN fetch_runs fr ON fr.id=a.fetch_run_id
         JOIN acquisition_sessions ses ON ses.id=fr.acquisition_session_id WHERE t.id=?`,
      )
      .get(observationId) as { k: string };
    const key = parseConsumptionKey(row.k);
    if (key === null) throw new Error("fixture key is not canonical");
    return key;
  }

  private parseRunOf(observationId: number): number {
    return (
      this.db
        .query("SELECT parse_run_id AS p FROM transaction_observations WHERE id=?")
        .get(observationId) as { p: number }
    ).p;
  }

  /** An account (and nothing else): leg subjects resolve against `accounts`. */
  account(id: string): void {
    this.db.run(
      "INSERT OR IGNORE INTO accounts(id,label,role,status) VALUES(?,'Synthetic','asset','identified')",
      [id],
    );
  }

  /** Declare the next identity epoch (a declared identity rewrite). */
  declareEpoch(name: string): void {
    const next =
      ((
        this.db.query("SELECT max(ordinal) AS n FROM economic_identity_epochs").get() as {
          n: number;
        }
      ).n ?? 0) + 1;
    this.db.run(
      "INSERT INTO economic_identity_epochs(ordinal,identity_epoch,reason_code,declared_at) VALUES(?,?,'synthetic-rewrite','2026-04-01T00:00:00.000Z')",
      [next, name],
    );
  }

  currentEpoch(): string {
    return (
      this.db
        .query(
          "SELECT identity_epoch AS e FROM economic_identity_epochs ORDER BY ordinal DESC LIMIT 1",
        )
        .get() as {
        e: string;
      }
    ).e;
  }

  adopt(spec: AdoptSpec): void {
    const { eventId, revision } = spec;
    const decisionId = `dr-${eventId}-${revision}`;
    const now = spec.knownAt ?? "2026-03-01T00:00:00.000Z";
    const createdAt = spec.createdAt ?? now;
    const supersedes =
      spec.supersedes ?? (revision > 1 ? [{ eventId, revision: revision - 1 }] : []);
    const legs = spec.legs ?? [];
    const kind = spec.kind ?? "card_settlement";
    const state = spec.state ?? "debited";
    const writes: SqlWrite[] = [
      {
        sql: `INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,operation_id,reason,evidence_refs_json,previous_revision,superseded_by,created_at)
 VALUES(?,'relation',?,?,?,'rule',?,NULL,'synthetic adoption','[]',?,NULL,?)`,
        binds: [
          decisionId,
          `event:${eventId}`,
          revision,
          revision === 1 ? "accept" : "supersede",
          PRINCIPAL,
          revision > 1 ? revision - 1 : null,
          createdAt,
        ],
      },
      {
        sql: `INSERT INTO economic_event_revisions(event_id,revision,kind,state,unknown_reason,effective_time_json,basis,evidence_support_json,decision_revision_id,superseded_by,created_at)
 VALUES(?,?,?,?,?,'{}',?,'["synthetic:evidence"]',?,NULL,?)`,
        binds: [
          eventId,
          revision,
          kind,
          state,
          spec.unknownReason ?? null,
          legs[0]?.basis ?? "cash-movement",
          decisionId,
          createdAt,
        ],
      },
    ];
    for (const [index, leg] of legs.entries()) {
      const value = leg.amount === null ? null : decimal(leg.amount);
      writes.push({
        sql: `INSERT INTO economic_legs(event_id,revision,leg_index,subject_ref,unit_ref,value_status,coefficient,scale,value_reason_code,role,basis)
 VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        binds: [
          eventId,
          revision,
          index,
          leg.subject,
          leg.unit ?? "JPY",
          value === null ? "missing" : "exact",
          value?.coefficient ?? null,
          value?.scale ?? null,
          value === null ? "synthetic_value_unknown" : null,
          leg.role,
          leg.basis,
        ],
      });
    }
    for (const prior of supersedes)
      writes.push({
        sql: "UPDATE economic_event_revisions SET superseded_by=? WHERE event_id=? AND revision=? AND superseded_by IS NULL",
        binds: [`${eventId}@${revision}`, prior.eventId, prior.revision],
      });
    const epoch = spec.identityEpoch ?? this.currentEpochOr(INITIAL_IDENTITY_EPOCH);
    const claims = (spec.claims ?? []).map((claim) => ({
      eventId,
      revision,
      book: claim.book,
      key: this.keyOf(claim.observationId),
      aliasClass: claim.alias ?? null,
      identityEpoch: epoch,
      observationId: claim.observationId,
      parseRunId: this.parseRunOf(claim.observationId),
    }));
    const times = (spec.times ?? []).map(([role, time]) => ({ eventId, revision, role, time }));
    const effects = legs.flatMap((leg, legIndex) =>
      leg.effect === undefined
        ? []
        : [
            {
              eventId,
              revision,
              legIndex,
              effect: leg.effect,
              ofLegIndex: leg.effect === "movement" ? null : (leg.of ?? 0),
            },
          ],
    );
    const entry = decisionEntry(decisionId);
    if (spec.logged === false) {
      // An older build: the same rows, no seal, no commit.
      const all = economicFinalizationWrites({
        entry,
        claims,
        times,
        effects,
        seals: [
          this.seal(spec, legs.length, claims.length, times.length, effects.length, epoch, now),
        ],
        commit: this.commit(spec, decisionId, supersedes, claims, now),
      });
      writes.push(...all.slice(0, claims.length + times.length + effects.length));
    } else
      writes.push(
        ...economicFinalizationWrites({
          entry,
          claims,
          times,
          effects,
          seals: [
            this.seal(spec, legs.length, claims.length, times.length, effects.length, epoch, now),
          ],
          commit: this.commit(spec, decisionId, supersedes, claims, now),
        }),
      );
    this.run(writes);
  }

  private currentEpochOr(fallback: string): string {
    try {
      return this.currentEpoch();
    } catch {
      return fallback;
    }
  }

  private seal(
    spec: AdoptSpec,
    legCount: number,
    claimCount: number,
    timeCount: number,
    effectCount: number,
    epoch: string,
    now: string,
  ) {
    return {
      eventId: spec.eventId,
      revision: spec.revision,
      writerRelease: spec.writerRelease ?? WRITER_RELEASE,
      legCount,
      claimCount,
      timeCount,
      effectCount,
      contentDigest: "c".repeat(64),
      identityPins: spec.pins ?? {},
      identityEpoch: epoch,
      now,
    };
  }

  private commit(
    spec: AdoptSpec,
    decisionId: string,
    supersedes: RevisionRef[],
    claims: { book: Book; key: ConsumptionKey }[],
    now: string,
  ) {
    const released = new Map<string, { book: Book; key: ConsumptionKey }>();
    for (const prior of supersedes)
      for (const row of this.db
        .query(
          "SELECT book,consumption_key AS k FROM economic_revision_claims WHERE event_id=? AND revision=?",
        )
        .all(prior.eventId, prior.revision) as { book: Book; k: string }[]) {
        const key = parseConsumptionKey(row.k)!;
        if (!claims.some((claim) => claim.book === row.book && JSON.stringify(claim.key) === row.k))
          released.set(`${row.book}\u0000${row.k}`, { book: row.book, key });
      }
    return {
      decisionRevisionId: decisionId,
      operationId: null,
      principal: PRINCIPAL,
      payloadDigest: "d".repeat(64),
      kind: "synthetic.adopt",
      members: [{ eventId: spec.eventId, revision: spec.revision, supersedes }],
      claims: claims.map(({ book, key }) => ({ book, key })),
      released: [...released.values()],
      now,
    };
  }
}

/** The store as the read model's executor. */
export function storeExecutor(db: {
  query(sql: string): {
    all(...a: SQLQueryBindings[]): unknown[];
    get(...a: SQLQueryBindings[]): unknown;
  };
}): SqlExecutor {
  return {
    all: async <T>(sql: string, args: readonly unknown[]) =>
      db.query(sql).all(...(args as SQLQueryBindings[])) as T[],
    first: async <T>(sql: string, args: readonly unknown[]) =>
      (db.query(sql).get(...(args as SQLQueryBindings[])) as T | null) ?? null,
  };
}
