// `provider-data-types-v2` (src/collection/provider-data-types.ts, ADR 0087):
// the catalogue names only registered parsers, every collector's parser that
// publishes observations is in it, and every entry is the wire contract's.
import { describe, expect, test } from "bun:test";
import { PARSERS } from "../../parsers/src/parsers/registry.ts";
import {
  DATA_TYPE_STATUSES,
  PROVIDER_DATA_TYPES,
} from "../../observation-shared/src/collection-quality-contract.ts";
import { COLLECTOR_SOURCE_IDS } from "../src/collection/descriptors.ts";
import {
  PROVIDER_DATA_TYPE_CATALOGUE,
  providerDataTypes,
} from "../src/collection/provider-data-types.ts";

/**
 * Registered parsers no catalogue entry names, each with why: they publish no
 * observation of a provider data type, or no collector feeds them.
 */
const NOT_A_DATA_TYPE: Readonly<Record<string, string>> = {
  "moneyforward-canonical-evidence-boundary": "keeps the account pages as evidence, no observation",
  "myjcb-canonical-evidence-boundary":
    "keeps the menu and discovery pages as evidence, no observation",
  "paypay-csv": "a manual CSV import; PayPay has no collector (#455)",
};

const names = PARSERS.map((parser) => parser.name);
const catalogued = Object.entries(PROVIDER_DATA_TYPE_CATALOGUE);

describe("the provider data-type catalogue", () => {
  test("describes exactly the CORE sources that have a collector", () => {
    const withCollector = new Set(
      Object.values(COLLECTOR_SOURCE_IDS).filter((source) => source !== "kogane-synthetic"),
    );
    expect(Object.keys(PROVIDER_DATA_TYPE_CATALOGUE).sort()).toEqual([...withCollector].sort());
    expect(providerDataTypes("paypay")).toBeNull();
    expect(providerDataTypes("kogane-synthetic")).toBeNull();
  });

  test("names only registered parsers, and every other registered parser is named", () => {
    const named = new Set(catalogued.flatMap(([, entries]) => entries.flatMap((e) => e.parsers)));
    for (const parser of named) expect(names, parser).toContain(parser);
    for (const parser of names)
      expect(named.has(parser) !== Object.hasOwn(NOT_A_DATA_TYPE, parser), parser).toBe(true);
  });

  test("a parser belongs to one source", () => {
    const owner = new Map<string, string>();
    for (const [source, entries] of catalogued)
      for (const parser of entries.flatMap((entry) => entry.parsers)) {
        expect(owner.get(parser) ?? source, parser).toBe(source);
        owner.set(parser, source);
      }
  });

  test("each source lists a type once, in the contract's order, with a status its fields give", () => {
    for (const [source, entries] of catalogued) {
      const order = entries.map((entry) => PROVIDER_DATA_TYPES.indexOf(entry.type));
      expect(order, source).toEqual([...order].sort((a, b) => a - b));
      expect(new Set(order).size, source).toBe(order.length);
      for (const entry of entries) {
        expect(DATA_TYPE_STATUSES).toContain(entry.status);
        expect(entry.parsers.length > 0, `${source} ${entry.type}`).toBe(
          entry.status !== "not_collected",
        );
        expect(entry.issue === null, `${source} ${entry.type}`).toBe(entry.status === "collected");
      }
    }
  });

  test("a source's answer is a copy: a caller cannot change the catalogue", () => {
    const first = providerDataTypes("sbi-securities")!;
    first[0]!.parsers.push("synthetic");
    expect(providerDataTypes("sbi-securities")![0]!.parsers).not.toContain("synthetic");
  });
});
