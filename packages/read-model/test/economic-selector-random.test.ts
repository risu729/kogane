// The knowledge selector against an independent oracle on seeded random
// stores. Each store is a random economic history: adoptions, corrections that
// move an event between accounts or forms of its subject, withdrawals,
// cross-event merges, claims shared between events (in economic_claims and as
// legacy card purchase keys), alias classes, writes before the log started
// and by an older build after it (no seal, no commit), commits sharing a
// known_at, and identity epochs and pins that moved.
//
// The rows are written directly, with the 0032/0047/0070 triggers dropped and
// foreign keys off: the selector must read whatever is stored, including what
// the triggers refuse today (a second live holder, an unlogged successor).
//
// Two comparisons per store:
//   1. the SQL half's loaded rows equal the oracle's own closure of the model
//      (seed by both subject forms, supersession both ways, key and alias
//      holders), row for row;
//   2. at every cut, and at instants between and equal to commits, the
//      selection equals the oracle's replay: commits applied in sequence,
//      members becoming live and their `supersedes` dying, unlogged revisions
//      unknown unless a visible commit superseded them;
//   3. W11 (ADR 0054): at the last commit, an active revision is the stored
//      live one and its claims are its event's rows of live_consumption_claims.
// Every id and amount is invented.
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  selectAdopted,
  resolveInstantCut,
  type AdoptedSelection,
  type LoadedClaim,
  type SelectionScope,
} from "../../domain/src/knowledge-selector.ts";
import {
  loadSelectorRows,
  readSelectorMeta,
  resolveSelectorCut,
  selectorInput,
  type SelectorRows,
} from "../src/economic-selector.ts";
import { migrated } from "./card-usage-fixture";
import { storeExecutor } from "./economic-history-fixture";

const SEED_COUNT = Number(process.env["KOGANE_SELECTOR_SEEDS"] ?? 24);
const SEEDS = Array.from({ length: SEED_COUNT }, (_, index) => index + 1);
const EPOCH = "core-epoch-1";
const A = "acct-a";
const B = "acct-b";
const SUBJECTS = [A, `account:${A}`, B, `account:${B}`, "claim:synthetic"];
const KEYS = Array.from({ length: 5 }, (_, i) =>
  JSON.stringify(["smbc-bank", "producer-x", "ns-x", "synthetic-bank", `row-${i}`]),
);
const ALIASES = Array.from({ length: 3 }, (_, i) =>
  JSON.stringify(["smbc-bank", [`row-${i}`], A, "synthetic-rule-v1"]),
);

function random(seed: number): () => number {
  let state = (seed * 2654435761) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface ModelClaim {
  book: string;
  key: string;
  alias: string | null;
  legacy: boolean;
}
interface ModelRevision {
  eventId: string;
  revision: number;
  state: string;
  legs: { subject: string; amount: string }[];
  claims: ModelClaim[];
  supersededBy: string | null;
  /** The commit, or null for an unlogged write. */
  commit: number | null;
  supersedes: { eventId: string; revision: number }[];
  sealEpoch: string;
  pins: Record<string, number>;
}
interface Model {
  revisions: ModelRevision[];
  commits: { seq: number; knownAt: string }[];
  currentEpoch: string;
  mappings: Record<string, number>;
}

const ref = (row: { eventId: string; revision: number }) => `${row.eventId}@${row.revision}`;

function generate(seed: number): Model {
  const next = random(seed);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(next() * list.length)]!;
  const model: Model = {
    revisions: [],
    commits: [],
    currentEpoch: "identity-epoch-1",
    mappings: { "sa-1": 1 },
  };
  const heads = new Map<string, ModelRevision>();
  let eventCount = 0;
  let clock = Date.parse("2026-03-01T00:00:00.000Z");
  const steps = 10 + Math.floor(next() * 14);
  const preLog = Math.floor(next() * 4);
  for (let step = 0; step < steps; step += 1) {
    const logged = step >= preLog && next() > 0.12;
    const live = [...heads.values()].filter((row) => row.supersededBy === null);
    const op =
      live.length === 0
        ? "adopt"
        : pick(["adopt", "adopt", "correct", "correct", "withdraw", "merge"] as const);
    const claims = (): ModelClaim[] => {
      if (next() < 0.4) return [];
      const legacy = next() < 0.3;
      return [
        {
          book: legacy ? "card-usage" : pick(["cash-movement", "card-usage"]),
          key: pick(KEYS),
          alias: legacy || next() < 0.5 ? null : pick(ALIASES),
          legacy,
        },
      ];
    };
    const legs = () =>
      Array.from({ length: 1 + Math.floor(next() * 2) }, () => ({
        subject: pick(SUBJECTS),
        amount: String(1 + Math.floor(next() * 500)),
      }));
    let row: ModelRevision;
    const base = {
      supersededBy: null,
      sealEpoch: model.currentEpoch,
      pins: next() < 0.2 ? { "account_mapping:sa-1": 1 } : {},
    };
    if (op === "adopt") {
      eventCount += 1;
      row = {
        ...base,
        eventId: `ev-${eventCount}`,
        revision: 1,
        state: "debited",
        legs: legs(),
        claims: claims(),
        commit: null,
        supersedes: [],
      };
    } else {
      const head = pick(live);
      if (op === "merge" && live.length > 1) {
        const other = pick(live.filter((r) => r.eventId !== head.eventId));
        row = {
          ...base,
          eventId: head.eventId,
          revision: head.revision + 1,
          state: "debited",
          legs: legs(),
          claims: claims(),
          commit: null,
          supersedes: [head, other].map((r) => ({ eventId: r.eventId, revision: r.revision })),
        };
      } else
        row = {
          ...base,
          eventId: head.eventId,
          revision: head.revision + 1,
          state: op === "withdraw" ? "unknown" : "debited",
          legs: op === "withdraw" ? [] : legs(),
          claims: op === "withdraw" ? [] : claims(),
          commit: null,
          supersedes: [{ eventId: head.eventId, revision: head.revision }],
        };
    }
    for (const prior of row.supersedes) {
      const target = model.revisions.find((r) => ref(r) === ref(prior))!;
      target.supersededBy = ref(row);
    }
    if (logged) {
      if (next() < 0.6) clock += 1000 * Math.floor(next() * 3);
      const seq = model.commits.length + 1;
      model.commits.push({ seq, knownAt: new Date(clock).toISOString() });
      row.commit = seq;
    }
    model.revisions.push(row);
    heads.set(row.eventId, row);
    if (next() < 0.05) {
      model.currentEpoch =
        model.currentEpoch === "identity-epoch-1" ? "identity-epoch-2" : model.currentEpoch;
    }
  }
  if (next() < 0.3) model.mappings["sa-1"] = 2;
  if (next() < 0.2) model.currentEpoch = "identity-epoch-2";
  return model;
}

function write(model: Model): Database {
  const db = migrated();
  db.exec("PRAGMA foreign_keys=OFF");
  const triggers = db
    .query(
      `SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name IN ('economic_event_revisions','economic_legs','economic_claims',
        'economic_revision_seals','economic_commit_log','card_purchase_recognition_keys','economic_identity_epochs','account_mappings')`,
    )
    .all() as { name: string }[];
  for (const { name } of triggers) db.exec(`DROP TRIGGER ${name}`);
  db.run(
    "INSERT INTO accounts(id,label,role,status) VALUES(?,'a','asset','identified'),(?,'b','asset','identified')",
    [A, B],
  );
  db.run(
    "INSERT INTO account_mappings(id,source_account_id,revision,account_id,method,reason,policy_version,created_at,label,status) VALUES('m1','sa-1',1,?,'rule','r',1,'x','l','identified')",
    [A],
  );
  if (model.mappings["sa-1"] === 2)
    db.run(
      "INSERT INTO account_mappings(id,source_account_id,revision,account_id,method,reason,policy_version,created_at,label,status) VALUES('m2','sa-1',2,?,'rule','r',1,'x','l','identified')",
      [B],
    );
  if (model.currentEpoch === "identity-epoch-2")
    db.run(
      "INSERT INTO economic_identity_epochs VALUES(2,'identity-epoch-2','synthetic','2026-04-01T00:00:00.000Z')",
    );
  for (const row of model.revisions) {
    db.run(
      `INSERT INTO economic_event_revisions VALUES(?,?,'card_settlement',?,?,'{}','cash-movement','["e"]',?,?,'2026-03-01T00:00:00.000Z')`,
      [
        row.eventId,
        row.revision,
        row.state,
        row.state === "unknown" ? "conflicting_evidence" : null,
        `dr-${ref(row)}`,
        row.supersededBy,
      ],
    );
    for (const [index, leg] of row.legs.entries())
      db.run(
        `INSERT INTO economic_legs VALUES(?,?,?,?,'JPY','exact',?,0,NULL,'decrease','cash-movement')`,
        [row.eventId, row.revision, index, leg.subject, leg.amount],
      );
    for (const claim of row.claims)
      if (claim.legacy)
        db.run("INSERT INTO card_purchase_recognition_keys VALUES(?,?,?,'posted',1,1)", [
          row.eventId,
          row.revision,
          claim.key,
        ]);
      else
        db.run("INSERT INTO economic_claims VALUES(?,?,?,?,?,'identity-epoch-1',1,1)", [
          row.eventId,
          row.revision,
          claim.book,
          claim.key,
          claim.alias,
        ]);
    if (row.commit !== null) {
      db.run(
        "INSERT INTO economic_revision_seals VALUES(?,?,'synthetic-writer-v1',?,?,0,0,?,?,?,?,?,'x')",
        [
          row.eventId,
          row.revision,
          row.legs.length,
          row.claims.length,
          "c".repeat(64),
          JSON.stringify(row.pins),
          row.sealEpoch,
          EPOCH,
          row.commit,
        ],
      );
      const commit = model.commits[row.commit - 1]!;
      db.run(
        "INSERT INTO economic_commit_log VALUES(?,?,?,NULL,'rule:x',?,'synthetic.adopt',?,'[]','[]',?)",
        [
          EPOCH,
          commit.seq,
          `dr-${ref(row)}`,
          "d".repeat(64),
          JSON.stringify([
            {
              eventId: row.eventId,
              revision: row.revision,
              supersedes: row.supersedes.map((p) => [p.eventId, p.revision]),
            },
          ]),
          commit.knownAt,
        ],
      );
    }
  }
  return db;
}

const accountOf = (subject: string) =>
  subject === A || subject === `account:${A}`
    ? A
    : subject === B || subject === `account:${B}`
      ? B
      : null;

/** The oracle's closure: the events the scope touches, by its own reading of the model. */
function closure(model: Model): Set<string> {
  const events = new Set(
    model.revisions
      .filter((row) => row.legs.some((leg) => leg.subject === A || leg.subject === `account:${A}`))
      .map((row) => row.eventId),
  );
  for (let changed = true; changed;) {
    changed = false;
    const add = (eventId: string) => {
      if (!events.has(eventId)) {
        events.add(eventId);
        changed = true;
      }
    };
    const inside = model.revisions.filter((row) => events.has(row.eventId));
    for (const row of inside) if (row.supersededBy !== null) add(row.supersededBy.split("@")[0]!);
    for (const row of model.revisions)
      if (row.supersededBy !== null && inside.some((target) => ref(target) === row.supersededBy))
        add(row.eventId);
    const keys = new Set(
      inside.flatMap((row) => row.claims.map((claim) => `${claim.book}\u0000${claim.key}`)),
    );
    const aliases = new Set(
      inside.flatMap((row) =>
        row.claims.flatMap((claim) =>
          claim.alias === null ? [] : [`${claim.book}\u0000${claim.alias}`],
        ),
      ),
    );
    for (const row of model.revisions)
      for (const claim of row.claims)
        if (
          keys.has(`${claim.book}\u0000${claim.key}`) ||
          (claim.alias !== null && aliases.has(`${claim.book}\u0000${claim.alias}`))
        )
          add(row.eventId);
  }
  return events;
}

/** What the oracle expects at one cut: `ref:status` of the scoped revisions, their claims, conflicts and unlogged refs. */
function replay(model: Model, events: Set<string>, cut: number) {
  const dead = new Map<string, string>();
  const live = new Set<string>();
  for (const commit of model.commits.filter((c) => c.seq <= cut)) {
    const member = model.revisions.find((row) => row.commit === commit.seq)!;
    live.add(ref(member));
    for (const prior of member.supersedes) {
      live.delete(ref(prior));
      dead.set(ref(prior), ref(member));
    }
  }
  const byRef = new Map(model.revisions.map((row) => [ref(row), row]));
  const selected = new Map<string, { row: ModelRevision; status: string }>();
  const unlogged: string[] = [];
  for (const eventId of events) {
    const rows = model.revisions.filter((row) => row.eventId === eventId);
    const inForce = rows.filter((row) => live.has(ref(row)));
    const unknown = rows.filter((row) => row.commit === null && !dead.has(ref(row)));
    for (const row of unknown) unlogged.push(`${ref(row)}:no_commit`);
    for (const row of inForce)
      if (row.supersededBy !== null && byRef.get(row.supersededBy)!.commit === null) {
        unknown.push(row);
        unlogged.push(`${ref(row)}:successor_unlogged`);
      }
    const relevant = [...new Set([...inForce, ...unknown])];
    if (relevant.length === 0) continue;
    const status =
      unknown.length > 0
        ? "knowledge_unlogged"
        : inForce.length > 1
          ? "chain_inconsistent"
          : "active";
    for (const row of relevant) selected.set(ref(row), { row, status });
  }
  // Scope: a selected revision reaching a leg on A through its supersessions by the cut.
  const reach = (start: string): ModelRevision[] => {
    const out: ModelRevision[] = [];
    const queue = [start];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const at = queue.pop()!;
      if (seen.has(at)) continue;
      seen.add(at);
      out.push(byRef.get(at)!);
      for (const [prior, by] of dead) if (by === at) queue.push(prior);
    }
    return out;
  };
  const scoped = new Set<string>();
  for (const [at, { row }] of selected)
    if (reach(at).some((owner) => owner.legs.some((leg) => accountOf(leg.subject) === A)))
      scoped.add(row.eventId);
  const revisions = [...selected]
    .filter(([, { row }]) => scoped.has(row.eventId))
    .map(([at, { status }]) => `${at}:${status}`)
    .sort();
  const claims = [...selected]
    .filter(([, { row }]) => scoped.has(row.eventId))
    .flatMap(([at, { row }]) => row.claims.map((claim) => `${at}|${claim.book}|${claim.key}`))
    .sort();
  const groups = new Map<string, { refs: Set<string>; ids: Set<string> }>();
  for (const [at, { row }] of selected)
    for (const claim of row.claims)
      for (const [dimension, value, id] of [
        ["key", claim.key, row.eventId],
        ["alias", claim.alias, `${row.eventId}\u0000${claim.key}`],
      ] as const) {
        if (value === null) continue;
        const k = `${dimension}|${claim.book}|${value}`;
        const group = groups.get(k) ?? { refs: new Set(), ids: new Set() };
        group.refs.add(at);
        group.ids.add(id);
        groups.set(k, group);
      }
  const conflicts = [...groups]
    .filter(
      ([, group]) =>
        group.ids.size > 1 && [...group.refs].some((at) => scoped.has(at.split("@")[0]!)),
    )
    .map(([k, group]) => `${k}|${[...group.refs].sort().join(",")}`)
    .sort();
  const identity = [...selected]
    .filter(([, { row }]) => scoped.has(row.eventId) && row.commit !== null && row.commit <= cut)
    .flatMap(([at, { row }]) => {
      const reasons: string[] = [];
      if (row.sealEpoch !== model.currentEpoch) reasons.push("identity_epoch_changed");
      if (Object.entries(row.pins).some(([, pinned]) => pinned !== model.mappings["sa-1"]))
        reasons.push("identity_pin_moved");
      return reasons.length === 0 ? [] : [`${at}:${reasons.join(",")}`];
    })
    .sort();
  return {
    revisions,
    claims,
    conflicts,
    identity,
    unlogged: unlogged.filter((entry) => scoped.has(entry.split("@")[0]!)).sort(),
  };
}

function observed(selection: AdoptedSelection) {
  return {
    revisions: selection.revisions.map((row) => `${ref(row)}:${row.status}`).sort(),
    claims: selection.claims.map((claim) => `${ref(claim)}|${claim.book}|${claim.key}`).sort(),
    conflicts: selection.conflicts
      .map((c) => `${c.dimension}|${c.book}|${c.ref}|${c.holders.join(",")}`)
      .sort(),
    identity: selection.identityChanged
      .map((entry) => `${ref(entry)}:${entry.reasons.join(",")}`)
      .sort(),
    unlogged: selection.unlogged.map((entry) => `${ref(entry)}:${entry.reasonCode}`).sort(),
  };
}

const SCOPE: SelectionScope = {
  accounts: [A],
  instruments: null,
  kinds: null,
  legEffects: null,
  basis: null,
  range: null,
};

function shuffle<T>(list: readonly T[], next: () => number): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

describe("the knowledge selector against a replay oracle on random stores", () => {
  const drawn = {
    unlogged: 0,
    conflicts: 0,
    merges: 0,
    identity: 0,
    inScopeCuts: 0,
    currentState: 0,
  };
  for (const seed of SEEDS)
    test(`seed ${seed}`, async () => {
      const model = generate(seed);
      const db = write(model);
      const sql = storeExecutor(db);
      const meta = await readSelectorMeta(sql);
      const rows = await loadSelectorRows(sql, SCOPE);
      const events = closure(model);
      // 1. The SQL half loads exactly the oracle's closure.
      expect([...new Set(rows.revisions.map((row) => row.eventId))].sort()).toEqual(
        [...events].sort(),
      );
      const expectedClaims: LoadedClaim[] = model.revisions
        .filter((row) => events.has(row.eventId))
        .flatMap((row) =>
          row.claims.map((claim) => ({
            eventId: row.eventId,
            revision: row.revision,
            book: claim.book,
            consumptionKey: claim.key,
            aliasClass: claim.alias,
          })),
        );
      const sortClaims = (list: LoadedClaim[]) =>
        [...list].map((claim) => JSON.stringify(claim)).sort();
      expect(sortClaims(rows.claims)).toEqual(sortClaims(expectedClaims));
      expect(rows.legs.length).toBe(
        model.revisions
          .filter((row) => events.has(row.eventId))
          .reduce((n, row) => n + row.legs.length, 0),
      );
      expect(rows.seals.length).toBe(
        model.revisions.filter((row) => events.has(row.eventId) && row.commit !== null).length,
      );
      // 2. Every cut, by sequence and by instant.
      const next = random(seed + 1000);
      for (let cut = 0; cut <= model.commits.length; cut += 1) {
        const requested =
          cut === 0
            ? { coreEpoch: EPOCH, instant: "2026-02-28T00:00:00.000Z" }
            : { coreEpoch: EPOCH, commitSeq: cut };
        const resolved = await resolveSelectorCut(sql, meta, requested);
        expect(resolved.cut.commitSeq).toBe(cut === 0 ? 0 : cut);
        const result = await selectAdopted(selectorInput(meta, resolved, SCOPE, rows));
        if (!result.ok) throw new Error(result.error.code);
        expect(observed(result.selection)).toEqual(replay(model, events, cut));
        // The same rows in another order give the same set version.
        const shuffled: SelectorRows = Object.fromEntries(
          Object.entries(rows).map(([key, list]) => [key, shuffle(list as unknown[], next)]),
        ) as unknown as SelectorRows;
        const again = await selectAdopted(selectorInput(meta, resolved, SCOPE, shuffled));
        expect(again.ok && again.selection.setVersion).toBe(result.selection.setVersion);
        const expected = replay(model, events, cut);
        if (expected.unlogged.length > 0) drawn.unlogged += 1;
        if (expected.conflicts.length > 0) drawn.conflicts += 1;
        if (expected.identity.length > 0) drawn.identity += 1;
        if (expected.revisions.length > 0) drawn.inScopeCuts += 1;
      }
      // W11 (ADR 0054): at the log's last commit, what the selector resolved
      // from history is the current state: an active revision is the live
      // one, and its claims are exactly the live holders of its event.
      if (model.commits.length > 0) {
        const lastCut = await resolveSelectorCut(sql, meta, {
          coreEpoch: EPOCH,
          commitSeq: model.commits.length,
        });
        const last = await selectAdopted(selectorInput(meta, lastCut, SCOPE, rows));
        if (!last.ok) throw new Error(last.error.code);
        for (const row of last.selection.revisions.filter((r) => r.status === "active")) {
          const stored = db
            .query(
              "SELECT superseded_by AS s FROM economic_event_revisions WHERE event_id=? AND revision=?",
            )
            .get(row.eventId, row.revision) as { s: string | null };
          expect(stored.s).toBeNull();
          const live = (
            db
              .query(
                "SELECT book,consumption_key AS k FROM live_consumption_claims WHERE event_id=?",
              )
              .all(row.eventId) as {
              book: string;
              k: string;
            }[]
          )
            .map((claim) => `${claim.book}|${claim.k}`)
            .sort();
          expect(row.claims.map((claim) => `${claim.book}|${claim.key}`).sort()).toEqual(live);
          drawn.currentState += 1;
        }
      }
      if (
        model.revisions.some((row) => row.supersedes.some((prior) => prior.eventId !== row.eventId))
      )
        drawn.merges += 1;
      // Instants: each commit's own known_at resolves to the last commit sharing it.
      for (const commit of model.commits) {
        const resolved = await resolveSelectorCut(sql, meta, {
          coreEpoch: EPOCH,
          instant: commit.knownAt,
        });
        expect(resolved.cut.commitSeq).toBe(
          resolveInstantCut(
            model.commits.map((c) => ({ commitSeq: c.seq, knownAt: c.knownAt })),
            commit.knownAt,
          )!,
        );
      }
    });

  test("the seeds draw every case", () => {
    // Each case the oracle compares appears on some seed, so the comparison is not vacuous.
    if (SEED_COUNT < 24) return;
    expect(drawn.unlogged).toBeGreaterThan(0);
    expect(drawn.conflicts).toBeGreaterThan(0);
    expect(drawn.merges).toBeGreaterThan(0);
    expect(drawn.identity).toBeGreaterThan(0);
    expect(drawn.inScopeCuts).toBeGreaterThan(0);
    expect(drawn.currentState).toBeGreaterThan(0);
  });
});
