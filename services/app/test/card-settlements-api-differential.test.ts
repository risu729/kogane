// The page route `GET /api/v2/reconciliation/card-settlements` (and its
// `/ownership` and `/statements` reads) as an adapter over the shared service,
// against the handler it replaced (`card-settlements-api-frozen.ts`), on the
// same synthetic store and the same requests. They must answer byte for byte
// alike except for the three changes docs/card-settlements.md records (ADR 0081
// point 2 and its 2026-11-08 amendment): a malformed list, grouped list or
// ownership request is the service's `400 invalid_query` (`financial-error-v1`)
// where the route said `invalid_offset` or `invalid_query`, a list or grouped
// list read deeper than the reader grant's `maxRows` is `413 budget_exceeded`
// where the route read on, and a page whose next page would be so refused
// withholds it (`nextOffset: null`, `nextPage: "budget_exceeded"`) where the
// route named it. Every grouped page is compared on a store of 1,002 statements in
// `card-settlement-statements-differential.test.ts`.
// Native Worker/D1 only; no production data.
import { beforeAll, describe, expect, it } from "vitest";
import { cardSettlementsApi } from "../src/card-settlements-api";
import { frozenCardSettlementsApi } from "./card-settlements-api-frozen";
import {
  answer,
  compare,
  PATH,
  seedCandidates,
  withinReaderBudget,
} from "./card-settlements-differential-store";

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
  it("answers as the frozen handler did, except the three recorded changes", async () => {
    // The request set is deterministic, so each class is pinned exactly: a
    // request that changes class fails here, not only one that changes body.
    // `same`: 25 list reads (19 pages, 6 not found), 1 ownership review and 8
    // grouped pages; `invalid`: 253 list, 326 ownership and 289 grouped
    // requests the frozen handler refused as `invalid_offset` or
    // `invalid_query`; `budget`: 24 list and 4 grouped reads past offset 950
    // and 990. The 289 grouped refusals and the 4 grouped deep pages were
    // `same` while the grouped list kept its own rules. `withheld`: of
    // `same`, the 3 pages at offset 950 (alone, of `statement-bulk` and the
    // competitors of `cs-0000`) that named offset 1000, which is refused.
    expect(await compare(requests())).toEqual({
      same: 34,
      invalid: 868,
      budget: 28,
      groupedBudget: 4,
      groupedPages: 8,
      withheld: 3,
    });
    const deep = (await answer(frozenCardSettlementsApi, `${PATH}?offset=951`))!;
    expect((JSON.parse(deep.body) as { items: unknown[] }).items).toHaveLength(50);
  });

  it("offers no next page the reader grant is refused, and says why", async () => {
    const page = async (handler: typeof cardSettlementsApi, query: string) =>
      JSON.parse((await answer(handler, query))!.body) as {
        items: unknown[];
        nextOffset: number | null;
        nextPage: string;
      };
    for (const filter of ["", "&statementKey=statement-bulk", "&relatedTo=cs-0000"]) {
      // The frozen handler named offset 1000, which the route refuses.
      expect((await page(frozenCardSettlementsApi, `${PATH}?offset=950${filter}`)).nextOffset).toBe(
        1000,
      );
      expect((await answer(cardSettlementsApi, `${PATH}?offset=1000${filter}`))!.status).toBe(413);
      // The route now serves the last page it reads and withholds the next.
      const last = await page(cardSettlementsApi, `${PATH}?offset=950${filter}`);
      expect([last.items.length, last.nextOffset, last.nextPage]).toEqual([
        50,
        null,
        "budget_exceeded",
      ]);
      const before = await page(cardSettlementsApi, `${PATH}?offset=900${filter}`);
      expect([before.nextOffset, before.nextPage]).toEqual([950, "offered"]);
    }
    // One candidate of a statement of its own: the last page, nothing withheld.
    expect(await page(cardSettlementsApi, `${PATH}?statementKey=statement-alone`)).toMatchObject({
      nextOffset: null,
      nextPage: "none",
    });
  });

  it("keeps the transport's own answers: methods, non-operators and other paths", async () => {
    const frozen = async (path: string, method: string, subject?: string) => {
      const before = await answer(frozenCardSettlementsApi, path, method, subject);
      return before === null ? null : withinReaderBudget(path, before);
    };
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
          after: await frozen(path, method),
        });
      for (const subject of ["ungranted", "synthetic-agent", "mcp-client:synthetic-operator"])
        expect({
          path,
          subject,
          after: await answer(cardSettlementsApi, path, "GET", subject),
        }).toEqual({
          path,
          subject,
          after: await frozen(path, "GET", subject),
        });
    }
    for (const path of ["/api/v2/other", `${PATH}/other`, `${PATH}s`])
      expect(await answer(cardSettlementsApi, path)).toBeNull();
  });
});
