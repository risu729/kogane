import type { Parser } from "../types.ts";
import { paypayCsv } from "./paypay-csv.ts";
import { mobileSuicaSfHistory } from "./mobile-suica-sf-history.ts";
import { sbiAccountAssetsCurrent } from "./sbi-account-assets-current.ts";
import { sbiDomesticCashPositions } from "./sbi-domestic-cash-positions.ts";
import { sbiDomesticTradeRecords } from "./sbi-domestic-trade-records.ts";
import { sbiForeignCashBalances } from "./sbi-foreign-cash-balances.ts";
import { sbiForeignCashPositions } from "./sbi-foreign-cash-positions.ts";
import { sbiForeignTradeRecords } from "./sbi-foreign-trade-records.ts";
import { sbiYenDetailHistory } from "./sbi-yen-detail-history.ts";

export const PARSERS: readonly Parser[] = [
  mobileSuicaSfHistory,
  sbiDomesticCashPositions,
  sbiAccountAssetsCurrent,
  sbiYenDetailHistory,
  sbiDomesticTradeRecords,
  sbiForeignTradeRecords,
  sbiForeignCashPositions,
  sbiForeignCashBalances,
  paypayCsv,
];
