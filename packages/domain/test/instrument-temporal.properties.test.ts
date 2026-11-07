// Seeded property tests of the temporal instrument selector (ADR 0055,
// amendment 2026-10-09). Random complete journals over two identifiers, two
// instruments and their directed relations, with legacy rows, unknown and
// open-ended validity; every id, date and instant is invented.
import { describe, expect, test } from "bun:test";
import {
  selectInstrumentTemporal,
  type InstrumentAcceptance,
  type InstrumentDecisionVersion,
  type InstrumentLegacyIdentity,
  type InstrumentPeriod,
  type InstrumentSeries,
  type InstrumentTemporalInput,
  type InstrumentTemporalRequest,
} from "../src/instrument-temporal.ts";
import { between, pad2, pick, seededRandom, seeds, shuffled, type Random } from "./property.ts";

const IDS = ["identifier:A", "identifier:B"];
const INSTRUMENTS = ["instrument:X", "instrument:Y"];
const SERIES: InstrumentSeries[] = [
  ...IDS.map((identifierId): InstrumentSeries => ({ kind: "mapping", identifierId })),
  ...INSTRUMENTS.flatMap((fromRef) =>
    IDS.map((toRef): InstrumentSeries => ({ kind: "listed_as", fromRef, toRef })),
  ),
];
const MONTHS = ["2099-01-01", "2099-02-01", "2099-03-01", "2099-04-01", "2099-05-01"];
const zone = "Asia/Tokyo";
const key = (series: InstrumentSeries) => JSON.stringify(series);
const covers = (period: InstrumentPeriod, date: string) =>
  period.from <= date && (period.end.kind === "open-ended" || date < period.end.to);

interface Journal {
  input: InstrumentTemporalInput;
  /** Legacy rows no version superseded. */
  open: Set<string>;
  hours: number;
  date: string;
}

function randomJournal(random: Random): Journal {
  const legacy: InstrumentLegacyIdentity[] = SERIES.filter(() => random() < 0.3).map(
    (series, index) => ({
      id: `legacy:${index}`,
      series,
      evidenceRefs: shuffled(random, ["evidence:legacy:1", "evidence:legacy:2"]),
    }),
  );
  const open = new Set(legacy.map((row) => row.id));
  const heads = new Map<string, string>();
  const versions: InstrumentDecisionVersion[] = [];
  const acceptances: InstrumentAcceptance[] = [];
  let hour = 0;
  for (let sequence = 1; sequence <= between(random, 1, 5); sequence += 1) {
    if (random() < 0.6) hour += 1;
    const members: InstrumentAcceptance["members"] = [];
    for (const series of shuffled(random, SERIES).slice(0, between(random, 1, 3))) {
      const versionId = `version:${sequence}:${versions.length}`;
      const supersedes = heads.get(key(series)) ?? null;
      const periods: InstrumentPeriod[] = [];
      let at = between(random, 0, 1);
      const count = between(random, 0, 2);
      for (let index = 0; index < count && at < MONTHS.length - 1; index += 1) {
        const toIndex = at + between(random, 1, 2);
        const openEnded = toIndex >= MONTHS.length || (index === count - 1 && random() < 0.3);
        periods.push({
          from: MONTHS[at]!,
          end: openEnded ? { kind: "open-ended" } : { kind: "bounded", to: MONTHS[toIndex]! },
          evidenceRefs: shuffled(random, ["evidence:period:1", "evidence:period:2"]).slice(
            0,
            between(random, 1, 2),
          ),
          reasonCode: "owner_stated",
          assertion:
            series.kind === "mapping"
              ? { targetRef: pick(random, INSTRUMENTS) }
              : { disposition: pick(random, ["accepted", "rejected"] as const) },
        });
        if (openEnded) break;
        at = toIndex + between(random, 0, 1);
      }
      const supersedesLegacy = legacy
        .filter((row) => open.has(row.id) && key(row.series) === key(series) && random() < 0.5)
        .map((row) => row.id);
      for (const id of supersedesLegacy) open.delete(id);
      versions.push({
        versionId,
        series,
        coreEpoch: "core-epoch",
        acceptanceSeq: sequence,
        supersedes,
        supersedesLegacy,
        contractVersion: "interval-v1",
        zone,
        validity:
          random() < 0.15
            ? { kind: "unknown" }
            : { kind: "periods", periods: shuffled(random, periods) },
        evidenceRefs: shuffled(random, ["evidence:v:1", "evidence:v:2", "evidence:v:3"]).slice(
          0,
          between(random, 1, 3),
        ),
        reasonCode: "owner_stated",
      });
      members.push({ versionId, series, supersedes });
      heads.set(key(series), versionId);
    }
    acceptances.push({
      coreEpoch: "core-epoch",
      sequence,
      knownAt: `2099-06-01T${pad2(hour)}:00:00.000Z`,
      members,
    });
  }
  return {
    input: { coreEpoch: "core-epoch", acceptances, versions, legacy },
    open,
    hours: hour,
    date: `2099-0${between(random, 1, 5)}-${pick(random, ["01", "15", "28"])}`,
  };
}

const request = (
  date: string,
  knowledge: InstrumentTemporalRequest["knowledge"],
  identifierIds = IDS,
): InstrumentTemporalRequest => ({
  identifierIds,
  knowledge,
  effective: {
    role: "trade",
    confirmed: true,
    time: { kind: "local-date", value: date, zone, basis: "provider" },
  },
  contract: {
    version: "interval-v1",
    endpoints: "half-open",
    basis: "business-date",
    zone,
    openEnded: "allowed",
    referenceRole: "trade",
  },
});

const SEEDS = seeds(1, 60);

describe("selectInstrumentTemporal over random journals", () => {
  test("the order of every array never changes the context id", async () => {
    const broken: number[] = [];
    for (const seed of SEEDS) {
      const random = seededRandom(seed);
      const { input, date } = randomJournal(random);
      const first = await selectInstrumentTemporal(input, request(date, { mode: "current" }));
      const permuted: InstrumentTemporalInput = {
        coreEpoch: input.coreEpoch,
        acceptances: shuffled(random, input.acceptances).map((row) => ({
          ...row,
          members: shuffled(random, row.members),
        })),
        versions: shuffled(random, input.versions).map((version) => ({
          ...version,
          evidenceRefs: shuffled(random, version.evidenceRefs),
          supersedesLegacy: shuffled(random, version.supersedesLegacy),
          validity:
            version.validity.kind === "unknown"
              ? version.validity
              : {
                  kind: "periods",
                  periods: shuffled(random, version.validity.periods).map((period) => ({
                    ...period,
                    evidenceRefs: shuffled(random, period.evidenceRefs),
                  })),
                },
        })),
        legacy: shuffled(random, input.legacy).map((row) => ({
          ...row,
          evidenceRefs: shuffled(random, row.evidenceRefs),
        })),
      };
      const again = await selectInstrumentTemporal(
        permuted,
        request(date, { mode: "current" }, shuffled(random, IDS)),
      );
      if (
        first.status !== "selected" ||
        again.status !== "selected" ||
        first.contextId !== again.contextId
      )
        broken.push(seed);
    }
    expect(broken).toEqual([]);
  });

  test("instant cuts are monotone and a sequence pin reproduces each instant's set", async () => {
    const broken: string[] = [];
    for (const seed of SEEDS) {
      const { input, hours, date } = randomJournal(seededRandom(seed));
      let previous = -1;
      for (let hour = -1; hour <= hours + 1; hour += 1) {
        const instant =
          hour < 0 ? "2099-05-31T23:00:00.000Z" : `2099-06-01T${pad2(hour)}:30:00.000Z`;
        const byInstant = await selectInstrumentTemporal(
          input,
          request(date, { mode: "known-at", cut: { coreEpoch: "core-epoch", instant } }),
        );
        if (byInstant.status !== "selected") {
          broken.push(`${seed}: refused at ${instant}`);
          break;
        }
        const commitSeq = byInstant.manifest.selection.resolvedCut.commitSeq;
        if (commitSeq < previous) broken.push(`${seed}: went back at ${instant}`);
        previous = commitSeq;
        const bySequence = await selectInstrumentTemporal(
          input,
          request(date, { mode: "known-at", cut: { coreEpoch: "core-epoch", commitSeq } }),
        );
        if (bySequence.status !== "selected" || bySequence.setVersion !== byInstant.setVersion)
          broken.push(`${seed}: sequence ${commitSeq} does not reproduce ${instant}`);
      }
    }
    expect(broken).toEqual([]);
  });

  test("a resolved identifier names the head mapping's target on the date and nothing blocks it", async () => {
    const broken: string[] = [];
    let resolved = 0;
    for (const seed of SEEDS) {
      const { input, open, date } = randomJournal(seededRandom(seed));
      const result = await selectInstrumentTemporal(input, request(date, { mode: "current" }));
      if (result.status !== "selected") continue;
      const heads = new Map(input.versions.map((version) => [key(version.series), version]));
      for (const outcome of result.manifest.selection.outcomes) {
        if (outcome.status !== "resolved") continue;
        resolved += 1;
        const mapping = heads.get(key({ kind: "mapping", identifierId: outcome.identifierId }));
        const period =
          mapping?.validity.kind === "periods"
            ? mapping.validity.periods.find((entry) => covers(entry, date))
            : undefined;
        if (
          period === undefined ||
          !("targetRef" in period.assertion) ||
          period.assertion.targetRef !== outcome.targetRef
        )
          broken.push(`${seed}: target`);
        const legacyOpen = input.legacy.some(
          (row) =>
            open.has(row.id) &&
            (row.series.kind === "mapping"
              ? row.series.identifierId === outcome.identifierId
              : row.series.toRef === outcome.identifierId),
        );
        if (legacyOpen) broken.push(`${seed}: resolved past an unlogged legacy row`);
        const rejected = [...heads.values()].some(
          (version) =>
            version.series.kind === "listed_as" &&
            version.series.toRef === outcome.identifierId &&
            version.series.fromRef === outcome.targetRef &&
            version.validity.kind === "periods" &&
            version.validity.periods.some(
              (entry) =>
                "disposition" in entry.assertion &&
                entry.assertion.disposition === "rejected" &&
                covers(entry, date),
            ),
        );
        if (rejected) broken.push(`${seed}: resolved past an applicable rejection`);
      }
    }
    expect(broken).toEqual([]);
    expect(resolved).toBeGreaterThan(5);
  });
});
