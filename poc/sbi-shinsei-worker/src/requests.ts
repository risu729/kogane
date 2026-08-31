import type { JsonObject, TransportRequest } from "./types";

const NO_BODY_OPERATIONS = new Set([
  "common.security-connect",
  "common.validate-token",
  "top.accounts-balance-and-activity",
  "top.balance-summary-and-stage",
  "common.exchange-rate",
] as const);

export const YEN_DEPOSIT_SCREEN_GROUP_ID = "CTYD0004" as const;

export function noBodyRequest(
  operation:
    | "common.security-connect"
    | "common.validate-token"
    | "top.accounts-balance-and-activity"
    | "top.balance-summary-and-stage"
    | "common.exchange-rate",
): TransportRequest {
  if (!NO_BODY_OPERATIONS.has(operation)) {
    throw new Error("SBI Shinsei operation is not a no-body request");
  }
  return { operation };
}

export function yenDepositAccountRequest(screenGroupID: string): TransportRequest {
  if (screenGroupID.length === 0 || screenGroupID.length > 64) {
    throw new Error("SBI Shinsei screenGroupID has an invalid length");
  }
  const body: JsonObject = { requestParam: { screenGroupID } };
  return {
    operation: "yen-deposit.account",
    body,
  };
}
