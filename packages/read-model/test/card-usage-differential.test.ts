// The rewritten current card usage reads against the text #233 and #236
// shipped (card-usage-legacy-sql.ts), row for row, on small random card stores
// (card-usage-fixture.ts). Each seed draws its states at random: failed runs,
// unpublished and unparsed pages (incomplete snapshots), re-parses that
// supersede a published parse, card ordinals that change between captures and
// cards one account resolves, months that flip from the customized family to
// the web family, tied capture times, unsealed, superseded and excluded
// identity runs, rows without an identity, an external id or a decimal-v1
// value or with malformed extras, MyJCB captures that replace one another, and
// live, merged, stale and retired recognitions. The last test checks that the
// seeds together drew every one of those states. Every value is synthetic.
import type { Database, SQLQueryBindings } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  cardPurchaseEventId,
  cardPurchaseRetirement,
  cardPurchaseRevision,
  type CardPurchaseDraft,
  classifyCardUsage,
  recognitionKey,
} from "../../domain/src/card-purchase.ts";
import { cardPurchaseRecognitionWrites } from "../../storage-d1/src/atomic/card-purchase-recognition.ts";
import {
  CURRENT_CARD_USAGE_SQL,
  type CurrentCardUsageRow,
  currentCardUsageSql,
  type PageSql,
  type StaleCardPurchaseKeyRow,
  staleCardPurchaseKeysSql,
  unrecognizedCardUsageCountSql,
} from "../src/index";
import {
  asCustomized,
  CardStore,
  myjcbRoot,
  type Parsed,
  TOKEN_A,
  TOKEN_B,
  type UsageRow,
  vpassCard,
} from "./card-usage-fixture";
import {
  LEGACY_CURRENT_CARD_USAGE_SQL,
  LEGACY_STALE_CARD_PURCHASE_KEYS_SQL,
  LEGACY_UNRECOGNIZED_CARD_USAGE_COUNT_SQL,
} from "./card-usage-legacy-sql";
import { factOf } from "./card-usage-scale-fixture";

/**
 * CI draws seeds 1–4 (about two seconds each); KOGANE_CARD_USAGE_SEEDS=n draws
 * seeds 1–n. The coverage check holds from four seeds up.
 */
const SEED_COUNT = Number(process.env["KOGANE_CARD_USAGE_SEEDS"] ?? 4);
if (!Number.isSafeInteger(SEED_COUNT) || SEED_COUNT < 1)
  throw new Error("KOGANE_CARD_USAGE_SEEDS must be a positive integer");
const SEEDS = Array.from({ length: SEED_COUNT }, (_, index) => index + 1);
const NOW = "2026-09-24T00:00:00.000Z";
const HOUR_MS = 3_600_000;
const TOKEN_C = `vpass-card-v1-${"c".repeat(64)}`;
const TOKENS = [TOKEN_A, TOKEN_B, TOKEN_C] as const;
const CARD_ACCOUNTS = ["acct-card-a", "acct-card-b", "acct-card-c"] as const;
const ORDINALS = ["card-001", "card-002", "card-003", "card-004"] as const;
const MONTHS = ["202604", "202605", "202606"] as const;
const CONNECTIONS = ["conn-a", "conn-b"] as const;
const PERIODS = ["202605", "2026年6月お支払い分", "2026年7月お支払い分"] as const;
/**
 * Mostly single payments, in each source's production shape (the Vpass web
 * code, MyJCB's wording); the rest are shapes recognition skips. A customized
 * (pending) page shows every row with `CUSTOMIZED_PAYMENT_TYPE`.
 */
const PAYMENT_TYPES = {
  vpass: ["1", "1", "1", "2", "5", ""],
  myjcb: ["1回払", "1回払", "1回払", "2回払", "リボ", "分割"],
} as const;

type Publication = "published" | "unpublished" | "none";

/** The states a seed drew, for the coverage check. */
const drawn = new Set<string>();

function random(seed: number): () => number {
  let state = (seed * 2_654_435_761) >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function all<T>(db: Database, sql: string, args: readonly unknown[]): T[] {
  return db.query(sql).all(...(args as SQLQueryBindings[])) as T[];
}

/** One read by the current text and by the shipped text; they must return the same rows. */
function same<T>(db: Database, page: PageSql, legacy: string): T[] {
  const found = all<T>(db, page.sql, page.args);
  expect(found).toEqual(all<T>(db, legacy, page.args));
  return found;
}

class RandomStore {
  readonly store = new CardStore();
  readonly db = this.store.db;
  /** The live draft of every event this store recognised. */
  readonly live = new Map<string, CardPurchaseDraft>();
  private readonly next: () => number;
  private time = Date.parse("2026-05-01T00:00:00.000Z");
  /** Re-parse ids, clear of the ids the card store assigns. */
  private reparseId = 1_000_000;
  private readonly pools = new Map<string, UsageRow[]>();
  private readonly ordinals = new Map<string, Set<string>>();
  private readonly decimalTrigger: string;

  constructor(seed: number) {
    this.next = random(seed);
    this.decimalTrigger = (
      this.db
        .query(
          "SELECT sql FROM sqlite_master WHERE type='trigger' AND name='transaction_decimals_v1'",
        )
        .get() as { sql: string }
    ).sql;
    if (this.chance(0.5)) {
      // A reviewed mapping resolves card C to card A's account.
      const cardC = vpassCard(TOKEN_C, "acct-card-c");
      this.store.mapAccount(cardC);
      this.store.mapAccount({ ...cardC, account: "acct-card-a" }, "manual");
      drawn.add("two cards, one account");
    }
  }

  private chance(probability: number): boolean {
    return this.next() < probability;
  }

  private int(low: number, high: number): number {
    return low + Math.floor(this.next() * (high - low + 1));
  }

  private pick<T>(values: readonly T[]): T {
    return values[Math.floor(this.next() * values.length)]!;
  }

  private shuffled<T>(values: readonly T[]): T[] {
    const result = [...values];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const other = Math.floor(this.next() * (index + 1));
      [result[index], result[other]] = [result[other]!, result[index]!];
    }
    return result;
  }

  /** The next capture time; now and then the same as the last, so run ids break the tie. */
  private at(): string {
    if (this.chance(0.15)) drawn.add("tied capture time");
    else this.time += this.int(1, 72) * HOUR_MS;
    return new Date(this.time).toISOString();
  }

  private publication(): Publication {
    const draw = this.next();
    const publication = draw < 0.84 ? "published" : draw < 0.92 ? "unpublished" : "none";
    drawn.add(`publication ${publication}`);
    return publication;
  }

  /** The rows one card-month or period can show, fixed per store so captures re-state them. */
  private pool(key: string, date: (day: number) => string, myjcb: boolean): UsageRow[] {
    let pool = this.pools.get(key);
    if (pool === undefined) {
      pool = Array.from({ length: 6 }, (_, index): UsageRow => {
        const paymentType: string = this.pick(PAYMENT_TYPES[myjcb ? "myjcb" : "vpass"]);
        const yen = (this.int(1, 300) * 100).toLocaleString("en-US");
        const amount = this.chance(0.1) ? `-${yen}` : yen;
        return {
          date: date(1 + index * 4),
          merchant: `架空店舗-${key}-${index}`,
          amount,
          paymentType,
          ...(myjcb
            ? {
                other: this.chance(0.85) ? amount : "1,000",
                ...(paymentType === "分割" ? { installment: "1" } : {}),
              }
            : {}),
        };
      });
      this.pools.set(key, pool);
    }
    return pool;
  }

  /** 1–4 rows of a pool; a row drawn twice is two identical rows on one page. */
  private rows(pool: readonly UsageRow[], amountless: boolean): UsageRow[] {
    return Array.from({ length: this.int(1, 4) }, () => {
      const row = this.pick(pool);
      return amountless && this.chance(0.05) ? { ...row, amount: "" } : row;
    });
  }

  /**
   * Sometimes appends a row no parser emits to a fresh parse: no external id,
   * malformed or mistyped extras, and now and then no decimal-v1 value.
   */
  private appended(parsed: Parsed): number | null {
    if (parsed.observations.length === 0 || !this.chance(0.3)) return null;
    const original = this.db
      .query("SELECT external_id, extra_json FROM transaction_observations WHERE id=?")
      .get(parsed.observations[0]!) as { external_id: string; extra_json: string };
    const withoutDecimal = this.chance(0.3);
    if (withoutDecimal) {
      this.db.exec("DROP TRIGGER transaction_decimals_v1");
      drawn.add("row without a decimal-v1 value");
    }
    const shape = this.int(0, 2);
    drawn.add(["row without an external id", "malformed extras", "mistyped extras"][shape]!);
    const id = this.store.appendRow(
      parsed,
      shape === 0
        ? { externalId: null, extraJson: original.extra_json }
        : shape === 1
          ? { externalId: `${original.external_id}-malformed`, extraJson: "{" }
          : {
              externalId: `${original.external_id}-mistyped`,
              extraJson: JSON.stringify({
                _kogane: { statementFamily: 5, statementMonth: "", period: ["x"] },
                data: [1, 2, 3, 4, 5, 6, 7],
                summaryCells: [null, "", 3],
              }),
            },
    );
    if (withoutDecimal) this.db.exec(this.decimalTrigger);
    return id;
  }

  /** A published parse re-parsed and republished: the old run is superseded. */
  private reparse(parsed: Parsed): Parsed {
    this.reparseId += 1;
    const id = this.reparseId;
    const old = this.db
      .query("SELECT fetch_artifact_id, parser_name, parser_version FROM parse_runs WHERE id=?")
      .get(parsed.parse) as {
      fetch_artifact_id: number;
      parser_name: string;
      parser_version: string;
    };
    // A run of one (artifact, parser, version) is unique: the re-parse is a new release.
    const version = `${old.parser_version}-reparse-${id}`;
    this.db.run(
      "INSERT INTO parse_runs(id,fetch_artifact_id,parser_name,parser_version,parsed_at,status,warnings_json) VALUES(?,?,?,?,'2026-09-02','pending','[]')",
      [id, old.fetch_artifact_id, old.parser_name, version],
    );
    // The re-parse drops the first row now and then.
    const kept = this.chance(0.5) ? parsed.observations.slice(1) : parsed.observations;
    const observations = kept.map((observation) =>
      Number(
        this.db.run(
          `INSERT INTO transaction_observations(parse_run_id,source_account,external_id,status,amount_minor,amount_text,amount_scale,currency,description,counterparty,as_of,observed_at,raw_locator,extra_json)
           SELECT ?,source_account,external_id,status,amount_minor,amount_text,amount_scale,currency,description,counterparty,as_of,observed_at,raw_locator,extra_json
           FROM transaction_observations WHERE id=?`,
          [id, observation],
        ).lastInsertRowid,
      ),
    );
    this.db.run("UPDATE parse_runs SET status='ok' WHERE id=?", [id]);
    this.db.run(
      "INSERT INTO publication_events(fetch_artifact_id,parser_name,previous_parse_run_id,new_parse_run_id,kind,actor,reason,occurred_at) VALUES(?,?,?,?,'normal','pipeline','parse_ok','2026-09-02')",
      [old.fetch_artifact_id, old.parser_name, parsed.parse, id],
    );
    this.db.run(
      "UPDATE published_parse_runs SET parse_run_id=?,parser_version=?,published_at='2026-09-02' WHERE parse_run_id=?",
      [id, version, parsed.parse],
    );
    this.db.run("UPDATE parse_runs SET superseded_by_parse_run_id=? WHERE id=?", [
      id,
      parsed.parse,
    ]);
    drawn.add("superseded parse");
    return { artifact: parsed.artifact, parse: id, observations };
  }

  /** Appended rows, identity, and now and then a re-parse identified again. */
  private settle(
    parsed: Parsed,
    publication: Publication,
    identify: (parsed: Parsed) => void,
  ): void {
    if (parsed.parse === 0) return;
    const extra = this.appended(parsed);
    // A seal covers every row of its parse, so an appended row is identified with it.
    identify(
      extra === null ? parsed : { ...parsed, observations: [...parsed.observations, extra] },
    );
    if (publication === "published" && this.chance(0.12)) identify(this.reparse(parsed));
  }

  /** One Vpass capture: some cards, each under a fresh ordinal of this run, some months each. */
  vpassCapture(): void {
    const outcome = this.chance(0.15) ? "failure" : "success";
    drawn.add(`vpass run ${outcome}`);
    const run = this.store.run("vpass", outcome);
    const fetchedAt = this.at();
    const ordinals = this.shuffled(ORDINALS);
    TOKENS.forEach((token, index) => {
      if (!this.chance(0.75)) return;
      const card = ordinals[index]!;
      const seen = this.ordinals.get(token) ?? new Set<string>();
      seen.add(card);
      this.ordinals.set(token, seen);
      if (seen.size > 1) drawn.add("card ordinal changed");
      // A trusted binding needs a successful financial run (migration 0020).
      const binding =
        outcome === "success" && this.chance(0.9) ? this.store.bind(run, card, token) : null;
      const spec = vpassCard(token, CARD_ACCOUNTS[index]!);
      const perRun = {
        ref: `sa-${card}-run-${run}`,
        reference: [`vpass:${card}`, "fetch-run", String(run)],
        account: `acct-${card}-run-${run}`,
        status: "unresolved" as const,
      };
      const identify = (parsed: Parsed): void => {
        const draw = this.next();
        if (draw < 0.1) {
          drawn.add("parse never identified");
          return;
        }
        if (binding === null || draw < 0.3) {
          // The default policy never names a card token (migration 0020).
          this.store.identify(parsed, perRun, { version: 1 }, this.chance(0.9));
          drawn.add("identity v1");
          if (binding === null || !this.chance(0.5)) return;
          drawn.add("identity v1 superseded by v2");
        }
        const sealed = this.chance(0.9);
        if (!sealed) drawn.add("identity run unsealed");
        this.store.identify(parsed, spec, { version: 2, bindingArtifact: binding, token }, sealed);
      };
      for (const month of MONTHS) {
        if (!this.chance(0.6)) continue;
        const family = this.chance(0.5) ? "web" : "customized";
        drawn.add(`vpass ${family}`);
        const pool = this.pool(
          `v${index}-${month}`,
          (day) => `26/${month.slice(4)}/${String(day).padStart(2, "0")}`,
          false,
        );
        const pages = this.int(1, 3);
        for (let page = 0; page < pages; page += 1) {
          const publication = this.publication();
          const parsed = this.store.vpassPage({
            run,
            card,
            month,
            // Web pages are all `top-NNN`; customized pages after the first are `answer-NNN`.
            page: `${family === "customized" && page > 0 ? "answer" : "top"}-${String(page).padStart(3, "0")}`,
            family,
            // A pending page shows the pool's rows with the customized family's code.
            rows:
              family === "web" ? this.rows(pool, true) : asCustomized(this.rows(pool, false)),
            fetchedAt,
            publication,
          });
          this.settle(parsed, publication, identify);
        }
      }
      if (binding !== null && this.chance(0.1)) {
        this.store.excludeBinding(binding);
        drawn.add("binding excluded");
      }
    });
  }

  /** One MyJCB capture: per connection, the unconfirmed ledger and confirmed ledgers. */
  myjcbCapture(): void {
    const outcome = this.chance(0.15) ? "failure" : "success";
    drawn.add(`myjcb run ${outcome}`);
    const run = this.store.run("myjcb", outcome);
    const fetchedAt = this.at();
    for (const connection of CONNECTIONS) {
      if (!this.chance(0.75)) continue;
      const spec = myjcbRoot(connection, `acct-jcb-${connection}`);
      const identify = (parsed: Parsed): void => {
        if (this.chance(0.1)) return;
        this.store.identify(parsed, spec, { version: 1 }, this.chance(0.9));
      };
      for (let detail = 0; detail < 3; detail += 1) {
        if (!this.chance(0.7)) continue;
        const state = detail === 0 ? "unconfirmed" : "confirmed";
        drawn.add(`myjcb ${state}`);
        const period = this.pick(PERIODS);
        const pool = this.pool(
          `j-${connection}-${period}`,
          (day) => `2026/05/${String(day).padStart(2, "0")}`,
          true,
        );
        const publication = this.publication();
        const parsed = this.store.myjcbLedger({
          run,
          connection,
          detailMonth: detail,
          state,
          period,
          rows: this.rows(pool, false),
          fetchedAt,
          publication,
        });
        this.settle(parsed, publication, identify);
      }
    }
  }

  /** A few captures of every kind. */
  capture(count: number): void {
    for (let index = 0; index < count; index += 1) {
      this.vpassCapture();
      if (this.chance(0.7)) this.myjcbCapture();
      if (this.chance(0.3)) this.store.bankRow(this.store.run("smbc-bank"), this.at());
    }
  }

  private write(draft: CardPurchaseDraft, expectedRevision: number | null): boolean {
    const writes = cardPurchaseRecognitionWrites({ draft, expectedRevision, now: NOW });
    return this.db.transaction(
      () =>
        writes.map(
          (entry) => this.db.run(entry.sql, entry.binds as SQLQueryBindings[]).changes,
        )[0]! > 0,
    )();
  }

  private held(key: string): boolean {
    return (
      this.db.query("SELECT 1 FROM current_card_purchase_keys WHERE recognition_key=?").get(key) !==
      null
    );
  }

  /**
   * Recognises most unheld current rows, as the lane does; now and then one
   * revision also holds an unheld key of another row of the same source,
   * current or not (the shape a reviewed pending-to-posted merge leaves).
   */
  async recognise(): Promise<void> {
    const rows = all<CurrentCardUsageRow>(this.db, CURRENT_CARD_USAGE_SQL, [0, -1]);
    for (const row of rows) {
      if (row.recognition_key === null || this.held(row.recognition_key) || !this.chance(0.85))
        continue;
      const fact = factOf(row);
      if (fact === null) continue;
      const classified = classifyCardUsage(fact);
      const key = recognitionKey(fact);
      if (!classified.ok || key === null) continue;
      const draft = await cardPurchaseRevision({
        action: "recognize",
        eventId: await cardPurchaseEventId(classified.kind, key),
        revision: 1,
        fact,
      });
      if (draft === null) continue;
      const partner = this.chance(0.2) ? this.partner(row) : undefined;
      const merged: CardPurchaseDraft =
        partner === undefined ? draft : { ...draft, keys: [...draft.keys, partner] };
      if (partner !== undefined) drawn.add("merged revision");
      if (this.write(merged, null)) this.live.set(merged.revision.eventId, merged);
    }
  }

  /** An unheld key of another row of the row's source, with the role its status gives. */
  private partner(row: CurrentCardUsageRow): CardPurchaseDraft["keys"][number] | undefined {
    const candidates = all<{
      observation_id: number;
      parse_run_id: number;
      status: string;
      recognition_key: string;
    }>(
      this.db,
      `SELECT t.id AS observation_id, t.parse_run_id, t.status,
              json_array(a.source_id, fr.producer_id, ses.external_id_namespace, t.source_account, t.external_id) AS recognition_key
         FROM transaction_observations t
         JOIN parse_runs p ON p.id = t.parse_run_id
         JOIN fetch_artifacts a ON a.id = p.fetch_artifact_id
         JOIN fetch_runs fr ON fr.id = a.fetch_run_id
         JOIN acquisition_sessions ses ON ses.id = fr.acquisition_session_id
        WHERE a.source_id = ? AND t.external_id IS NOT NULL
          AND t.status IN ('unconfirmed', 'posted', 'confirmed')
        ORDER BY t.id`,
      [row.source_id],
    ).filter(
      (candidate) =>
        candidate.recognition_key !== row.recognition_key && !this.held(candidate.recognition_key),
    );
    if (candidates.length === 0) return undefined;
    const chosen = this.pick(candidates);
    return {
      key: chosen.recognition_key,
      role: chosen.status === "unconfirmed" ? "pending" : "posted",
      observationId: chosen.observation_id,
      parseRunId: chosen.parse_run_id,
    };
  }

  /** Retires about half of the events the stale read reports. */
  async retire(): Promise<void> {
    const stale = all<StaleCardPurchaseKeyRow>(
      this.db,
      LEGACY_STALE_CARD_PURCHASE_KEYS_SQL,
      staleCardPurchaseKeysSql(1000).args,
    );
    for (const eventId of new Set(stale.map((row) => row.event_id))) {
      if (!this.chance(0.5)) continue;
      const live = this.live.get(eventId)!;
      const retirement = await cardPurchaseRetirement({
        live: live.revision,
        keys: live.keys,
        sidecar: live.sidecar,
      });
      if (retirement !== null && this.write(retirement, live.revision.revision)) {
        this.live.set(eventId, retirement);
        drawn.add("retired event");
      }
    }
  }
}

/**
 * Every read the lane and the operator view make, by both texts: the whole
 * set, the lane's paging at two page sizes, short pages after cursors inside
 * the set, the stale keys at every page size and the unrecognised count.
 */
function expectSameReads(db: Database): void {
  const current = same<CurrentCardUsageRow>(
    db,
    { sql: CURRENT_CARD_USAGE_SQL, args: [0, -1] },
    LEGACY_CURRENT_CARD_USAGE_SQL,
  );
  for (const limit of [25, 1000]) {
    const paged: CurrentCardUsageRow[] = [];
    for (let afterId = 0; ;) {
      const page = same<CurrentCardUsageRow>(
        db,
        currentCardUsageSql({ afterId, limit }),
        LEGACY_CURRENT_CARD_USAGE_SQL,
      );
      paged.push(...page);
      if (page.length < limit) break;
      afterId = page.at(-1)!.observation_id;
    }
    expect(paged).toEqual(current);
  }
  for (const row of [0.3, 0.7].map((at) => current[Math.floor(current.length * at)]!))
    for (const limit of [1, 3])
      same(
        db,
        currentCardUsageSql({ afterId: row.observation_id, limit }),
        LEGACY_CURRENT_CARD_USAGE_SQL,
      );
  for (const limit of [1, 3, 100, 1000]) {
    const stale = same<StaleCardPurchaseKeyRow>(
      db,
      staleCardPurchaseKeysSql(limit),
      LEGACY_STALE_CARD_PURCHASE_KEYS_SQL,
    );
    if (stale.length > 0) drawn.add("stale keys");
    if (stale.some((row) => row.key_count > 1)) drawn.add("stale merged revision");
  }
  same(db, unrecognizedCardUsageCountSql(), LEGACY_UNRECOGNIZED_CARD_USAGE_COUNT_SQL);

  const rows = current;
  if (rows.some((row) => row.recognition_key === null)) drawn.add("current row without a key");
  if (rows.some((row) => row.source_account_id === null)) drawn.add("current row without identity");
  if (rows.some((row) => row.value_status === null)) drawn.add("current row without decimal-v1");
  if (rows.some((row) => row.provider_family === null)) drawn.add("current row without extras");
  if (rows.some((row) => row.policy_family === "vpass-card-binding"))
    drawn.add("current row identified by binding");
  if (rows.some((row) => row.policy_family === "identity-default"))
    drawn.add("current row identified by default");
  for (const row of rows) drawn.add(`current ${row.source_id} ${row.display_state}`);
}

describe("the rewritten reads equal the shipped reads on random card stores", () => {
  for (const seed of SEEDS)
    test(`seed ${seed}`, async () => {
      // Each read costs a few milliseconds whatever the store, so three checkpoints:
      // captures only, live events of which some are stale, then some retired.
      const world = new RandomStore(seed);
      world.capture(4);
      expectSameReads(world.db);
      await world.recognise();
      world.capture(3);
      expectSameReads(world.db);
      await world.retire();
      await world.recognise();
      expectSameReads(world.db);
    }, 30_000);

  test.if(SEED_COUNT >= 4)("the seeds drew every state the shipped reads handle", () => {
    expect([...drawn].sort()).toEqual(
      [
        "binding excluded",
        "card ordinal changed",
        "current myjcb pending",
        "current myjcb posted",
        "current row identified by binding",
        "current row identified by default",
        "current row without a key",
        "current row without decimal-v1",
        "current row without extras",
        "current row without identity",
        "current vpass pending",
        "current vpass posted",
        "identity run unsealed",
        "identity v1",
        "identity v1 superseded by v2",
        "malformed extras",
        "merged revision",
        "mistyped extras",
        "myjcb confirmed",
        "myjcb run failure",
        "myjcb run success",
        "myjcb unconfirmed",
        "parse never identified",
        "publication none",
        "publication published",
        "publication unpublished",
        "retired event",
        "row without a decimal-v1 value",
        "row without an external id",
        "stale keys",
        "stale merged revision",
        "superseded parse",
        "tied capture time",
        "two cards, one account",
        "vpass customized",
        "vpass run failure",
        "vpass run success",
        "vpass web",
      ].sort(),
    );
  });
});
