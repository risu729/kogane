import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  readMyJcbJPointResponse,
  MYJCB_POINT_RPC_ID,
} from "../../domain/src/myjcb-jpoint-response.ts";
import { validRewardProviderExpiryDisplayMetadata } from "../../domain/src/reward-expiry-observations.ts";
import { myJcbJPointBalance } from "../src/parsers/myjcb-jpoint.ts";
import { PARSERS } from "../src/parsers/registry.ts";
import type { ArtifactMeta, BalanceObservation } from "../src/types.ts";
import { FIXTURES_ROOT } from "./fixture-root.ts";
const fixture = () =>
  JSON.parse(readFileSync(`${FIXTURES_ROOT}myjcb-jpoint/jpoint-balance.json`, "utf8"));
const meta = (overrides: Partial<ArtifactMeta> = {}): ArtifactMeta => ({
  id: 1,
  sourceId: "myjcb",
  dataset: "jpoint-balance",
  runStatus: "success",
  runFailureCount: 0,
  artifactKey: "synthetic-a/jpoint-balance.json",
  fetchUnitKey: "synthetic-a:j-point",
  url: null,
  mime: "application/json",
  fetchedAt: "2026-01-01T00:00:00.000Z",
  sha256: "0".repeat(64),
  ...overrides,
});
const parse = (value = fixture(), a = meta()) =>
  myJcbJPointBalance.parse(new TextEncoder().encode(JSON.stringify(value)), a);
const observation = (value = fixture(), a = meta()) =>
  parse(value, a).observations[0] as BalanceObservation;
const metadata = (value = fixture()) =>
  (observation(value).extra._kogane as { rewardExpiryDisplays: Record<string, unknown> })
    .rewardExpiryDisplays;
describe("observed MyJCB J-POINT total response", () => {
  test("one total holding retains provider response and only one expiry subset", () => {
    const result = parse();
    expect(result.observations).toHaveLength(1);
    const row = observation();
    expect(row).toMatchObject({
      sourceAccount: "myjcb:synthetic-a:j-point:total",
      metric: "displayed_jpoint_total",
      amountText: "1000",
      amountScale: 0,
      instrument: "J_POINT",
      observedAt: meta().fetchedAt,
      rawLocator: "json:$.result.pointJsonInfo.totalPointInfo.point",
    });
    expect(row.asOf).toBeUndefined();
    expect(row.extra.result).toEqual(fixture().result);
    expect(metadata()).toMatchObject({
      coverage: "observed",
      reasonCode: null,
      displays: [
        {
          displayRef: "total-expiring-subset",
          scope: "holding-subset",
          quantity: {
            unitRef: "points:j-point",
            value: {
              status: "exact",
              value: { coefficient: "200", scale: 0 },
              normalizationVersion: "decimal-v1",
            },
          },
          expires: {
            kind: "local-date",
            value: "2030-06-30",
            zone: "Asia/Tokyo",
            basis: "provider",
          },
          rawLocator: "json:$.result.pointJsonInfo.totalPointInfo",
        },
      ],
    });
    expect(validRewardProviderExpiryDisplayMetadata(metadata())).toBe(true);
  });
  test("registry and accepts route only the new dataset", () => {
    expect(PARSERS.filter((p) => p.accepts(meta())).map((p) => p.name)).toEqual([
      "myjcb-jpoint-balance",
    ]);
    for (const overrides of [
      { dataset: null },
      { dataset: "credit-detail" },
      { sourceId: "vpass" },
      { mime: "text/html" },
    ])
      expect(myJcbJPointBalance.accepts(meta(overrides))).toBe(false);
  });
  test("connection namespace and unit must agree", () => {
    expect(
      observation(
        fixture(),
        meta({
          artifactKey: "synthetic-b/jpoint-balance.json",
          fetchUnitKey: "synthetic-b:j-point",
        }),
      ).sourceAccount,
    ).toBe("myjcb:synthetic-b:j-point:total");
    for (const overrides of [
      { artifactKey: null },
      { artifactKey: "jpoint-balance.json" },
      { artifactKey: "synthetic-a/other.json" },
      { artifactKey: "../jpoint-balance.json" },
      { fetchUnitKey: "synthetic-b:j-point" },
    ])
      expect(() => parse(fixture(), meta(overrides))).toThrow(
        "myjcb_jpoint_connection_unsupported",
      );
  });
  test("run eligibility applies before response parsing", () => {
    for (const overrides of [
      { runStatus: "failed" as const },
      { runStatus: "partial" as const },
      { runFailureCount: 1 },
    ])
      expect(() => parse(fixture(), meta(overrides))).toThrow("myjcb_jpoint_run_ineligible");
    expect(
      parse(
        fixture(),
        meta({
          runStatus: "partial",
          runFailureCount: 1,
          unitScopeEligibility: "unit-independent-v1",
        }),
      ).observations,
    ).toHaveLength(1);
  });
  test("false flags preserve missing total and explicitly undisplayed expiry", () => {
    const v = fixture();
    v.result.pointJsonInfo.totalPointInfo.pointDispFlag = false;
    v.result.pointJsonInfo.totalPointInfo.point = "";
    expect(observation(v).amountText).toBeUndefined();
    expect(observation(v).amountMinor).toBeUndefined();
    v.result.pointJsonInfo.totalPointInfo.expirePointDispFlag = false;
    expect(metadata(v)).toEqual({
      coverage: "not-displayed",
      reasonCode: "provider_expiry_not_displayed",
      displays: [],
    });
  });
  test("an observed zero remains exact", () => {
    const v = fixture();
    Object.assign(v.result.pointJsonInfo.totalPointInfo, { point: "0", expirePoint: "0" });
    expect(observation(v).amountText).toBe("0");
    expect(metadata(v)).toMatchObject({
      displays: [
        { quantity: { value: { status: "exact", value: { coefficient: "0", scale: 0 } } } },
      ],
    });
  });
  test("malformed displayed amounts never become zero", () => {
    for (const point of ["", "-1", "1,00", "1.5", "1e3", " 1", "1,000,00"]) {
      const v = fixture();
      v.result.pointJsonInfo.totalPointInfo.point = point;
      expect(() => parse(v)).toThrow();
    }
    const v = fixture();
    v.result.pointJsonInfo.totalPointInfo.point = "00001000";
    expect(observation(v).amountText).toBe("1000");
  });
  test("unknown date precision/calendar/weekday never becomes month-end", () => {
    for (const expirePointDate of [
      "",
      "2030年6月",
      "2030年2月30日(土)",
      "2030年6月30日(月)",
      "2030年6月30日(日曜日)",
      "2030年6月30日（日）",
    ]) {
      const v = fixture();
      v.result.pointJsonInfo.totalPointInfo.expirePointDate = expirePointDate;
      expect(metadata(v)).toMatchObject({
        displays: [{ expires: { kind: "unknown", reasonCode: "provider_expiry_date_unparsed" } }],
      });
    }
  });
  test("missing/malformed shown expiry quantity stays absent", () => {
    for (const [expirePoint, status] of [
      ["", "missing"],
      ["1,00", "unparsed"],
    ]) {
      const v = fixture();
      v.result.pointJsonInfo.totalPointInfo.expirePoint = expirePoint;
      expect(metadata(v)).toMatchObject({
        displays: [
          { quantity: { value: { status, reasonCode: "provider_expiry_quantity_unavailable" } } },
        ],
      });
    }
    const v = fixture();
    v.result.pointJsonInfo.totalPointInfo.expirePoint = "1,001";
    expect(() => parse(v)).toThrow("myjcb_jpoint_expiry_exceeds_total");
  });
  test("decoder checks echo, schema, flags, unit, empty provider errors and bounds with closed codes", () => {
    expect(readMyJcbJPointResponse(fixture(), MYJCB_POINT_RPC_ID).id).toBe(MYJCB_POINT_RPC_ID);
    expect(() => readMyJcbJPointResponse(fixture(), "200100102")).toThrow(
      "myjcb_jpoint_response_unsupported",
    );
    const mutations = [
      (v: any) => (v.jsonrpc = "1.0"),
      (v: any) => (v.id = 200100101),
      (v: any) => (v.id = "999999999"),
      (v: any) => (v.secret = "opaque"),
      (v: any) => (v.result.errMessage = "sensitive provider text"),
      (v: any) => (v.result.errId = "unexpected"),
      (v: any) => delete v.result.pointJsonInfo.totalPointInfo,
      (v: any) => delete v.result.pointJsonInfo.totalPointInfo.point,
      (v: any) => (v.result.pointJsonInfo.totalPointInfo.pointDispFlag = 1),
      (v: any) => (v.result.pointJsonInfo.totalPointInfo.expirePointDispFlag = "true"),
      (v: any) => (v.result.pointJsonInfo.pointHyoujiTanniName = "円"),
      (v: any) => (v.result.pointJsonInfo.totalPointInfo.account = "opaque"),
      (v: any) => (v.result.pointJsonInfo.totalPointInfo.point = "1".repeat(65)),
    ];
    for (const mutate of mutations) {
      const v = fixture();
      mutate(v);
      expect(() => readMyJcbJPointResponse(v)).toThrow("myjcb_jpoint_response_unsupported");
    }
    expect(() =>
      myJcbJPointBalance.parse(new TextEncoder().encode("{sensitive invalid json"), meta()),
    ).toThrow("myjcb_jpoint_json_invalid");
  });
});
