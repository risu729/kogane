import type { StGeorgeSnapshot } from "../../../packages/parsers/src/st-george-contract";
export function snapshot(): StGeorgeSnapshot {
  return {
    schema: "st-george-browser-v1",
    observedAt: "2026-09-12T08:00:00.000Z",
    currency: "AUD",
    currencyEvidence: "source-configured",
    accounts: [
      {
        accountKey: "a".repeat(64),
        label: "Synthetic transaction account",
        currentBalanceText: "$120.00",
        availableBalanceText: "$120.00",
        openingBalanceText: "$125.00",
        closingBalanceText: "$120.00",
        historyState: "observed",
        pendingState: "unknown",
        transactions: [
          {
            dateText: "12/09/2026",
            description: "Synthetic purchase",
            category: "Shopping",
            debitText: "$5.00",
            creditText: "",
            balanceText: "$120.00",
          },
        ],
      },
    ],
  };
}
