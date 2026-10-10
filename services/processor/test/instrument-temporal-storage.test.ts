import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import { startPipeline } from "./harness.ts";
import {
  d1CommandStore,
  type CommandStore,
} from "../../../packages/storage-d1/src/core/command-store.ts";
import { loadInstrumentTemporalSnapshot } from "../../../packages/storage-d1/src/core/instrument-temporal.ts";
import {
  seedPlan,
  prepare,
  draft,
  relation,
  commitWrites,
  state,
  TIME,
} from "../../../packages/storage-d1/test/instrument-temporal-fixture.ts";
let mf: Miniflare;
let store: CommandStore;
beforeAll(async () => {
  const started = await startPipeline();
  mf = started.mf;
  store = d1CommandStore(started.env.DB);
}, 60000);
afterAll(async () => {
  await mf?.dispose();
});

test("native D1 batch seals a joint bundle; a raced common reservation consumes no approval", async () => {
  await seedPlan(store, "a");
  await seedPlan(store, "b");
  const a = await prepare(store, "a", [draft("m1"), relation("r1")]);
  const b = await prepare(store, "b", [draft("loser")]);
  if (!a.ok || !b.ok) throw new Error("prepare refused");
  await store.batch(commitWrites("a", a));
  const before = await state(store);
  const lost = await store.batch(commitWrites("b", b));
  expect(lost.every((row) => row.changes === 0)).toBe(true);
  expect(await state(store)).toBe(before);
  const loaded = await loadInstrumentTemporalSnapshot(store, 15000);
  if (!loaded.ok) throw new Error(loaded.reason);
  expect(loaded.snapshot.acceptances).toHaveLength(1);
  expect(loaded.snapshot.acceptances[0]).toMatchObject({ sequence: 1, knownAt: TIME });
  expect(loaded.snapshot.acceptances[0]!.members).toHaveLength(2);
});
test("native D1 rolls the complete shared transaction back for missing membership and missing seal", async () => {
  for (const [key, missing] of [
    ["c", "member"],
    ["d", "seal"],
  ] as const) {
    await seedPlan(store, key);
    const prepared = await prepare(store, key, [
      draft(`m-${key}`, "m1"),
      relation(`r-${key}`, "r1"),
    ]);
    if (!prepared.ok) throw new Error(prepared.reason);
    const writes = commitWrites(key, prepared).filter((w) =>
      missing === "member"
        ? !(w.sql.includes("INSERT INTO instrument_temporal_versions") && w.binds[0] === `r-${key}`)
        : !w.sql.includes("INSERT INTO instrument_temporal_acceptances"),
    );
    const before = await state(store);
    await expect(store.batch(writes)).rejects.toThrow();
    expect(await state(store)).toBe(before);
  }
});
