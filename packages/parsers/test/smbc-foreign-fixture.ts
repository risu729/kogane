export const smbcForeignBalance = () =>
  JSON.stringify({
    currency: "AUD",
    amount: "123.45",
    yenEquivalent: "12000",
    referenceRate: "97.205",
    observedAt: "2099-04-02T01:00:00.000Z",
  });
export const smbcForeignHistory = () =>
  JSON.stringify({
    currency: "AUD",
    range: { start: "2099-01-01", end: "2099-01-31" },
    emptyCode: "PC-AIFDDT1-00134-E",
    transactions: [],
  });
