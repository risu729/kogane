import type { ArtifactMeta, BalanceObservation, Parser, ParseResult } from "../types.ts";
import { containerClaim } from "./coverage.ts";
import { decodeUtf8, unitScopeAdmitted } from "./util.ts";
import { exactKeys, strictObject } from "./sbi-strict.ts";

const AUTHORI_KEYS =
  "dataNotFindFlag,shokaiDate,allBalance,allLimit,allLimitInExpansion,allPossible,allReply,allReservation,authoriEntryFlg,authoriReservationFlg,balanceCodeCs,balanceCodeShopping,cardBalance,cardLimit,cardLimitInExpansion,cardName,cardPossible,cardReply,cardReservation,cashingBalance,cashingLimit,cashingOnceBalance,cashingOnceLimit,cashingOncePossible,cashingOnceReply,cashingPossible,cashingReply,cashingRevoBalance,cashingRevoBalanceFlg,cashingRevoLimit,cashingRevoPossible,cashingRevoReply,crevoLimitCode,csLimitCode,customerCsCode,divisionBalance,divisionLimit,divisionPossible,divisionReply,edificeCode,overseasCashingBalance,overseasCashingLimit,overseasCashingPossible,overseasCashingReply,overseasCashingLimitCode,divisionLimitCode,revoBalance,revoLimit,revoPossible,revoReply,revoLimitCode".split(
    ",",
  );
const REVO_KEYS =
  "chengeCourseExplanation,revoLimit,revoZan,revoFeeRate,courseName,revoMonthlyKingaku,revoBonusMonth1,revoBonusKingaku1,revoBonusMonth2,revoBonusKingaku2,userName,cardName,revoMonthlyKinFlag,revoAnnaiCode,totalLimit,hensaiAmount,courseExplanation,revoPayCoursePtn,revoPaymentCode".split(
    ",",
  );
const GROUPS = [
  ["00.authori.I0010023", "all", "overall"],
  ["00.authori.I0010024", "card", "card"],
  ["00.authori.I0010025", "revo", "revolving"],
  ["00.authori.I0010027", "division", "installment_twice_bonus"],
] as const;
const ALL_TITLES = [
  ...GROUPS.map(([title]) => title),
  "00.authori.I0010030",
  "00.authori.I0010031",
  "00.authori.I0010028",
] as readonly string[];
const INTEGER = /^[+-]?\d{1,16}$/u;

function integer(value: unknown): bigint {
  if (typeof value !== "string" || !INTEGER.test(value))
    throw new Error("vpass_credit_amount_invalid");
  return BigInt(value);
}
function displayRaw(value: unknown): bigint {
  if (typeof value !== "string") throw new Error("vpass_credit_display_invalid");
  const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(value);
  if (match === null || !/^0*$/u.test((match[3] ?? "").slice(1)))
    throw new Error("vpass_credit_display_precision");
  const magnitude = BigInt(match[2]!) * 10n + BigInt((match[3] ?? "0")[0] ?? "0");
  return match[1] === "-" ? -magnitude : magnitude;
}
function response(bytes: Uint8Array): Record<string, unknown> {
  const root = strictObject(JSON.parse(decodeUtf8(bytes)), "vpass_credit_envelope_invalid");
  exactKeys(root, ["header", "body"], "vpass_credit_envelope_invalid");
  const header = strictObject(root["header"], "vpass_credit_header_invalid");
  exactKeys(
    header,
    [
      "resultCode",
      "resultMessage",
      "transitTo",
      "loginFlg",
      "vpSessionBean",
      "siteCatalystSessionBean",
    ],
    "vpass_credit_header_shape",
  );
  if (typeof header["resultMessage"] !== "string") throw new Error("vpass_credit_header_invalid");
  if (
    ![0, "0", "0000"].includes(header["resultCode"] as never) ||
    header["loginFlg"] !== true ||
    header["transitTo"] !== ""
  )
    throw new Error("vpass_credit_session_invalid");
  return strictObject(
    strictObject(root["body"], "vpass_credit_body_invalid")["content"],
    "vpass_credit_content_invalid",
  );
}
function rows(
  value: unknown,
  found = new Map<string, Record<string, unknown>>(),
  depth = 0,
): Map<string, Record<string, unknown>> {
  if (depth > 8) throw new Error("vpass_credit_tree_bound");
  const row = strictObject(value, "vpass_credit_display_invalid");
  const allowed = [
    "autoriShokaiDisplayList",
    "mobileTitle",
    "title",
    "balance",
    "limit",
    "possible",
    "hyoujiFlg",
    "rowControlCnt",
    "colControlCnt",
  ];
  if (Object.keys(row).some((key) => !allowed.includes(key)))
    throw new Error("vpass_credit_display_shape");
  const title = row["title"];
  if (typeof title === "string" && title !== "") {
    if (
      row["mobileTitle"] !== title ||
      !ALL_TITLES.includes(title) ||
      found.has(title) ||
      !["0", "1"].includes(row["hyoujiFlg"] as string)
    )
      throw new Error("vpass_credit_display_code");
    found.set(title, row);
  }
  const children = row["autoriShokaiDisplayList"];
  if (children !== undefined) {
    if (!Array.isArray(children) || children.length > 16)
      throw new Error("vpass_credit_display_shape");
    for (const child of children) rows(child, found, depth + 1);
  }
  return found;
}
function reported(
  value: bigint,
  artifact: ArtifactMeta,
  metric: string,
  locator: string,
  precision: number,
  extra: Record<string, unknown>,
  asOf?: string,
): BalanceObservation {
  const card = artifact.fetchUnitKey;
  if (typeof card !== "string" || !/^card-\d{3}$/u.test(card))
    throw new Error("vpass_credit_card_invalid");
  return {
    kind: "balance",
    sourceAccount: `vpass:${card}`,
    metric,
    amountText: value.toString(),
    amountScale: 0,
    instrument: "JPY",
    ...(asOf === undefined ? {} : { asOf }),
    rawLocator: locator,
    extra: {
      ...extra,
      _kogane: { reportedPrecisionJPY: precision, nonAdditive: true, sharedCredit: true },
    },
  };
}
export const vpassCreditSnapshot: Parser = {
  name: "vpass-credit-snapshot",
  version: "1.0.0",
  accepts: (artifact) =>
    artifact.sourceId === "vpass" &&
    artifact.dataset === "credit-snapshot" &&
    artifact.mime === "application/json",
  parse(bytes: Uint8Array, artifact: ArtifactMeta): ParseResult {
    if (
      (artifact.runStatus !== "success" || artifact.runFailureCount !== 0) &&
      !unitScopeAdmitted(artifact)
    )
      throw new Error("vpass_credit_capture_incomplete");
    const content = response(bytes);
    const observations: BalanceObservation[] = [];
    if (artifact.artifactKey === "credit/authori.json") {
      exactKeys(content, ["AuthoriShokaiDisplayServiceBean"], "vpass_credit_content_shape");
      const bean = strictObject(
        content["AuthoriShokaiDisplayServiceBean"],
        "vpass_credit_bean_invalid",
      );
      exactKeys(bean, ["authoriShokaiVo", "authoriShokaiDisplayVo"], "vpass_credit_bean_invalid");
      const vo = strictObject(bean["authoriShokaiVo"], "vpass_credit_vo_invalid");
      exactKeys(vo, AUTHORI_KEYS, "vpass_credit_vo_shape");
      if (
        vo["dataNotFindFlag"] !== false ||
        typeof vo["shokaiDate"] !== "number" ||
        !Number.isSafeInteger(vo["shokaiDate"]) ||
        vo["shokaiDate"] < 1_000_000_000_000 ||
        vo["shokaiDate"] > 9_999_999_999_999
      )
        throw new Error("vpass_credit_date_invalid");
      for (const key of AUTHORI_KEYS)
        if (!["dataNotFindFlag", "shokaiDate"].includes(key) && typeof vo[key] !== "string")
          throw new Error("vpass_credit_vo_type");
      const asOf = new Date(vo["shokaiDate"]).toISOString();
      const display = rows(bean["authoriShokaiDisplayVo"]);
      for (const [title, prefix, scope] of GROUPS) {
        const row = display.get(title);
        if (row === undefined) throw new Error("vpass_credit_row_missing");
        if (row["hyoujiFlg"] === "1") continue;
        for (const [suffix, field, metric] of [
          ["Limit", "limit", "limit"],
          ["Balance", "balance", "outstanding"],
          ["Possible", "possible", "available"],
        ] as const) {
          const raw = integer(vo[`${prefix}${suffix}`]);
          // Observed raw units are 1,000 JPY; the display is decimal 万円.
          const text = row[field];
          if (displayRaw(text) !== raw) throw new Error("vpass_credit_display_mismatch");
          observations.push(
            reported(
              raw * 1000n,
              artifact,
              `reported_${scope}_${metric}_thousand_yen`,
              `json:$.body.content.AuthoriShokaiDisplayServiceBean.authoriShokaiVo.${prefix}${suffix}`,
              1000,
              { providerField: `${prefix}${suffix}`, providerDisplay: text },
              asOf,
            ),
          );
        }
      }
    } else if (artifact.artifactKey === "credit/revo.json") {
      exactKeys(
        content,
        ["CustomizedRevoShokaiAnsPcDisplayServiceBean", "Condition", "ContextRootServiceBean"],
        "vpass_revo_content_shape",
      );
      const bean = strictObject(
        content["CustomizedRevoShokaiAnsPcDisplayServiceBean"],
        "vpass_revo_bean_invalid",
      );
      exactKeys(bean, REVO_KEYS, "vpass_revo_shape");
      for (const field of REVO_KEYS) {
        const numeric = [
          "revoLimit",
          "revoMonthlyKingaku",
          "revoBonusMonth1",
          "revoBonusKingaku1",
          "revoBonusMonth2",
          "revoBonusKingaku2",
          "revoMonthlyKinFlag",
          "totalLimit",
        ].includes(field);
        if (
          numeric
            ? typeof bean[field] !== "number" || !Number.isFinite(bean[field])
            : typeof bean[field] !== "string"
        )
          throw new Error("vpass_revo_type");
      }
      for (const [field, metric] of [
        ["revoZan", "reported_revolving_outstanding_yen"],
        ["hensaiAmount", "reported_revolving_repayment_yen"],
      ] as const)
        observations.push(
          reported(
            integer(bean[field]),
            artifact,
            metric,
            `json:$.body.content.CustomizedRevoShokaiAnsPcDisplayServiceBean.${field}`,
            1,
            { providerField: field },
          ),
        );
    } else throw new Error("vpass_credit_artifact_invalid");
    return {
      observations,
      warnings: [],
      issues: [],
      coverage: [
        containerClaim({
          artifact,
          issues: [],
          observedCount: observations.length,
          evidenceRefs: observations.map((row) => row.rawLocator),
        }),
      ],
    };
  },
};
