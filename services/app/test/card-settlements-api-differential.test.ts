// The page route `GET /api/v2/reconciliation/card-settlements` (and its
// `/ownership` and `/statements` reads) as an adapter over the shared service,
// against the handler it replaced (`card-settlements-api-frozen.ts`), on the
// same synthetic store and the same requests. They must answer byte for byte
// alike except for the two changes docs/card-settlements.md records (ADR 0081
// point 2): a malformed list, grouped list or ownership request is the
// service's `400 invalid_query` (`financial-error-v1`) where the route said
// `invalid_offset` or `invalid_query`, and a list or grouped list read deeper
// than the reader grant's `maxRows` is `413 budget_exceeded` where the route
// read on. Every grouped page is compared on a store of 1,002 statements in
// `card-settlement-statements-differential.test.ts`.
// Native Worker/D1 only; no production data.
import { beforeAll, describe, expect, it } from "vitest";
import { cardSettlementsApi } from "../src/card-settlements-api";
import { frozenCardSettlementsApi } from "./card-settlements-api-frozen";
import { answer, compare, PATH, seedCandidates } from "./card-settlements-differential-store";

/** Past one page at the reader grant's budget, so deep pages hold rows. */
const BULK = 1_100;

beforeAll(async () => {
  // One statement recaptured BULK times, each paired with its own debit key,
  // plus one candidate of another statement that shares nothing.
  await seedCandidates([
    ...Array.from({ length: BULK }, (_, n) => ({
      id: `cs-${String(n).padStart(4, "0")}`,
      statementKey: "statement-bulk",
      bankKey: `bank-${n}`,
      createdAt: new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString(),
    })),
    {
      id: "cs-alone",
      statementKey: "statement-alone",
      bankKey: "bank-alone",
      createdAt: "2025-01-01T00:00:00.000Z",
      period: "2025-01",
    },
  ]);
});

const OFFSETS = [
  null,
  "0",
  "1",
  "50",
  "900",
  "950",
  "990",
  "991",
  "951",
  "1000",
  "1050",
  "1000000",
  "1000001",
  "99999999999999999999",
  "-1",
  "01",
  "abc",
  "1.5",
  "1e3",
  "+1",
  "",
];
const PROPOSALS = [null, "cs-0000", "cs-alone", "missing", "%2Fetc", ""];
const STATEMENTS = [null, "statement-bulk", "statement-none", "k".repeat(1025), ""];
const RELATED = [null, "cs-0000", "cs-alone", "missing", "a".repeat(129)];
const EXTRA = [null, "source=myjcb", "offset=0", "proposalId=cs-0000"];

function query(path: string, parts: Record<string, string | null>, extra: string | null): string {
  const pairs = Object.entries(parts)
    .filter((entry): entry is [string, string] => entry[1] !== null)
    .map(([key, value]) => `${key}=${value}`);
  if (extra !== null) pairs.push(extra);
  return pairs.length === 0 ? path : `${path}?${pairs.join("&")}`;
}

/** A deterministic sample of the whole cross product, the same on every run. */
function sample<T>(all: readonly T[], size: number): T[] {
  let state = 0x2545f491;
  const picked: T[] = [];
  for (let n = 0; n < size; n++) {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    picked.push(all[state % all.length]!);
  }
  return picked;
}

function requests(): string[] {
  const paths = [PATH, `${PATH}/ownership`, `${PATH}/statements`];
  const structured: string[] = [];
  const product: string[] = [];
  for (const path of paths) {
    // Every offset alone and beside each one filter.
    for (const offset of OFFSETS)
      for (const filter of [
        {},
        { proposalId: "cs-0000" },
        { statementKey: "statement-bulk" },
        { relatedTo: "cs-0000" },
        { relatedTo: "missing" },
      ])
        structured.push(query(path, { offset, ...filter }, null));
    // Each key repeated, with equal and with different values: a list the
    // service refuses, never the first value served alone.
    for (const repeated of [
      "offset=0&offset=0",
      "proposalId=cs-0000&proposalId=cs-0000",
      "proposalId=cs-0000&proposalId=cs-alone",
      "statementKey=statement-bulk&statementKey=statement-bulk",
      "relatedTo=cs-0000&relatedTo=cs-0000",
    ])
      structured.push(`${path}?${repeated}`);
    for (const offset of OFFSETS)
      for (const proposalId of PROPOSALS)
        for (const statementKey of STATEMENTS)
          for (const relatedTo of RELATED)
            for (const extra of EXTRA)
              product.push(query(path, { offset, proposalId, statementKey, relatedTo }, extra));
  }
  return [...structured, ...sample(product, 600)];
}

describe("the card settlement page route as an adapter over the shared service", () => {
  it("answers as the frozen handler did, except the two recorded changes", async () => {
    const seen = await compare(requests());
    // Every class was reached, deep pages that held rows included. A
    // malformed grouped request was the frozen handler's own refusal, the same
    // on both, until the grouped list became an adapter too; it is `invalid`
    // now, so `same` counts the answered list, ownership and grouped reads.
    expect(seen.same).toBeGreaterThan(25);
    expect(seen.invalid).toBeGreaterThan(800);
    expect(seen.budget).toBeGreaterThan(10);
    expect(seen.groupedBudget).toBeGreaterThan(2);
    expect(seen.groupedPages).toBeGreaterThan(5);
    expect(seen.same - seen.groupedPages).toBeGreaterThan(20);
    const deep = (await answer(frozenCardSettlementsApi, `${PATH}?offset=951`))!;
    expect((JSON.parse(deep.body) as { items: unknown[] }).items).toHaveLength(50);
  });

  it("keeps the transport's own answers: methods, non-operators and other paths", async () => {
    for (const path of [
      PATH,
      `${PATH}?offset=950`,
      `${PATH}/ownership?proposalId=cs-0000`,
      `${PATH}/statements`,
    ]) {
      for (const method of ["HEAD", "POST", "PUT", "DELETE"])
        expect({ path, method, after: await answer(cardSettlementsApi, path, method) }).toEqual({
          path,
          method,
          after: await answer(frozenCardSettlementsApi, path, method),
        });
      for (const subject of ["ungranted", "synthetic-agent", "mcp-client:synthetic-operator"])
        expect({
          path,
          subject,
          after: await answer(cardSettlementsApi, path, "GET", subject),
        }).toEqual({
          path,
          subject,
          after: await answer(frozenCardSettlementsApi, path, "GET", subject),
        });
    }
    for (const path of ["/api/v2/other", `${PATH}/other`, `${PATH}s`])
      expect(await answer(cardSettlementsApi, path)).toBeNull();
  });
});
