// Synthetic load fixture (architecture addendum 12 section 7).
//
// The review's design load is a shape, not a capacity forecast:
//
//   40 fetch units x 200 observations/day x 365 days x 5 years = 14,600,000 rows
//
// This module produces that shape at any size from a seed, so a measurement
// can be repeated exactly. Nothing here reads real evidence: every account
// name, amount and locator is generated from the seed, and the amounts are
// small integers with no relation to anything observed. Do not point this at
// `data/`, and do not copy real values into it.
//
// It only generates Layer B observation rows. Layer A runs and artifacts are
// created by the caller through the normal ingest path, because their seals
// and inventories are exactly what a load measurement must not bypass.

export interface LoadShape {
  /** Fetch units per day; each one is one artifact with one published parse run. */
  units: number;
  observationsPerDay: number;
  days: number;
  seed: number;
  /** First civil day of the generated history, `YYYY-MM-DD`. */
  startDate: string;
}

export const DESIGN_LOAD: LoadShape = {
  units: 40,
  observationsPerDay: 200,
  days: 365 * 5,
  seed: 1,
  startDate: "2021-01-01",
};

/** Small enough to run in a normal test process; the load run overrides it. */
export const DEFAULT_SHAPE: LoadShape = {
  units: 4,
  observationsPerDay: 5,
  days: 8,
  seed: 1,
  startDate: "2026-01-01",
};

export interface LoadBalanceRow {
  unit: number;
  day: number;
  index: number;
  sourceAccount: string;
  metric: string;
  instrument: string;
  amountMinor: number;
  asOf: string;
  rawLocator: string;
}

/** mulberry32: a small, fully specified PRNG so a seed reproduces a fixture exactly. */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function addDays(startDate: string, days: number): string {
  const [year, month, day] = startDate.split("-").map(Number);
  const date = new Date(Date.UTC(year!, month! - 1, day! + days));
  return date.toISOString().slice(0, 10);
}

export function totalObservations(shape: LoadShape): number {
  return shape.units * shape.observationsPerDay * shape.days;
}

/** One artifact per (day, unit): the same partitioning the pipeline parses. */
export function totalArtifacts(shape: LoadShape): number {
  return shape.units * shape.days;
}

/**
 * Every generated balance row, in a fixed order. The metric and instrument
 * come from a small closed set so the rows exercise grouping and filtering
 * without inventing new provider semantics.
 */
export function* balanceRows(shape: LoadShape): Generator<LoadBalanceRow> {
  const random = seededRandom(shape.seed);
  const instruments = ["JPY", "USD", "AUD"];
  for (let day = 0; day < shape.days; day += 1) {
    const asOf = addDays(shape.startDate, day);
    for (let unit = 0; unit < shape.units; unit += 1) {
      for (let index = 0; index < shape.observationsPerDay; index += 1) {
        const instrument = instruments[Math.floor(random() * instruments.length)]!;
        yield {
          unit,
          day,
          index,
          sourceAccount: `load-unit-${String(unit).padStart(4, "0")}`,
          metric: index % 4 === 0 ? "account_balance" : "yen_deposit_account_balance",
          instrument,
          // Synthetic minor units: a bounded pseudo-random integer, never an
          // observed amount.
          amountMinor: 1000 + Math.floor(random() * 900_000),
          asOf,
          rawLocator: `$.load[${day}][${unit}][${index}]`,
        };
      }
    }
  }
}

/** Cheap order-sensitive checksum, so two runs of the same seed can be compared. */
export function fixtureChecksum(shape: LoadShape): number {
  let hash = 0;
  for (const row of balanceRows(shape))
    hash = (hash * 31 + row.amountMinor + row.instrument.charCodeAt(0)) % 2_147_483_647;
  return hash;
}

export function shapeFromEnv(source: Record<string, string | undefined>): LoadShape {
  const read = (name: string, fallback: number): number => {
    const value = source[name];
    if (value === undefined) return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 1)
      throw new RangeError(`${name} must be a positive integer`);
    return parsed;
  };
  return {
    units: read("KOGANE_LOAD_UNITS", DEFAULT_SHAPE.units),
    observationsPerDay: read("KOGANE_LOAD_OBSERVATIONS", DEFAULT_SHAPE.observationsPerDay),
    days: read("KOGANE_LOAD_DAYS", DEFAULT_SHAPE.days),
    seed: read("KOGANE_LOAD_SEED", DEFAULT_SHAPE.seed),
    startDate: source.KOGANE_LOAD_START ?? DEFAULT_SHAPE.startDate,
  };
}

export function describeShape(shape: LoadShape): string {
  return JSON.stringify({
    shape,
    observations: totalObservations(shape),
    artifacts: totalArtifacts(shape),
    checksum: fixtureChecksum(shape),
    designLoad: { ...DESIGN_LOAD, observations: totalObservations(DESIGN_LOAD) },
  });
}

if (import.meta.main) {
  // Printing the shape and its checksum is the whole CLI: generating rows into
  // a database is the caller's job, and this script never touches one.
  console.log(describeShape(shapeFromEnv(process.env)));
}
