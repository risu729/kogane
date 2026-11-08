import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { openStore } from "../src/store.ts";
import { freshTestStore, openTestStore } from "./test-store.ts";

const EXPERIMENT_ROOT = dirname(import.meta.dir);

test("test stores skip fsync and are never the operator's store", () => {
  const store = freshTestStore("kogane-test-store-");
  try {
    expect(store.db.query("PRAGMA synchronous").get()).toEqual({ synchronous: 0 });
  } finally {
    store.db.close();
    rmSync(join(store.blobDir, ".."), { recursive: true, force: true });
  }
  const state = join(import.meta.dir, "..", "state");
  const existedBefore = existsSync(state);
  expect(() => openTestStore(state)).toThrow(/system temporary root/u);
  expect(() => openTestStore(tmpdir())).toThrow(/system temporary root/u);
  expect(existsSync(state)).toBe(existedBefore);
});

test("a store opened without the disposable option keeps SQLite's full durability", () => {
  // The regular store (`state/`) opens this way; only callers that delete the
  // store afterwards may turn the fsync off.
  const directory = mkdtempSync(join(tmpdir(), "kogane-test-store-durable-"));
  const store = openStore(directory);
  try {
    expect(store.db.query("PRAGMA synchronous").get()).toEqual({ synchronous: 2 });
  } finally {
    store.db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("the experiment folder is refused even when it is the temporary root", () => {
  // On CI the checkout never lies under the system temporary directory, so the
  // first refusal above already covers `state/`. Point TMPDIR at the
  // experiment to prove the second one holds on its own.
  const saved = process.env["TMPDIR"];
  process.env["TMPDIR"] = EXPERIMENT_ROOT;
  try {
    expect(tmpdir()).toBe(EXPERIMENT_ROOT);
    const state = join(EXPERIMENT_ROOT, "state");
    const existedBefore = existsSync(state);
    expect(() => openTestStore(state)).toThrow(/system temporary root/u);
    expect(() => openTestStore(join(EXPERIMENT_ROOT, "test", "kogane-x"))).toThrow(
      /system temporary root/u,
    );
    expect(existsSync(state)).toBe(existedBefore);
    expect(existsSync(join(EXPERIMENT_ROOT, "test", "kogane-x"))).toBe(false);
  } finally {
    if (saved === undefined) delete process.env["TMPDIR"];
    else process.env["TMPDIR"] = saved;
  }
});
