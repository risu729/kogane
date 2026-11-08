import { expect, test } from "bun:test";
import { validApiResponse } from "../src/api-validation.ts";
import {
  INSTRUMENT_COVERAGE_PATH,
  validInstrumentCoverage,
} from "../src/instrument-coverage-contract.ts";

const states = {
  "unresolved-candidates": 1,
  "resolved-by-decision": 2,
  "resolved-by-rule": 0,
  "shared-without-decision": 0,
  "kept-separate": 0,
  "no-candidate": 3,
};
const row = { source: "synthetic-a", identifiers: 6, states };
const answer = {
  schemaVersion: "kogane-instrument-coverage-v1",
  policy: "instrument-candidates-v1",
  query: { source: null },
  rows: [row, { ...row, source: "synthetic-b" }],
};

test("accepts the service's shape, including no rows", () => {
  expect(INSTRUMENT_COVERAGE_PATH).toBe("/api/identity/instrument-coverage");
  expect(validInstrumentCoverage(answer)).toBe(true);
  expect(validApiResponse(INSTRUMENT_COVERAGE_PATH, answer)).toBe(true);
  expect(validInstrumentCoverage({ ...answer, rows: [] })).toBe(true);
  expect(
    validInstrumentCoverage({ ...answer, query: { source: "synthetic-a" }, rows: [row] }),
  ).toBe(true);
});

test("refuses a count that does not hold together or a state it does not know", () => {
  const bad: unknown[] = [
    { ...answer, schemaVersion: "kogane-instrument-coverage-v2" },
    { ...answer, policy: "instrument-candidates-v2" },
    { ...answer, query: {} },
    { ...answer, rows: [{ ...row, identifiers: 7 }] },
    { ...answer, rows: [{ ...row, identifiers: 0, states: { ...states, "no-candidate": -3 } }] },
    {
      ...answer,
      rows: [
        {
          ...row,
          identifiers: 0,
          states: Object.fromEntries(Object.keys(states).map((k) => [k, 0])),
        },
      ],
    },
    { ...answer, rows: [{ ...row, states: { ...states, matched: 0 } }] },
    { ...answer, rows: [{ ...row, states: { ...states, "no-candidate": undefined } }] },
    { ...answer, rows: [{ ...row, states: { ...states, "no-candidate": 2.5 } }] },
    { ...answer, rows: [{ ...row, source: "" }] },
    // Sorted and one row per source.
    { ...answer, rows: [row, row] },
    { ...answer, rows: [{ ...row, source: "synthetic-b" }, row] },
    // A filtered answer holds only the filtered source.
    { ...answer, query: { source: "synthetic-a" } },
    { ...answer, rows: Array(10_001).fill(row) },
    null,
    [],
  ];
  for (const value of bad) expect(validInstrumentCoverage(value)).toBe(false);
});
