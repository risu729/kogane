// Guard for a ranking limit of the statement reads (docs/card-settlements.md,
// "A statement's capture"). `card_statement_facts` (migration
// 0044), the dated state's statement facts and the settlement readiness
// check rank the captures of one statement by capture time, then a present
// `_kogane.paymentDate` first, then observation id. A present date that is
// not a calendar day would tie with a real one and could win on id, and the
// statement would read as having no readable due date. That cannot happen
// while every parser those rankings read refuses such a date, which this test
// pins for each registered release of them, on synthetic pages: the Vpass
// fixture is the parsers' synthetic `web.json` with the invented header of
// vpass-statement-total.test.ts, the MyJCB page is myjcb-statement.test.ts's.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { parseLocalDate } from "../../domain/src/time.ts";
import { PARSERS } from "../../parsers/src/parsers/registry.ts";
import type { ArtifactMeta, Observation, Parser } from "../../parsers/src/types.ts";
import { cardSettlementReadinessCtes } from "../src/card-settlement-readiness.ts";
import { DATED_STATEMENTS_BEFORE_WINDOW_SQL, DATED_STATEMENTS_SQL } from "../src/dated-state.ts";

const FIXTURES = join(import.meta.dir, "../../../tests/fixtures/observation-pipeline");
const MIGRATION_0044 = join(
  import.meta.dir,
  "../../storage-d1/migrations/core/0044_card_statement_settlements.sql",
);

/** A statement capture of one parser with the given payment date, synthetic. */
interface StatementFixture {
  sourceId: string;
  artifact: ArtifactMeta;
  bytes(year: number, month: number, day: number): Uint8Array;
}

const FIXTURES_BY_PARSER: Record<string, StatementFixture> = {
  "vpass-statement-page": {
    sourceId: "vpass",
    artifact: {
      id: 1,
      sourceId: "vpass",
      runStatus: "success",
      runFailureCount: 0,
      dataset: "statement-page",
      url: null,
      mime: "application/json",
      artifactKey: "months/202608/top-000.json",
      fetchUnitKey: "card-001",
      fetchedAt: "2026-08-30T00:00:00.000Z",
      sha256: "0".repeat(64),
    },
    bytes(year, month, day) {
      const root = JSON.parse(
        readFileSync(join(FIXTURES, "vpass-parser-boundaries/web.json"), "utf8"),
      );
      root.body.content.WebMeisaiTopDisplayServiceBean.saiseiStatus = "0";
      root.body.content.WebMeisaiTopDisplayServiceBean.webMeisaiTopK3Vo = {
        payTotal: "8,765",
        seikyuYm: "202608",
        shiharaiDate: `${year}年${month}月${day}日`,
      };
      return new TextEncoder().encode(JSON.stringify(root));
    },
  },
  "myjcb-credit-statement-total": {
    sourceId: "myjcb",
    artifact: {
      id: 1,
      sourceId: "myjcb",
      dataset: "credit-detail",
      artifactKey: "connection-a/credit-detail-03.html",
      runStatus: "success",
      runFailureCount: 0,
      statementState: "confirmed",
      period: null,
      url: null,
      mime: "text/html; charset=utf-8",
      fetchedAt: "2026-09-13T00:00:00.000Z",
      sha256: "a".repeat(64),
    },
    bytes(year, month, day) {
      // The heading keeps a real month, so only the total's date is impossible.
      const headingMonth = month >= 1 && month <= 12 ? month : 12;
      return new TextEncoder().encode(
        `<!doctype html><html><body><h1>MyJCB</h1><h1>カードご利用代金明細(確定分)</h1><h2>${year}年${headingMonth}月お支払い分のカードご利用明細</h2><div class="detail-list-01"></div><dl class="list"><dt>${year}年${month}月${day}日(月)お支払い金額合計</dt><dd><span>1,234</span>円</dd></dl></body></html>`,
      );
    },
  },
};

/** The `(source, parser)` pairs each shipped statement ranking reads. */
function rankedStatementParsers(sql: string): string[][] {
  const rankings = [
    ...sql.matchAll(
      /ORDER BY a\.fetched_at DESC,json_extract\(b\.extra_json,'\$\._kogane\.paymentDate'\) IS NOT NULL DESC,b\.id DESC\)[\s\S]*?\n WHERE \(\((.*)\)\)\n AND b\.metric='credit_statement_payment_amount'/gu,
    ),
  ];
  expect(rankings.length).toBeGreaterThan(0);
  return rankings.flatMap((ranking) =>
    [...ranking[1]!.matchAll(/a\.source_id='([^']+)' AND p\.parser_name='([^']+)'/gu)].map(
      (pair) => [pair[1]!, pair[2]!],
    ),
  );
}

const statementTotals = (observations: readonly Observation[]) =>
  observations.filter(
    (observation) =>
      observation.kind === "balance" && observation.metric === "credit_statement_payment_amount",
  );

const paymentDateOf = (observation: Observation): unknown =>
  (observation.extra?.["_kogane"] as Record<string, unknown> | undefined)?.["paymentDate"];

function registeredReleases(name: string): Parser[] {
  return PARSERS.filter((parser) => parser.name === name);
}

const IMPOSSIBLE: readonly (readonly [number, number, number])[] = [
  [2026, 2, 30],
  [2026, 9, 31],
  [2026, 13, 1],
];

describe("statement parsers never publish an impossible payment date", () => {
  test("every shipped statement ranking reads only the parsers guarded here", () => {
    const texts = {
      card_statement_facts: readFileSync(MIGRATION_0044, "utf8"),
      DATED_STATEMENTS_SQL,
      DATED_STATEMENTS_BEFORE_WINDOW_SQL,
      cardSettlementReadinessCtes: cardSettlementReadinessCtes(),
    };
    for (const [name, sql] of Object.entries(texts)) {
      const pairs = rankedStatementParsers(sql).map(([source, parser]) => `${source}/${parser}`);
      expect({ name, pairs: [...pairs].sort() }).toEqual({
        name,
        pairs: Object.entries(FIXTURES_BY_PARSER)
          .map(([parser, fixture]) => `${fixture.sourceId}/${parser}`)
          .sort(),
      });
    }
  });

  for (const [name, fixture] of Object.entries(FIXTURES_BY_PARSER)) {
    test(`${name}: the registry holds a release that accepts the fixture`, () => {
      const releases = registeredReleases(name);
      expect(releases.length).toBeGreaterThan(0);
      for (const parser of releases) expect(parser.accepts(fixture.artifact)).toBe(true);
    });

    test(`${name}: a real calendar day is published as the payment date`, () => {
      // The control: the fixture reaches the statement total, so a refusal
      // below is the date's and not the fixture's.
      for (const parser of registeredReleases(name)) {
        const totals = statementTotals(
          parser.parse(fixture.bytes(2026, 9, 30), fixture.artifact).observations,
        );
        expect(totals).toHaveLength(1);
        expect(totals[0]!.extra?.["_kogane"]).toMatchObject({
          paymentDate: "2026-09-30",
          snapshotSemantics: "provider-reported-monthly-payment-amount",
        });
      }
    });

    for (const [year, month, day] of IMPOSSIBLE) {
      const text = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
      test(`${name}: ${text} is refused or unknown, never published`, () => {
        for (const parser of registeredReleases(name)) {
          let observations: readonly Observation[];
          try {
            observations = parser.parse(
              fixture.bytes(year, month, day),
              fixture.artifact,
            ).observations;
          } catch {
            continue; // Refused: the artifact publishes nothing.
          }
          // Unknown (no date) is allowed; a date that is present is a
          // calendar day, and the impossible one appears nowhere.
          const published = statementTotals(observations).map((total) => ({
            asOf: total.asOf,
            paymentDate: paymentDateOf(total) ?? null,
          }));
          expect({ release: parser.version, published }).toEqual({
            release: parser.version,
            published: published.map(({ asOf, paymentDate }) => ({
              asOf,
              paymentDate:
                typeof paymentDate === "string" && parseLocalDate(paymentDate) !== null
                  ? paymentDate
                  : null,
            })),
          });
          expect(JSON.stringify(observations)).not.toContain(text);
        }
      });
    }
  }
});
