import { parse } from "parse5";
import {
  createMoneyForwardEvidenceOnly,
  createMoneyForwardMonthlyTransactions,
  type MoneyForwardDomNode,
} from "./moneyforward.ts";

const parseHtml = (
  html: string,
  options?: { sourceCodeLocationInfo?: boolean },
): MoneyForwardDomNode => parse(html, options) as unknown as MoneyForwardDomNode;

export const moneyForwardMonthlyTransactions = createMoneyForwardMonthlyTransactions(parseHtml);
export const moneyForwardEvidenceOnly = createMoneyForwardEvidenceOnly(parseHtml);
