import type { DecisionOrigin } from "../../domain/src/decision-origin.ts";
export { isDecisionOrigin } from "../../domain/src/decision-origin.ts";
export type { DecisionOrigin } from "../../domain/src/decision-origin.ts";

/** Missing metadata during a rolling deployment does not assert human authorship. */
export function decisionOriginLabel(origin: DecisionOrigin | undefined, method: string): string {
  if (origin === "delegated") return "委任された操作";
  if (origin === "operator") return "手動操作";
  if (origin === "automatic") return method === "rule" ? "規則による判断" : "自動の判断";
  if (origin === "legacy") return "旧記録の判断";
  return method === "rule" ? "規則による判断" : "判断（実行者の記録なし）";
}
