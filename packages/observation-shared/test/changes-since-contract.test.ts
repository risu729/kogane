// The wire contract of the "changes since a time" digest (ADR 0127): closed
// codes, the domain's orders, bounds and handlers, and lines that agree with
// themselves, so a reader never sees a line the digest cannot produce. Every
// value is invented.
import { expect, test } from "bun:test";
import {
  CHANGES_SINCE_CAPTURE_BOUND,
  CHANGES_SINCE_EVENT_WALK,
  CHANGES_SINCE_HANDLERS,
  CHANGES_SINCE_MAX_BYTES,
  CHANGES_SINCE_MAX_DAYS,
  CHANGES_SINCE_NOT_COVERED,
  CHANGES_SINCE_OBSERVATION_BOUND,
  CHANGES_SINCE_OBSERVATION_KINDS,
  CHANGES_SINCE_PARSE_STATES,
  CHANGES_SINCE_PARSE_WALK,
  CHANGES_SINCE_RUN_STATUSES,
  CHANGES_SINCE_RUN_WALK,
  CHANGES_SINCE_SOURCE_BOUND,
  ECONOMIC_EVENT_KINDS,
} from "../../domain/src/changes-since.ts";
import { validApiResponse } from "../src/api-validation.ts";
import { CHANGES_SINCE_PATH, validChangesSince } from "../src/changes-since-contract.ts";

const line = (overrides: Record<string, unknown> = {}) => ({
  source: "vpass",
  cut: [],
  runs: [2, 0, 1, 0, 0, 0, 1],
  captures: 9,
  parses: [3, 0, 0, 1, 0],
  observations: [12, 2, 0, 0],
  newestRunAt: "2099-03-01T10:00:00.000Z",
  newestSealedRunId: "r_42",
  newestParsedAt: "2099-03-01T10:05:00.000Z",
  newestParsedArtifactId: 77,
  ...overrides,
});

function answer(overrides: Record<string, unknown> = {}) {
  return {
    apiVersion: 2,
    schemaVersion: "kogane-changes-since-v1",
    since: "2099-03-01T00:00:00.000Z",
    asOf: "2099-03-02T00:00:00.000Z",
    after: null,
    basis: "recorded",
    bounds: {
      maxDays: CHANGES_SINCE_MAX_DAYS,
      sources: CHANGES_SINCE_SOURCE_BOUND,
      runWalk: CHANGES_SINCE_RUN_WALK,
      captures: CHANGES_SINCE_CAPTURE_BOUND,
      parseWalk: CHANGES_SINCE_PARSE_WALK,
      observations: CHANGES_SINCE_OBSERVATION_BOUND,
      eventWalk: CHANGES_SINCE_EVENT_WALK,
      maxBytes: CHANGES_SINCE_MAX_BYTES,
    },
    order: {
      runs: CHANGES_SINCE_RUN_STATUSES,
      parses: CHANGES_SINCE_PARSE_STATES,
      observations: CHANGES_SINCE_OBSERVATION_KINDS,
      events: ECONOMIC_EVENT_KINDS,
    },
    sections: { runs: "counted", captures: "counted", parses: "counted", observations: "counted" },
    sources: [line()],
    unchanged: ["myjcb", "wise"],
    next: null,
    events: {
      state: "counted",
      reason: null,
      complete: true,
      new: [1, 0, 0, 0, 0, 0, 0, 0],
      revised: [0, 0, 0, 0, 0, 0, 0, 0],
      newestAt: "2099-03-01T11:00:00.000Z",
    },
    handlers: CHANGES_SINCE_HANDLERS,
    notCovered: CHANGES_SINCE_NOT_COVERED,
    ...overrides,
  };
}

test("a digest the service can produce is admitted, on its path", () => {
  expect(validChangesSince(answer())).toBe(true);
  expect(validApiResponse(CHANGES_SINCE_PATH, answer())).toBe(true);
  // A continuation names the last source listed.
  expect(validChangesSince(answer({ next: { after: "wise" } }))).toBe(true);
  expect(validChangesSince(answer({ after: "mizuho-bank", unchanged: ["myjcb", "wise"] }))).toBe(
    true,
  );
  // Without evidence.read the run sections are null on every line.
  expect(
    validChangesSince(
      answer({
        sections: {
          runs: "unauthorized",
          captures: "unauthorized",
          parses: "counted",
          observations: "counted",
        },
        sources: [line({ runs: null, captures: null, newestRunAt: null, newestSealedRunId: null })],
      }),
    ),
  ).toBe(true);
  expect(
    validChangesSince(
      answer({
        events: {
          state: "unavailable",
          reason: "not_served",
          complete: false,
          new: null,
          revised: null,
          newestAt: null,
        },
      }),
    ),
  ).toBe(true);
});

test("a line or an answer the service cannot produce is refused", () => {
  for (const bad of [
    answer({ schemaVersion: "kogane-changes-since-v2" }),
    answer({ since: "2099-03-01T00:00:00Z" }),
    answer({ since: "2099-03-03T00:00:00.000Z" }),
    answer({ basis: "observed" }),
    answer({ bounds: { maxDays: 365 } }),
    answer({ handlers: { ...CHANGES_SINCE_HANDLERS, runs: { tool: "kogane.store.read" } } }),
    answer({
      sections: {
        runs: "unauthorized",
        captures: "counted",
        parses: "counted",
        observations: "counted",
      },
    }),
    // A source twice, out of order, or not after `after`.
    answer({ unchanged: ["vpass"] }),
    answer({ unchanged: ["wise", "myjcb"] }),
    answer({ after: "zzz" }),
    // A continuation that is not the last source listed.
    answer({ next: { after: "myjcb" } }),
    answer({ sources: [line({ runs: [1, 0, 0] })] }),
    answer({ sources: [line({ runs: [-1, 0, 0, 0, 0, 0, 0] })] }),
    answer({ sources: [line({ cut: ["observations", "runs"] })] }),
    answer({ sources: [line({ cut: ["amounts"] })] }),
    // A newest time with no count, or a count with none.
    answer({ sources: [line({ newestRunAt: null })] }),
    answer({ sources: [line({ newestParsedAt: null })] }),
    // A sealed run id with only open runs.
    answer({ sources: [line({ runs: [0, 0, 0, 0, 0, 0, 2] })] }),
    // Rows of no recorded parse.
    answer({
      sources: [line({ parses: [0, 0, 1, 0, 0], newestParsedArtifactId: null })],
    }),
    // A line with nothing new and nothing cut belongs in `unchanged`.
    answer({
      sources: [
        line({
          runs: [0, 0, 0, 0, 0, 0, 0],
          captures: 0,
          parses: [0, 0, 0, 0, 0],
          observations: [0, 0, 0, 0],
          newestRunAt: null,
          newestSealedRunId: null,
          newestParsedAt: null,
          newestParsedArtifactId: null,
        }),
      ],
    }),
    // Run sections counted on a grant that cannot read them.
    answer({
      sections: {
        runs: "unauthorized",
        captures: "unauthorized",
        parses: "counted",
        observations: "counted",
      },
    }),
    answer({ events: { ...answer().events, newestAt: null } }),
    answer({ events: { ...answer().events, state: "unavailable", reason: "budget" } }),
  ])
    expect(validChangesSince(bad)).toBe(false);
});
