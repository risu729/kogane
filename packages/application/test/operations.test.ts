// The pure half of the operations services (02 §4-5, U06): how a request is
// identified, what a stage list means, and what a session policy grants. The
// SQL half is exercised against the real migrations in
// services/app/test/ops-api.test.ts.
import { expect, test } from "bun:test";
import {
  OPERATION_KINDS,
  OPERATION_STAGES,
  operationIdFor,
  operationPayloadDigest,
  recordOperationStage,
  sessionRefreshPolicy,
  STAGE_STATES,
  STAGES_BY_KIND,
} from "../src/index.ts";
import { COLLECTION_STAGES, JOB_OUTCOMES, NEVER_COMPLETE_ON } from "../../collection/src/stages.ts";

const COLLECTION = {
  source: "sony-bank",
  requestedScope: { from: "2026-01-01", to: "2026-01-31" },
};

test("the same request is the same operation, whoever sent it twice (G3-06)", async () => {
  const digest = await operationPayloadDigest("collection", COLLECTION);
  // The key never changes what was asked for, so a retry under a key and the
  // first send of the same payload agree on the payload digest.
  expect(await operationPayloadDigest("collection", { ...COLLECTION, idempotencyKey: "a" })).toBe(
    digest,
  );
  // Key order does not change it either; a different value does.
  expect(
    await operationPayloadDigest("collection", {
      requestedScope: { to: "2026-01-31", from: "2026-01-01" },
      source: "sony-bank",
    }),
  ).toBe(digest);
  expect(
    await operationPayloadDigest("collection", {
      ...COLLECTION,
      requestedScope: { from: "2026-01-01", to: "2026-02-01" },
    }),
  ).not.toBe(digest);
  // The same payload under a different kind is a different operation.
  expect(await operationPayloadDigest("import", { source: "sony-bank", runId: "r" })).not.toBe(
    digest,
  );
});

test("an operation id is bound to its principal", async () => {
  const mine = await operationIdFor("collection", "operator-a", "nightly");
  expect(mine).toMatch(/^op_[0-9a-f]{64}$/u);
  expect(await operationIdFor("collection", "operator-a", "nightly")).toBe(mine);
  // Two principals sending the same key hold two operations, so one caller's
  // retry key can never address another caller's work.
  expect(await operationIdFor("collection", "operator-b", "nightly")).not.toBe(mine);
  expect(await operationIdFor("projection", "operator-a", "nightly")).not.toBe(mine);
});

test("every kind reports the stages it can actually reach, in contract order", () => {
  for (const kind of OPERATION_KINDS) {
    const stages = STAGES_BY_KIND[kind];
    // Only names from contracts/stages.json, in its order, without repeats.
    expect(stages.every((stage) => OPERATION_STAGES.includes(stage))).toBe(true);
    expect(
      [...stages].sort((a, b) => OPERATION_STAGES.indexOf(a) - OPERATION_STAGES.indexOf(b)),
    ).toEqual([...stages]);
    expect(new Set(stages).size).toBe(stages.length);
  }
  // A replay does not re-persist or re-register evidence, and a rebuild only
  // republishes: claiming those stages would claim progress nobody made.
  expect(STAGES_BY_KIND.collection).toEqual([...OPERATION_STAGES]);
  expect(STAGES_BY_KIND.replay).toEqual(["parsed", "adopted", "projected"]);
  expect(STAGES_BY_KIND.projection).toEqual(["projected"]);
  expect(STAGES_BY_KIND["session-refresh"]).toEqual([]);
});

test("the stage vocabulary is the shared one, and completion is refused for the four reasons", async () => {
  // One definition (packages/collection, 03 §5), not a second copy that can
  // drift from the run the operation is about.
  expect(OPERATION_STAGES).toBe(COLLECTION_STAGES);
  expect(STAGE_STATES).toBe(JOB_OUTCOMES);
  // A store that would fail loudly if the guard let a call through.
  const store = {
    first: () => Promise.reject(new Error("the store must not be reached")),
    all: () => Promise.reject(new Error("the store must not be reached")),
    batch: () => Promise.reject(new Error("the store must not be reached")),
  };
  for (const reason of NEVER_COMPLETE_ON) {
    await expect(
      recordOperationStage({
        store,
        operationId: "op_" + "0".repeat(64),
        stage: "projected",
        state: "completed",
        failureCode: reason,
        now: "2026-09-11T00:00:00Z",
      }),
    ).rejects.toThrow("stage_cannot_complete_on_reason");
  }
});

test("a session refresh needs a person unless the deployment says otherwise (G3-11)", () => {
  // Absent, empty, malformed, wrong shape, or a mode nobody defined: a human.
  for (const configured of [
    undefined,
    "",
    "not json",
    "[]",
    '"unattended"',
    '{"sony-bank":"automatic"}',
    '{"sony-bank":true}',
  ])
    expect(sessionRefreshPolicy(configured)("sony-bank")).toBe("human");
  const policy = sessionRefreshPolicy('{"sony-bank":"unattended"}');
  expect(policy("sony-bank")).toBe("unattended");
  // Naming one source never grants another.
  expect(policy("other-test")).toBe("human");
});

// ── the SQL half, against the real migrations ───────────────────────────

import { migratedDatabase, sqliteCommandStore } from "./sqlite-store.ts";
import { recordDispatch, requestCollection, requestReplay } from "../src/index.ts";
import type { CommandStore, Principal } from "../src/command/contract.ts";

const OPERATOR: Principal = {
  id: "ops-operator",
  kind: "human",
  verification: "server",
  capabilities: ["interpretation.propose", "interpretation.accept"],
};
const NOW = "2026-09-11T00:00:00Z";

function gate(): { wait: Promise<void>; open: () => void } {
  let open: () => void = () => {};
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

/**
 * Two senders of one key, interleaved the way a real race is and in a fixed
 * order: the winner reads "no such operation", the loser reads the same, the
 * winner writes, the loser writes. The registry reads before the operation
 * read take no part. Every step is sequenced by a gate, so the outcome does
 * not depend on how long a digest takes.
 */
function racingStores(store: CommandStore): [CommandStore, CommandStore] {
  const winnerRead = gate();
  const loserRead = gate();
  const winnerWrote = gate();
  const isOperationRead = (sql: string) => sql.includes("FROM ops_requests");
  let winnerReads = 0;
  const winner: CommandStore = {
    ...store,
    first: async <T>(sql: string, binds?: readonly unknown[]) => {
      const row = await store.first<T>(sql, binds);
      if (isOperationRead(sql) && winnerReads++ === 0) {
        expect(row).toBeNull();
        winnerRead.open();
      }
      return row;
    },
    batch: async (writes) => {
      await loserRead.wait;
      const outcome = await store.batch(writes);
      winnerWrote.open();
      return outcome;
    },
  };
  let loserReads = 0;
  const loser: CommandStore = {
    ...store,
    first: async <T>(sql: string, binds?: readonly unknown[]) => {
      if (isOperationRead(sql) && loserReads++ === 0) {
        await winnerRead.wait;
        const row = await store.first<T>(sql, binds);
        // The loser has now seen "no such operation" too; let the winner write.
        expect(row).toBeNull();
        loserRead.open();
        return row;
      }
      return store.first<T>(sql, binds);
    },
    batch: async (writes) => {
      await winnerWrote.wait;
      return store.batch(writes);
    },
  };
  return [winner, loser];
}

test("a raced re-send of the same key and payload is one operation, created once (G3-06, G3-14)", async () => {
  const db = migratedDatabase();
  const [a, b] = racingStores(sqliteCommandStore(db));
  const request = { ...COLLECTION, idempotencyKey: "raced-same" };
  const [first, second] = await Promise.all([
    requestCollection({ store: a, principal: OPERATOR, now: NOW, request }),
    requestCollection({ store: b, principal: OPERATOR, now: NOW, request }),
  ]);
  if (!first.ok || !second.ok) throw new Error("both senders must be answered with the record");
  expect(second.receipt).toEqual(first.receipt);
  // The winner created the row; the loser was told it replayed it, even
  // though its own read had said the operation did not exist yet.
  expect(first.replayed).toBe(false);
  expect(second.replayed).toBe(true);
  expect(db.query("SELECT count(*) AS n FROM ops_requests").get()).toEqual({ n: 1 });
});

test("a raced re-send of the same key with another payload is a conflict, never a second run", async () => {
  const db = migratedDatabase();
  const [a, b] = racingStores(sqliteCommandStore(db));
  const outcomes = await Promise.all([
    requestCollection({
      store: a,
      principal: OPERATOR,
      now: NOW,
      request: { ...COLLECTION, idempotencyKey: "raced-different" },
    }),
    requestCollection({
      store: b,
      principal: OPERATOR,
      now: NOW,
      request: {
        source: "sony-bank",
        requestedScope: { from: "2026-02-01", to: "2026-02-28" },
        idempotencyKey: "raced-different",
      },
    }),
  ]);
  const [winner, loser] = outcomes;
  if (!winner?.ok) throw new Error("the winner must be accepted");
  // The loser is refused with the id and nothing else: no window, no source.
  expect(loser).toEqual({
    ok: false,
    error: "idempotency_conflict",
    refs: [winner.receipt.operationId],
  });
  const rows = db.query("SELECT request_json FROM ops_requests").all() as {
    request_json: string;
  }[];
  expect(rows).toHaveLength(1);
  // And the one stored payload is the winner's.
  expect(JSON.parse(rows[0]!.request_json)).toEqual(COLLECTION);
});

test("a replay raced under one key plans the replay once", async () => {
  const db = migratedDatabase();
  db.run(
    `INSERT INTO parser_releases(release_id,parser_name,semantic_version,code_digest,
      input_contract_version,output_contract_version,metadata_extractor_release,
      dependency_digests_json,registered_at)
      VALUES('fixture-release','fixture','1.0.0','digest','in','out','meta','{}','2026-09-07')`,
  );
  const [a, b] = racingStores(sqliteCommandStore(db));
  const request = {
    scope: { source: "sony-bank", from: null, to: null },
    parserRelease: "fixture-release",
    idempotencyKey: "raced-replay",
  };
  const outcomes = await Promise.all(
    [a, b].map((store) =>
      requestReplay({ store, principal: OPERATOR, now: NOW, nowMs: 1, request }),
    ),
  );
  expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
  expect(db.query("SELECT count(*) AS n FROM observation_replay_plans").get()).toEqual({ n: 1 });
});

test("a second dispatch of one operation finds the first executor's run and cannot re-point it (G3-14)", async () => {
  const db = migratedDatabase();
  const store = sqliteCommandStore(db);
  const accepted = await requestCollection({
    store,
    principal: OPERATOR,
    now: NOW,
    request: COLLECTION,
  });
  if (!accepted.ok) throw new Error("fixture");
  const operationId = accepted.receipt.operationId;
  // Two executors that both believe they own the dispatch, in the order a
  // duplicated notification delivers them.
  const first = await recordDispatch({
    store,
    operationId,
    outcome: "dispatched",
    now: NOW,
    targetRef: "run:first",
  });
  const second = await recordDispatch({
    store,
    operationId,
    outcome: "dispatched",
    now: NOW,
    targetRef: "run:second",
  });
  expect(first).toEqual({ targetRef: "run:first", boundHere: true });
  // The second is told which run exists and that it is not its own: it must
  // continue that run, not open a second provider session.
  expect(second).toEqual({ targetRef: "run:first", boundHere: false });
  expect(db.query("SELECT target_ref,dispatch_attempts FROM ops_requests").get()).toEqual({
    target_ref: "run:first",
    dispatch_attempts: 2,
  });
  // Not even a direct write can move a bound target (0040 trigger).
  expect(() =>
    db.run("UPDATE ops_requests SET target_ref='run:other' WHERE operation_id=?", [operationId]),
  ).toThrow(/immutable except its progress/u);
  // A retry that names no target leaves the binding alone, and answers with it.
  expect(await recordDispatch({ store, operationId, outcome: "retry", now: NOW })).toEqual({
    targetRef: "run:first",
    boundHere: false,
  });
});

test("an accepted request cannot be deleted, replaced or reopened once terminal (0040)", async () => {
  const db = migratedDatabase();
  const store = sqliteCommandStore(db);
  const accepted = await requestCollection({
    store,
    principal: OPERATOR,
    now: NOW,
    request: COLLECTION,
  });
  if (!accepted.ok) throw new Error("fixture");
  const id = accepted.receipt.operationId;
  expect(() => db.run("DELETE FROM ops_requests WHERE operation_id=?", [id])).toThrow(
    /append-only/u,
  );
  expect(() =>
    db.run("UPDATE ops_requests SET request_json='{}' WHERE operation_id=?", [id]),
  ).toThrow(/immutable/u);
  expect(() =>
    db.run("UPDATE ops_requests SET principal='someone-else' WHERE operation_id=?", [id]),
  ).toThrow(/immutable/u);
  await recordDispatch({ store, operationId: id, outcome: "failed", now: NOW, failureCode: "x" });
  expect(db.query("SELECT status FROM ops_requests WHERE operation_id=?").get(id)).toEqual({
    status: "blocked",
  });
  expect(() =>
    db.run("UPDATE ops_requests SET status='accepted' WHERE operation_id=?", [id]),
  ).toThrow(/immutable/u);
});
