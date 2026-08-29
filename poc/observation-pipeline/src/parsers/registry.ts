import type { Parser } from "../types.ts";
import { paypayCsv } from "./paypay-csv.ts";
import { sbiDomesticTradeRecords } from "./sbi-domestic-trade-records.ts";
import { sbiForeignCashBalances } from "./sbi-foreign-cash-balances.ts";
import { sbiForeignCashPositions } from "./sbi-foreign-cash-positions.ts";

export const PARSERS: readonly Parser[] = [
  sbiDomesticTradeRecords,
  sbiForeignCashPositions,
  sbiForeignCashBalances,
  paypayCsv,
];
