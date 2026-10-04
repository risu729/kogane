import { expect, test } from "bun:test";
import { createSettlementBankReader } from "../src/card-settlement-bank-cache.ts";
import type { CoreRevisionRow } from "../../../packages/read-model/src/source-revision.ts";

const initial = (): CoreRevisionRow => ({
  source_revision: 1,
  visibility_revision: 1,
  core_epoch: "synthetic",
});

test("shares same-date reads only within one complete input revision, including empty results", async () => {
  let revision = initial();
  let reads = 0;
  const read = createSettlementBankReader(
    async () => revision,
    async () => {
      reads++;
      return [];
    },
  );
  await read("2099-01-10");
  await read("2099-01-10");
  expect(reads).toBe(1);
  await read("2099-02-10");
  expect(reads).toBe(2);
  for (const change of [
    { source_revision: 2 },
    { visibility_revision: 2 },
    { core_epoch: "restored" },
  ]) {
    revision = { ...revision, ...change };
    await read("2099-01-10");
  }
  expect(reads).toBe(5);
});

test("a mutation during a bank query cannot poison the next same-date read", async () => {
  let revision = initial();
  let reads = 0;
  const read = createSettlementBankReader(
    async () => revision,
    async () => {
      reads++;
      if (reads === 1) revision = { ...revision, source_revision: 2 };
      return [reads];
    },
  );
  expect(await read("2099-01-10")).toEqual([1]);
  expect(await read("2099-01-10")).toEqual([2]);
  expect(await read("2099-01-10")).toEqual([2]);
  expect(reads).toBe(2);
});

test("missing or malformed revisions never authorize reuse", async () => {
  for (const revision of [
    null,
    { ...initial(), source_revision: -1 },
    { ...initial(), core_epoch: "" },
  ]) {
    let reads = 0;
    const read = createSettlementBankReader(
      async () => revision,
      async () => [++reads],
    );
    expect(await read("2099-01-10")).toEqual([1]);
    expect(await read("2099-01-10")).toEqual([2]);
  }
});

test("failures are not cached, and every sweep owns a fresh reader", async () => {
  let reads = 0;
  const rows = async () => {
    if (++reads === 1) throw new Error("synthetic-query-failure");
    return [reads];
  };
  const read = createSettlementBankReader(async () => initial(), rows);
  await expect(read("2099-01-10")).rejects.toThrow("synthetic-query-failure");
  expect(await read("2099-01-10")).toEqual([2]);
  expect(await createSettlementBankReader(async () => initial(), rows)("2099-01-10")).toEqual([3]);
});

test("retention is bounded by dates and rows without truncating query results", async () => {
  let reads = 0;
  const empty = createSettlementBankReader(
    async () => initial(),
    async () => {
      reads++;
      return [];
    },
  );
  for (let i = 0; i < 33; i++) await empty(String(i));
  await empty("0");
  expect(reads).toBe(34);
  reads = 0;
  const large = createSettlementBankReader(
    async () => initial(),
    async () => {
      reads++;
      return Array(1000).fill(1);
    },
  );
  for (const date of ["a", "b", "a", "c", "a"]) expect(await large(date)).toHaveLength(1000);
  expect(reads).toBe(3);
  await large("b");
  expect(reads).toBe(4);
  const oversized = createSettlementBankReader(
    async () => initial(),
    async () => {
      reads++;
      return Array(2001).fill(1);
    },
  );
  expect(await oversized("a")).toHaveLength(2001);
  expect(await oversized("a")).toHaveLength(2001);
  expect(reads).toBe(6);
});
