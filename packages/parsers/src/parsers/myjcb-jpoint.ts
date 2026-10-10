import { readMyJcbJPointResponse } from "../../../domain/src/myjcb-jpoint-response.ts";
import type { RewardProviderExpiryDisplayMetadata } from "../../../domain/src/reward-expiry-observations.ts";
import { parseLocalDate, type TemporalValue } from "../../../domain/src/time.ts";
import type { Quantity } from "../../../domain/src/values.ts";
import type { ArtifactMeta, Parser } from "../types.ts";
import { decodeUtf8, unitScopeAdmitted } from "./util.ts";
const KEY = /^([a-z0-9][a-z0-9-]{0,63})\/jpoint-balance\.json$/u;
const LOCATOR = "json:$.result.pointJsonInfo.totalPointInfo";
function fail(code: string): never {
  throw new Error(code);
}
function integer(text: string): string | undefined {
  if (!/^(?:[0-9]+|[0-9]{1,3}(?:,[0-9]{3})+)$/u.test(text)) return undefined;
  return BigInt(text.replaceAll(",", "")).toString();
}
function expiryDate(text: string): TemporalValue {
  const m = /^(\d{4})年(\d{1,2})月(\d{1,2})日\(([日月火水木金土])\)$/u.exec(text);
  if (!m) return { kind: "unknown", reasonCode: "provider_expiry_date_unparsed" };
  const date = `${m[1]}-${m[2]!.padStart(2, "0")}-${m[3]!.padStart(2, "0")}`;
  if (
    !parseLocalDate(date) ||
    "日月火水木金土"[new Date(`${date}T00:00:00.000Z`).getUTCDay()] !== m[4]
  )
    return { kind: "unknown", reasonCode: "provider_expiry_date_unparsed" };
  return { kind: "local-date", value: date, zone: "Asia/Tokyo", basis: "provider" };
}
function requireMeta(a: ArtifactMeta): string {
  if (!myJcbJPointBalance.accepts(a)) return fail("myjcb_jpoint_metadata_unsupported");
  if ((a.runStatus !== "success" || a.runFailureCount !== 0) && !unitScopeAdmitted(a))
    return fail("myjcb_jpoint_run_ineligible");
  const connection = KEY.exec(a.artifactKey ?? "")?.[1];
  if (!connection || (a.fetchUnitKey != null && a.fetchUnitKey !== `${connection}:j-point`))
    return fail("myjcb_jpoint_connection_unsupported");
  return connection;
}
export const myJcbJPointBalance: Parser = {
  name: "myjcb-jpoint-balance",
  version: "1.0.0",
  accepts: (a) =>
    a.sourceId === "myjcb" && a.dataset === "jpoint-balance" && a.mime === "application/json",
  parse(bytes, artifact) {
    const connection = requireMeta(artifact);
    let value: unknown;
    try {
      value = JSON.parse(decodeUtf8(bytes));
    } catch {
      return fail("myjcb_jpoint_json_invalid");
    }
    const response = readMyJcbJPointResponse(value),
      total = response.result.pointJsonInfo.totalPointInfo;
    const point = total.pointDispFlag ? integer(total.point) : undefined;
    if (total.pointDispFlag && point === undefined) return fail("myjcb_jpoint_quantity_unparsed");
    let expiry: RewardProviderExpiryDisplayMetadata;
    if (!total.expirePointDispFlag)
      expiry = {
        coverage: "not-displayed",
        reasonCode: "provider_expiry_not_displayed",
        displays: [],
      };
    else {
      const expirePoint = integer(total.expirePoint);
      const quantity: Quantity = {
        unitRef: "points:j-point",
        value:
          expirePoint === undefined
            ? {
                status: total.expirePoint === "" ? "missing" : "unparsed",
                reasonCode: "provider_expiry_quantity_unavailable",
              }
            : {
                status: "exact",
                value: { coefficient: expirePoint, scale: 0 },
                normalizationVersion: "decimal-v1",
              },
      };
      if (expirePoint !== undefined && point !== undefined && BigInt(expirePoint) > BigInt(point))
        return fail("myjcb_jpoint_expiry_exceeds_total");
      expiry = {
        coverage: "observed",
        reasonCode: null,
        displays: [
          {
            displayRef: "total-expiring-subset",
            scope: "holding-subset",
            quantity,
            expires: expiryDate(total.expirePointDate),
            rawLocator: LOCATOR,
          },
        ],
      };
    }
    return {
      observations: [
        {
          kind: "balance",
          sourceAccount: `myjcb:${connection}:j-point:total`,
          metric: "displayed_jpoint_total",
          ...(point === undefined ? {} : { amountText: point, amountScale: 0 }),
          instrument: "J_POINT",
          observedAt: artifact.fetchedAt,
          rawLocator: `${LOCATOR}.point`,
          extra: { ...response, _kogane: { rewardExpiryDisplays: expiry } },
        },
      ],
      warnings: [],
    };
  },
};
