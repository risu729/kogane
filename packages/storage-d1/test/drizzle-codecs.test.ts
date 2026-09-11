// G4-11 and G4-12: a value read through the ORM means what the column means.
//
// The failure this guards against is not an exception. It is a query that
// works, returns numbers and dates, and is wrong: a coefficient of thirty
// digits arriving as 1.2345678901234568e+29, an `unparsed` amount arriving as
// 0, a statement date arriving as a `Date` at UTC midnight and displaying as
// the day before in Tokyo. Each of those is a plausible default for an ORM
// and none of them is the stored fact.
//
// So the columns are declared with the codec-backed types of
// `src/drizzle/columns.ts` and this test reads real rows through them:
// the coefficient stays text to the digit, a non-exact amount stays NULL and
// decodes as its status rather than as a number, a date-only column becomes a
// `CivilDate` and writes back the same bytes, and a value the column cannot
// hold raises instead of being rounded into one it can.
import type { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { decodeDecimal } from "../src/codecs/decimal.ts";
import { coreDrizzle } from "../src/drizzle/client.ts";
import { observationDecimalValues, observationReplayPlans } from "../src/drizzle/schema/core.ts";
import { BIG_COEFFICIENT, SOURCE, pilotDatabase } from "./core-fixture.ts";
import { sqliteD1 } from "./sqlite.ts";

let database: Database;
let db: ReturnType<typeof coreDrizzle>;

beforeEach(() => {
  database = pilotDatabase();
  db = coreDrizzle(sqliteD1(database));
});

/** The built columns of a table, so a mapper can be exercised on its own. */
function columnsOf(
  table: Parameters<typeof getTableConfig>[0],
): Map<string, ReturnType<typeof getTableConfig>["columns"][number]> {
  return new Map(getTableConfig(table).columns.map((column) => [column.name, column]));
}

describe("decimal columns keep their exact value through the ORM (G4-11)", () => {
  test("a coefficient beyond 2^53 comes back as text, digit for digit", async () => {
    const rows = await db
      .select()
      .from(observationDecimalValues)
      .where(eq(observationDecimalValues.observationId, 1));
    const row = rows[0];
    expect(row).toBeDefined();
    expect(typeof row?.coefficient).toBe("string");
    expect(row?.coefficient).toBe(BIG_COEFFICIENT);
    // The point of the assertion above, stated the other way round: a number
    // cannot carry these digits, so anything that becomes one has lost them.
    expect(String(Number(BIG_COEFFICIENT))).not.toBe(BIG_COEFFICIENT);
    expect(Number.isSafeInteger(Number(BIG_COEFFICIENT))).toBe(false);
    expect(row?.scale).toBe(4);
    expect(row?.status).toBe("exact");
    // The codec — the same one the native path uses — turns the triple into
    // the domain value, which is still text.
    expect(
      decodeDecimal({
        coefficient: row?.coefficient ?? null,
        scale: row?.scale ?? null,
        status: row?.status ?? "conflict",
      }),
    ).toEqual({
      status: "exact",
      value: { coefficient: BIG_COEFFICIENT, scale: 4 },
      normalizationVersion: "decimal-v1",
    });
  });

  test("an amount nobody could parse stays NULL and never becomes zero", async () => {
    const rows = await db
      .select()
      .from(observationDecimalValues)
      .where(eq(observationDecimalValues.observationId, 2));
    const row = rows[0];
    expect(row?.coefficient).toBeNull();
    expect(row?.scale).toBeNull();
    expect(row?.status).toBe("unparsed");
    expect(
      decodeDecimal({
        coefficient: row?.coefficient ?? null,
        scale: row?.scale ?? null,
        status: row?.status ?? "conflict",
      }),
    ).toEqual({ status: "unparsed", reasonCode: "value_not_exact" });
  });

  test("a coefficient column refuses a number and a scale refuses a fraction", () => {
    // These driver values cannot occur in a STRICT table, which is the point:
    // if one ever does — a view, a future column, a different driver — the
    // column says so instead of stringifying or rounding it.
    const columns = columnsOf(observationDecimalValues);
    expect(() => columns.get("coefficient")?.mapFromDriverValue(1.1)).toThrow(
      /decimal_coefficient_not_text/u,
    );
    expect(() => columns.get("scale")?.mapFromDriverValue(1.5)).toThrow(/decimal_scale_invalid/u);
    expect(() => columns.get("scale")?.mapFromDriverValue(-1)).toThrow(/decimal_scale_invalid/u);
    // An unreadable status is `conflict` — "cannot be read" — never `exact`.
    expect(columns.get("status")?.mapFromDriverValue("nonsense")).toBe("conflict");
  });
});

describe("date-only columns stay calendar days through the ORM (G4-12)", () => {
  test("a stored window comes back as a civil date, not a Date", async () => {
    const rows = await db
      .select()
      .from(observationReplayPlans)
      .where(eq(observationReplayPlans.id, 1));
    const row = rows[0];
    expect(row?.fetchedFrom).toEqual({ year: 2024, month: 2, day: 29 });
    expect(row?.fetchedTo).toEqual({ year: 2024, month: 3, day: 1 });
    expect(row?.fetchedFrom instanceof Date).toBe(false);
    // No hour, no offset, nothing that could shift the day for a reader in
    // another zone.
    expect(Object.keys(row?.fetchedFrom ?? {}).sort()).toEqual(["day", "month", "year"]);
    expect(row?.creationComplete).toBe(false);
  });

  test("an absent window is null, not an epoch", async () => {
    const rows = await db
      .select()
      .from(observationReplayPlans)
      .where(eq(observationReplayPlans.id, 2));
    expect(rows[0]?.fetchedFrom).toBeNull();
    expect(rows[0]?.fetchedTo).toBeNull();
    expect(rows[0]?.creationComplete).toBe(true);
  });

  test("writing a civil date stores the same text the native path stores", async () => {
    await db.insert(observationReplayPlans).values({
      id: 3,
      createdAtMs: 2_000,
      updatedAtMs: 2_000,
      sourceId: SOURCE,
      parserName: "pilot-parser",
      parserVersion: "1.0.0",
      artifactIdHighWater: 2,
      fetchedFrom: { year: 2026, month: 1, day: 5 },
      fetchedTo: { year: 2026, month: 12, day: 31 },
      status: "planned",
      reason: "pilot",
    });
    // Read with SQL, not with the ORM: what matters is the bytes in the column.
    expect(
      database
        .query("SELECT fetched_from,fetched_to FROM observation_replay_plans WHERE id=3")
        .get(),
    ).toEqual({ fetched_from: "2026-01-05", fetched_to: "2026-12-31" });
  });

  test("a date that does not exist raises instead of moving to a nearby day", () => {
    const columns = columnsOf(observationReplayPlans);
    // 2026 is not a leap year; a `Date`-based mapper would answer 1 March.
    expect(() => columns.get("fetched_from")?.mapFromDriverValue("2026-02-29")).toThrow(
      /date_only_invalid/u,
    );
    expect(() => columns.get("fetched_from")?.mapFromDriverValue("2026-09-07T00:00:00Z")).toThrow(
      /date_only_invalid/u,
    );
    expect(() => columns.get("fetched_from")?.mapFromDriverValue(20_260_907)).toThrow(
      /date_only_invalid/u,
    );
  });

  test("a flag column refuses anything that is not 0 or 1", () => {
    const columns = columnsOf(observationReplayPlans);
    expect(columns.get("creation_complete")?.mapFromDriverValue(1)).toBe(true);
    expect(columns.get("creation_complete")?.mapFromDriverValue(0)).toBe(false);
    // `Boolean("0")` is `true`; this is the mistake the codec exists to block.
    expect(() => columns.get("creation_complete")?.mapFromDriverValue("0")).toThrow(
      /boolean_column_invalid/u,
    );
  });
});
