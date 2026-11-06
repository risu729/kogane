import { expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { freshTestStore, openTestStore } from "./test-store.ts";

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
