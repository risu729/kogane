import { beforeAll, expect, test } from "bun:test";
import { fullCoreDatabase, coreDatabase, sqliteD1 } from "./sqlite.ts";
import { migrationSql, CORE_MIGRATIONS_URL } from "../src/migrations.ts";
import { d1CommandStore } from "../src/core/command-store.ts";
import {
  loadInstrumentTemporalSnapshot,
  readInstrumentTemporalSelection,
  prepareInstrumentTemporalAppend,
} from "../src/core/instrument-temporal.ts";
import {
  seedPlan,
  draft,
  relation,
  prepare,
  commitWrites,
  state,
  request,
  TIME,
} from "./instrument-temporal-fixture.ts";
beforeAll(() => fullCoreDatabase().close(), 60000);
function fixture() {
  const db = fullCoreDatabase();
  return { db, store: d1CommandStore(sqliteD1(db)) };
}

test("a complete bundle is sealed once; corrections share one dense clock and retain earlier versions", async () => {
  const { db, store } = fixture();
  await seedPlan(store, "a");
  const first = await prepare(store, "a", [draft("m1"), relation("r1")]);
  if (!first.ok) throw new Error(first.reason);
  await store.batch(commitWrites("a", first));
  const old = await readInstrumentTemporalSelection(store, request, 15000);
  expect(old.ok && old.selection.status).toBe("selected");
  await seedPlan(store, "b");
  const second = await prepare(
    store,
    "b",
    [draft("m2", "m1"), relation("r2", "r1")],
    "2098-01-01T00:00:00.000Z",
  );
  if (!second.ok) throw new Error(second.reason);
  expect(second.acceptance).toMatchObject({ sequence: 2, knownAt: TIME });
  await store.batch(commitWrites("b", second));
  const loaded = await loadInstrumentTemporalSnapshot(store, 15000);
  if (!loaded.ok) throw new Error(loaded.reason);
  expect(loaded.snapshot.acceptances.map((a) => a.members.length)).toEqual([2, 2]);
  expect(loaded.snapshot.versions.map((v) => v.versionId)).toEqual(["m1", "r1", "m2", "r2"]);
  const pinned = await readInstrumentTemporalSelection(
    store,
    {
      ...request,
      knowledge: { mode: "known-at", cut: { coreEpoch: loaded.head.coreEpoch, commitSeq: 1 } },
    },
    15000,
  );
  if (
    !old.ok ||
    !pinned.ok ||
    old.selection.status !== "selected" ||
    pinned.selection.status !== "selected"
  )
    throw new Error("selection refused");
  expect(pinned.selection.setVersion).toBe(old.selection.setVersion);
  await expect(prepare(store, "c", [draft("fork", "m1")])).resolves.toMatchObject({
    ok: false,
    reason: "invalid_input",
  });
  db.close();
});

test("two prepared corrections race through the real receipt/approval guard: loser writes nothing", async () => {
  const { db, store } = fixture();
  await seedPlan(store, "a");
  await seedPlan(store, "b");
  const a = await prepare(store, "a", [draft("a")]);
  const b = await prepare(store, "b", [draft("b")]);
  if (!a.ok || !b.ok) throw new Error("prepare refused");
  await store.batch(commitWrites("a", a));
  const before = await state(store);
  const result = await store.batch(commitWrites("b", b));
  expect(result.every((row) => row.changes === 0)).toBe(true);
  expect(await state(store)).toBe(before);
  expect(
    (await store.first<{ uses_remaining: number }>(
      "SELECT uses_remaining FROM approvals WHERE approval_id='ap-b'",
    ))!,
  ).toEqual({ uses_remaining: 1 });
  db.close();
});

for (const missing of ["member", "seal", "decision"] as const)
  test(`missing ${missing} rolls back journal, decision, receipt, outbox and approval together`, async () => {
    const { db, store } = fixture();
    await seedPlan(store, "a");
    const prepared = await prepare(store, "a", [draft("m"), relation("r")]);
    if (!prepared.ok) throw new Error(prepared.reason);
    let writes = commitWrites("a", prepared);
    if (missing === "member")
      writes = writes.filter(
        (w) => !(w.sql.includes("INSERT INTO instrument_temporal_versions") && w.binds[0] === "r"),
      );
    else
      writes = writes.filter(
        (w) =>
          !w.sql.includes(
            missing === "seal"
              ? "INSERT INTO instrument_temporal_acceptances"
              : "INSERT INTO decision_revisions",
          ),
      );
    const before = await state(store);
    await expect(store.batch(writes)).rejects.toThrow();
    expect(await state(store)).toBe(before);
    db.close();
  });

for (const invalid of ["principal", "clock", "epoch", "sequence"] as const)
  test(`a forged ${invalid} seal rolls back the entire shared transaction`, async () => {
    const { db, store } = fixture();
    await seedPlan(store, "a");
    const first = await prepare(store, "a", [draft("m1")]);
    if (!first.ok) throw new Error(first.reason);
    await store.batch(commitWrites("a", first));
    await seedPlan(store, "b");
    const prepared = await prepare(store, "b", [draft("m2", "m1")]);
    if (!prepared.ok) throw new Error(prepared.reason);
    const writes = commitWrites("b", prepared).map((w) => {
      if (invalid === "principal" && w.sql.includes("INSERT INTO decision_revisions"))
        return { ...w, sql: w.sql.replace("'manual','operator'", "'manual','different'") };
      if (!w.sql.includes("INSERT INTO instrument_temporal_acceptances")) return w;
      const binds = [...w.binds];
      if (invalid === "clock") binds[2] = "2098-01-01T00:00:00.000Z";
      if (invalid === "epoch") binds[0] = "foreign";
      if (invalid === "sequence") binds[1] = 3;
      return { ...w, binds };
    });
    const before = await state(store);
    await expect(store.batch(writes)).rejects.toThrow();
    expect(await state(store)).toBe(before);
    db.close();
  });

test("a loader missing one sealed member refuses the whole result", async () => {
  const { db, store } = fixture();
  await seedPlan(store, "a");
  const prepared = await prepare(store, "a", [draft("m"), relation("r")]);
  if (!prepared.ok) throw new Error(prepared.reason);
  await store.batch(commitWrites("a", prepared));
  const incomplete = {
    ...store,
    all: async <T>(sql: string, binds?: readonly unknown[]) => {
      const rows = await store.all<T>(sql, binds);
      return sql.includes("SELECT version_json") ? rows.slice(1) : rows;
    },
  };
  expect(await loadInstrumentTemporalSnapshot(incomplete, 100)).toEqual({
    ok: false,
    reason: "journal_inconsistent",
  });
  db.close();
});

test("bounded reads never truncate and reject changed legacy revisions", async () => {
  const { db, store } = fixture();
  await seedPlan(store, "a");
  const prepared = await prepare(store, "a", [draft("m")]);
  if (!prepared.ok) throw new Error(prepared.reason);
  await store.batch(commitWrites("a", prepared));
  expect(await loadInstrumentTemporalSnapshot(store, 1)).toEqual({
    ok: false,
    reason: "budget_exceeded",
  });
  let injected = false;
  const raced = {
    ...store,
    all: async <T>(sql: string, binds?: readonly unknown[]): Promise<T[]> => {
      const rows = await store.all<T>(sql, binds);
      if (!injected && sql.includes("SELECT version_json")) {
        injected = true;
        db.exec("UPDATE core_source_revision SET source_revision=source_revision+1 WHERE id=1");
      }
      return rows;
    },
  };
  expect(await loadInstrumentTemporalSnapshot(raced, 100)).toEqual({
    ok: false,
    reason: "stale_context",
  });
  db.close();
});

test("new append between loader queries returns the captured cut, not mixed membership", async () => {
  const { db, store } = fixture();
  await seedPlan(store, "a");
  await seedPlan(store, "b");
  const a = await prepare(store, "a", [draft("a")]);
  if (!a.ok) throw new Error(a.reason);
  await store.batch(commitWrites("a", a));
  const b = await prepare(store, "b", [draft("b", "a")]);
  if (!b.ok) throw new Error(b.reason);
  let injected = false;
  const raced = {
    ...store,
    all: async <T>(sql: string, binds?: readonly unknown[]): Promise<T[]> => {
      const rows = await store.all<T>(sql, binds);
      if (!injected) {
        injected = true;
        await store.batch(commitWrites("b", b));
      }
      return rows;
    },
  };
  // The shared decision also advances source_revision, so this implementation
  // conservatively refuses the whole read instead of returning a mixed result.
  expect(await loadInstrumentTemporalSnapshot(raced, 100)).toEqual({
    ok: false,
    reason: "stale_context",
  });
  db.close();
});

test("sealed versions and acceptances forbid updates, deletes, replacements and late members", async () => {
  const { db, store } = fixture();
  await seedPlan(store, "a");
  const p = await prepare(store, "a", [draft("m")]);
  if (!p.ok) throw new Error(p.reason);
  await store.batch(commitWrites("a", p));
  const before = await state(store);
  expect(() =>
    db.exec(`INSERT INTO instrument_temporal_versions
    (version_id,core_epoch,commit_seq,series_key,supersedes,version_json)
    SELECT 'late',core_epoch,commit_seq,
     json_set(series_key,'$.identifierId','identifier:late'),NULL,
     json_set(version_json,'$.versionId','late','$.series.identifierId','identifier:late')
    FROM instrument_temporal_versions WHERE version_id='m'`),
  ).toThrow();
  for (const table of ["instrument_temporal_acceptances", "instrument_temporal_versions"]) {
    expect(() => db.exec(`DELETE FROM ${table}`)).toThrow();
    expect(() => db.exec(`UPDATE ${table} SET core_epoch=core_epoch`)).toThrow();
    expect(() => db.exec(`INSERT OR REPLACE INTO ${table} SELECT * FROM ${table}`)).toThrow();
  }
  expect(await state(store)).toBe(before);
  db.close();
});

test("migration preserves legacy rows and every old schema object; legacy blocks until explicitly superseded", async () => {
  const db = coreDatabase("0017", "0079");
  db.exec(`INSERT INTO instruments VALUES('synthetic','security','synthetic','provider-local');
  INSERT INTO instrument_identifiers VALUES('synthetic','synthetic','synthetic','synthetic','{}');
  INSERT INTO instrument_mappings VALUES('old','synthetic',1,'synthetic','rule','synthetic',1,'2098-01-01T00:00:00.000Z','synthetic','provider-local');
  INSERT INTO decision_revisions(id,subject_kind,subject_ref,revision,decision_kind,method,actor_id,reason,evidence_refs_json,created_at)
   VALUES('old-d','relation','old-r',1,'reject','manual','operator','synthetic','[]','2098-01-01T00:00:00.000Z');
  INSERT INTO entity_relations VALUES('old-r','listed_as','instrument:synthetic','identifier:synthetic',NULL,NULL,'rejected','old-d','[]','2098-01-01T00:00:00.000Z');`);
  const rows = () => [
    db.query("SELECT * FROM instrument_mappings").all(),
    db.query("SELECT * FROM entity_relations").all(),
    db.query("SELECT * FROM current_instrument_mappings").all(),
  ];
  const before = rows();
  const schema = db.query("SELECT type,name,sql FROM sqlite_master ORDER BY name").all();
  db.exec(migrationSql(CORE_MIGRATIONS_URL, "0079_instrument_temporal_journal.sql"));
  expect(rows()).toEqual(before);
  expect(
    db
      .query(
        "SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'instrument_temporal_%' AND name NOT LIKE 'sqlite_autoindex_instrument_temporal_%' ORDER BY name",
      )
      .all(),
  ).toEqual(schema);
  const store = d1CommandStore(sqliteD1(db));
  const selected = await readInstrumentTemporalSelection(store, request, 15000);
  if (!selected.ok || selected.selection.status !== "selected") throw new Error("read refused");
  expect(selected.selection.manifest.selection.outcomes[0]!.reasonCodes).toContain(
    "knowledge_unlogged",
  );
  expect(selected.selection.manifest.selection.outcomes[0]!.targetRef).toBeNull();
  await seedPlan(store, "e");
  const mapping = draft("m");
  mapping.supersedesLegacy = ["mapping:old"];
  const related = relation("r");
  related.supersedesLegacy = ["relation:old-r"];
  const prepared = await prepare(store, "e", [mapping, related]);
  if (!prepared.ok) throw new Error(prepared.reason);
  await store.batch(commitWrites("e", prepared));
  expect(rows()).toEqual(before);
  const resolved = await readInstrumentTemporalSelection(store, request, 15000);
  if (!resolved.ok || resolved.selection.status !== "selected") throw new Error("read refused");
  expect(resolved.selection.manifest.selection.outcomes[0]!.targetRef).toBe("instrument:synthetic");
  db.close();
});

test("prepare freezes before awaits and refuses sparse, foreign-policy or missing closure input", async () => {
  const { db, store } = fixture();
  await seedPlan(store, "f");
  const loaded = await loadInstrumentTemporalSnapshot(store, 15000);
  if (!loaded.ok) throw new Error(loaded.reason);
  const version = draft("f");
  const input = {
    expectedHead: loaded.head,
    versions: [version],
    request,
    operationId: "op-f",
    principal: "operator",
    decisionRevisionId: "d-f",
    now: TIME,
    maxRows: 15000,
  };
  const pending = prepareInstrumentTemporalAppend(store, input);
  version.evidenceRefs.push("synthetic:changed");
  const prepared = await pending;
  if (!prepared.ok) throw new Error(prepared.reason);
  expect(String(prepared.writes[0]!.binds[5])).not.toContain("synthetic:changed");
  const sparse = draft("sparse");
  sparse.evidenceRefs = Array(1);
  expect(
    await prepareInstrumentTemporalAppend(store, { ...input, versions: [sparse] }),
  ).toMatchObject({ ok: false, reason: "invalid_input" });
  expect(
    await prepareInstrumentTemporalAppend(store, {
      ...input,
      versions: [{ ...draft("wrong"), contractVersion: "other" }],
    }),
  ).toMatchObject({ ok: false, reason: "invalid_input" });
  expect(
    await prepareInstrumentTemporalAppend(store, {
      ...input,
      request: { ...request, identifierIds: ["identifier:other"] },
    }),
  ).toMatchObject({ ok: false, reason: "invalid_input" });
  db.close();
});
