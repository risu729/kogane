import { describe, expect, test } from "bun:test";
import {
  ContractError,
  canonicalJsonV1,
  encodeCanonicalV1,
  parseAddInventoryItemsRequest,
  parseAddPageGroupRequest,
  parseAddRunRangeRequest,
  parseAddRunReportRequest,
  parseAddUnitReportRequest,
  parseAddUnitRequest,
  parseBeginInventoryRequest,
  parseCreateRunRequest,
  parseRecordAttemptRequest,
  parseSealRunRequest,
  parseSealStagedInventoryRequest,
} from "../src/index";

const SHA = "a".repeat(64);

describe("canonical encoding v1", () => {
  test("sorts keys at every depth, keeps array order, drops undefined, keeps null", () => {
    expect(
      canonicalJsonV1({
        z: [{ b: 1, a: null }, { a: 2 }],
        a: { y: "1", x: undefined as unknown as null },
      }),
    ).toBe('{"a":{"y":"1"},"z":[{"a":null,"b":1},{"a":2}]}');
  });
  test("rejects non-integers and unsafe integers with the historical TypeError", () => {
    for (const value of [1.5, 2 ** 53, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => encodeCanonicalV1({ value })).toThrow(
        new TypeError("canonical numbers must be safe integers"),
      );
    }
    expect(new TextDecoder().decode(encodeCanonicalV1({ value: Number.MAX_SAFE_INTEGER }))).toBe(
      '{"value":9007199254740991}',
    );
  });
});

describe("request parsers", () => {
  test("every parser rejects unknown keys", () => {
    const cases: Array<[string, (input: unknown) => unknown, Record<string, unknown>]> = [
      [
        "createRun",
        parseCreateRunRequest,
        { producerId: "p", sourceId: "s", externalIdNamespace: "n", externalSessionId: "x" },
      ],
      ["addUnit", parseAddUnitRequest, { unitKind: "k", unitKey: "u" }],
      [
        "addRunRange",
        parseAddRunRangeRequest,
        {
          rangeKey: "r",
          rangeKind: "requested",
          precision: "month",
          startValue: "2026-01",
          basis: "request",
        },
      ],
      ["addPageGroup", parseAddPageGroupRequest, { pageGroupKey: "g" }],
      ["addUnitReport", parseAddUnitReportRequest, { reportKey: "t", reportKind: "terminal" }],
      ["addRunReport", parseAddRunReportRequest, { reportKey: "t", reportKind: "terminal" }],
      [
        "beginInventory",
        parseBeginInventoryRequest,
        { inventorySha256: SHA, expectedArtifactCount: 1, declarationBasis: "operator" },
      ],
      [
        "addInventoryItems",
        parseAddInventoryItemsRequest,
        { items: [{ artifactKey: "a", sha256: SHA, descriptorSha256: SHA }] },
      ],
      ["sealStagedInventory", parseSealStagedInventoryRequest, { externalAttemptId: "a" }],
      [
        "sealRun",
        parseSealRunRequest,
        { artifacts: [], declarationBasis: "operator", externalAttemptId: "a" },
      ],
      [
        "recordAttempt",
        parseRecordAttemptRequest,
        {
          externalAttemptId: "a",
          outcome: "incomplete",
          completedAtMs: 1,
          observedArtifactCount: 0,
          acceptedArtifactCount: 0,
          reusedArtifactCount: 0,
          rejectedArtifactCount: 0,
        },
      ],
    ];
    for (const [name, parse, valid] of cases) {
      expect(() => parse(valid), name).not.toThrow();
      expect(() => parse({ ...valid, extra: 1 }), name).toThrow(new ContractError("unknown_field"));
      expect(() => parse([]), name).toThrow(new ContractError("invalid_json_shape"));
    }
  });

  test("applies the server defaults for omitted keys", () => {
    expect(
      parseCreateRunRequest({
        producerId: "p",
        sourceId: "s",
        externalIdNamespace: "n",
        externalSessionId: "x",
      }).sourceRunKey,
    ).toBe("default");
    expect(parseAddUnitRequest({ unitKind: "k", unitKey: "u" })).toEqual({
      parentUnitId: null,
      unitKind: "k",
      unitKey: "u",
      terminalReportRequired: 0,
    });
    expect(
      parseAddUnitRequest({ unitKind: "k", unitKey: "u", terminalReportRequired: true })
        .terminalReportRequired,
    ).toBe(1);
    expect(parseAddUnitReportRequest({ reportKey: "t", reportKind: "terminal" })).toEqual({
      reportKey: "t",
      reportKind: "terminal",
      producerStatus: null,
      normalizedOutcome: "unknown",
      startedAtMs: null,
      startedAtBasis: null,
      completedAtMs: null,
      completedAtBasis: null,
      declaredArtifactCount: null,
      artifactCountScope: null,
      safeFailureCode: null,
    });
    expect(
      parseAddRunRangeRequest({
        rangeKey: "r",
        rangeKind: "requested",
        precision: "date",
        startValue: "2026-01-01",
        endValue: "2026-01-31",
        basis: "request",
      }),
    ).toMatchObject({ startInclusive: 1, endInclusive: 1, endValue: "2026-01-31" });
  });

  test("keeps the cross-field rules", () => {
    expect(() =>
      parseAddRunReportRequest({ reportKey: "t", reportKind: "terminal", startedAtMs: 1 }),
    ).toThrow(new ContractError("report_field_pair_mismatch"));
    expect(() =>
      parseAddUnitReportRequest({ reportKey: "t", reportKind: "terminal", completedAtMs: 1 }),
    ).toThrow(new ContractError("unit_report_field_pair_mismatch"));
    expect(() =>
      parseAddRunRangeRequest({
        rangeKey: "r",
        rangeKind: "requested",
        precision: "date",
        startValue: "2026-02-01",
        endValue: "2026-01-01",
        basis: "request",
      }),
    ).toThrow(new ContractError("reversed_range"));
    expect(() =>
      parseBeginInventoryRequest({
        inventorySha256: SHA,
        expectedArtifactCount: 10_001,
        declarationBasis: "operator",
      }),
    ).toThrow(new ContractError("inventory_too_large"));
    expect(() => parseAddInventoryItemsRequest({ items: [] })).toThrow(
      new ContractError("empty_inventory_chunk"),
    );
    const attempt = {
      externalAttemptId: "a",
      outcome: "failed",
      startedAtMs: 5,
      completedAtMs: 4,
      observedArtifactCount: 0,
      acceptedArtifactCount: 0,
      reusedArtifactCount: 0,
      rejectedArtifactCount: 0,
    };
    expect(() => parseRecordAttemptRequest(attempt)).toThrow(
      new ContractError("attempt_time_order_invalid"),
    );
    expect(() => parseRecordAttemptRequest({ ...attempt, completedAtMs: 6 })).toThrow(
      new ContractError("failed_attempt_error_required"),
    );
    expect(() =>
      parseRecordAttemptRequest({ ...attempt, completedAtMs: 6, acceptedArtifactCount: 1 }),
    ).toThrow(new ContractError("attempt_count_invalid"));
  });

  test("an instant range value has a four-digit year, so text order is time order", () => {
    const range = (startValue: string | null, endValue: string | null) =>
      parseAddRunRangeRequest({
        rangeKey: "r",
        rangeKind: "requested",
        precision: "instant",
        startValue,
        endValue,
        basis: "request",
      });
    expect(range("0001-01-01T00:00:00.000Z", "9999-12-31T23:59:59.999Z")).toMatchObject({
      startValue: "0001-01-01T00:00:00.000Z",
      endValue: "9999-12-31T23:59:59.999Z",
    });
    // Year 10000 after year 2026: reversed in time, yet "+" sorts before "2",
    // so a text comparison let it through.
    expect(() => range("+010000-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z")).toThrow(
      new ContractError("invalid_start_value"),
    );
    expect(() => range("2026-01-01T00:00:00.000Z", "+010000-01-01T00:00:00.000Z")).toThrow(
      new ContractError("invalid_end_value"),
    );
    // Year -5 before year -1, which a text comparison read as reversed.
    expect(() => range("-000005-01-01T00:00:00.000Z", null)).toThrow(
      new ContractError("invalid_start_value"),
    );
    expect(() => range(null, "-000001-01-01T00:00:00.000Z")).toThrow(
      new ContractError("invalid_end_value"),
    );
  });

  test("inventory items are sorted by artifactKey in binary order and must be unique", () => {
    const items = [
      { artifactKey: "b", sha256: SHA, descriptorSha256: SHA },
      { artifactKey: "B", sha256: SHA, descriptorSha256: SHA },
      { artifactKey: "a", sha256: SHA, descriptorSha256: SHA },
    ];
    expect(
      parseSealRunRequest({
        artifacts: items,
        declarationBasis: "operator",
        externalAttemptId: "x",
      }).artifacts.map((item) => item.artifactKey),
    ).toEqual(["B", "a", "b"]);
    expect(() => parseAddInventoryItemsRequest({ items: [...items, items[0]] })).toThrow(
      new ContractError("duplicate_inventory_key"),
    );
  });
});
