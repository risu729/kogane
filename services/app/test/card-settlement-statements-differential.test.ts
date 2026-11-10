// The grouped list `GET /api/v2/reconciliation/card-settlements/statements` as
// an adapter over `readCardSettlementStatementsForGrant`, against the handler
// it replaced (`card-settlements-api-frozen.ts`), on a store of 1,002
// statements: every page the reader grant's budget reaches (offsets 0 to 990)
// is byte-identical but for the last pages, which withhold a next page past
// the budget (`nextOffset: null`, `nextPage: "budget_exceeded"`) where the
// frozen handler named it, and the pages past it, which the frozen handler
// served, are `413 budget_exceeded` (docs/card-settlements.md, Agent reads). The
// malformed requests are compared in `card-settlements-api-differential.test.ts`.
// Native Worker/D1 only; no production data.
import { beforeAll, describe, expect, it } from "vitest";
import { cardSettlementsApi } from "../src/card-settlements-api";
import { frozenCardSettlementsApi } from "./card-settlements-api-frozen";
import { answer, compare, PATH, seedCandidates } from "./card-settlements-differential-store";

/** Statements of one candidate each, beside one recaptured statement. */
const SINGLES = 1_001;
/** The recaptured statement's candidates: more than the five a group judges. */
const RECAPTURES = 8;

beforeAll(async () => {
  await seedCandidates([
    ...Array.from({ length: RECAPTURES }, (_, n) => ({
      id: `cs-recapture-${String(n)}`,
      statementKey: "statement-recaptured",
      bankKey: `bank-recapture-${String(n)}`,
      createdAt: new Date(Date.UTC(2026, 0, 1) + n * 60_000).toISOString(),
    })),
    ...Array.from({ length: SINGLES }, (_, n) => ({
      id: `cs-single-${String(n).padStart(4, "0")}`,
      statementKey: `statement-single-${String(n).padStart(4, "0")}`,
      bankKey: `bank-single-${String(n)}`,
      createdAt: new Date(Date.UTC(2024, 0, 1) + n * 60_000).toISOString(),
    })),
  ]);
});

const page = (offset: number) => `${PATH}/statements?offset=${String(offset)}`;

describe("the grouped card settlement list as an adapter over the shared service", () => {
  it("serves the first half of the pages as the frozen handler did", async () => {
    const first = (await answer(frozenCardSettlementsApi, `${PATH}/statements`))!;
    // The recaptured statement leads, with its five newest candidates of eight.
    expect(
      (
        JSON.parse(first.body) as {
          statements: { statementKey: string; candidateCount: number; candidates: unknown[] }[];
        }
      ).statements[0],
    ).toMatchObject({ statementKey: "statement-recaptured", candidateCount: RECAPTURES });
    expect(
      await compare([
        `${PATH}/statements`,
        ...Array.from({ length: 50 }, (_, n) => page(n * 10)),
        page(1),
        page(489),
      ]),
    ).toEqual({
      same: 53,
      invalid: 0,
      budget: 0,
      groupedBudget: 0,
      groupedPages: 53,
      withheld: 0,
    });
  });

  it("serves the rest up to offset 990 as the frozen handler did, and refuses past it", async () => {
    // Offsets 989 and 990 named a next page (999, 1000) the budget refuses;
    // they withhold it now. Offset 980 still offers 990, the last page read.
    expect(
      await compare([...Array.from({ length: 50 }, (_, n) => page(500 + n * 10)), page(989)]),
    ).toEqual({
      same: 51,
      invalid: 0,
      budget: 0,
      groupedBudget: 0,
      groupedPages: 51,
      withheld: 2,
    });
    const last = (await answer(cardSettlementsApi, page(990)))!;
    expect(JSON.parse(last.body)).toMatchObject({ nextOffset: null, nextPage: "budget_exceeded" });
    expect(JSON.parse((await answer(cardSettlementsApi, page(980)))!.body)).toMatchObject({
      nextOffset: 990,
      nextPage: "offered",
    });
    // Every page past the budget held statements before and is refused now.
    const deep = [991, 995, 1000];
    for (const offset of deep) {
      const before = (await answer(frozenCardSettlementsApi, page(offset)))!;
      expect((JSON.parse(before.body) as { statements: unknown[] }).statements).not.toHaveLength(0);
    }
    expect(await compare([...deep.map(page), page(1010), page(1_000_000)])).toEqual({
      same: 0,
      invalid: 0,
      budget: 5,
      groupedBudget: 5,
      groupedPages: 0,
      withheld: 0,
    });
  });
});
