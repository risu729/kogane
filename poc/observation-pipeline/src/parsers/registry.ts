import type { Parser } from "../types.ts";
import { paypayCsv } from "./paypay-csv.ts";
import { mobileSuicaSfHistory } from "./mobile-suica-sf-history.ts";
import { myJcbCreditLedger, myJcbEvidenceOnly, myJcbPastMonthBalances } from "./myjcb.ts";
import {
  sonyBankGrossBalance,
  sonyBankHistoryCsv,
  sonyBankHistoryJson,
  sonyBankWalletHistory,
} from "./sony-bank.ts";
import { globalPassActivity } from "./global-pass-activity-parser.ts";
import { sbiAccountAssetsCurrent } from "./sbi-account-assets-current.ts";
import { sbiDomesticCashPositions } from "./sbi-domestic-cash-positions.ts";
import { sbiDomesticTradeRecords } from "./sbi-domestic-trade-records.ts";
import { sbiForeignCashBalances } from "./sbi-foreign-cash-balances.ts";
import { sbiForeignCashPositions } from "./sbi-foreign-cash-positions.ts";
import { sbiForeignTradeRecords } from "./sbi-foreign-trade-records.ts";
import { sbiYenDetailHistory } from "./sbi-yen-detail-history.ts";
import { sbiVcAccountMargin } from "./sbi-vc-account-margin.ts";
import { sbiVcCashBalances } from "./sbi-vc-cash-balances.ts";
import { sbiVcCashflows } from "./sbi-vc-cashflows.ts";
import { sbiVcExecutions } from "./sbi-vc-executions.ts";
import { sbiVcPositionSummary } from "./sbi-vc-position-summary.ts";
import { smbcDirectBalance, smbcDirectTransactions } from "./smbc-direct.ts";
import { sbiShinseiTopBalancesAndActivity } from "./sbi-shinsei-top-balances-and-activity.ts";
import { sbiShinseiYenDepositAccount } from "./sbi-shinsei-yen-deposit-account.ts";
import { vPointBalanceInfo, vPointHistoryPage, vPointSmfgPoint } from "./v-point.ts";
import { vPointPayNotificationEvent } from "./v-point-pay.ts";
import { vpassStatementPage } from "./vpass.ts";

export const PARSERS: readonly Parser[] = [
  globalPassActivity,
  mobileSuicaSfHistory,
  myJcbCreditLedger,
  myJcbPastMonthBalances,
  myJcbEvidenceOnly,
  sonyBankGrossBalance,
  sonyBankHistoryJson,
  sonyBankHistoryCsv,
  sonyBankWalletHistory,
  sbiDomesticCashPositions,
  sbiAccountAssetsCurrent,
  sbiYenDetailHistory,
  sbiDomesticTradeRecords,
  sbiForeignTradeRecords,
  sbiForeignCashPositions,
  sbiForeignCashBalances,
  sbiVcCashBalances,
  sbiVcAccountMargin,
  sbiVcPositionSummary,
  sbiVcExecutions,
  sbiVcCashflows,
  smbcDirectBalance,
  smbcDirectTransactions,
  sbiShinseiTopBalancesAndActivity,
  sbiShinseiYenDepositAccount,
  vPointBalanceInfo,
  vPointSmfgPoint,
  vPointHistoryPage,
  vPointPayNotificationEvent,
  vpassStatementPage,
  paypayCsv,
];
