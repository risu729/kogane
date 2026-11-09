export const PDF_TEXT = "%PDF-1.7\nsynthetic report\n%%EOF\n";
export const reportListFixture = (periods: readonly string[] = []) => ({
  responseParam: {
    postingDate: "synthetic-date",
    mailID: "synthetic-private-mail",
    eStatementStatus: "synthetic-status",
    mfReportStatus: "synthetic-status",
    slPostingDate: "synthetic-date",
    periodDetails: periods.map((period) => ({ year: period.slice(0, 4), month: period.slice(5) })),
  },
  header: { adapterResultCode: "0" },
});
export const reportDownloadFixture = (period: string, pdf = PDF_TEXT) => ({
  responseParam: {
    postingDate: "synthetic-private-date",
    year: period.slice(0, 4),
    month: period.slice(5),
    fileName: "synthetic-private-name.pdf",
    fileSize: String(pdf.length),
    fileStream: btoa(pdf),
  },
  header: { adapterResultCode: "0" },
});
export function emptyReportHandoff(handoff: string): string {
  try {
    const value = JSON.parse(handoff);
    return value.ok === true && value.failure === undefined && value.documents === undefined
      ? JSON.stringify({
          ...value,
          documents: { list: JSON.stringify(reportListFixture()), downloads: [] },
        })
      : handoff;
  } catch {
    return handoff;
  }
}
export const inventoryDatabase = {
  prepare: () => {
    const statement = {
      bind: (..._values: unknown[]) => statement,
      run: async () => ({ meta: { changes: 1 } }),
      all: async () => ({ success: true, results: [] }),
    };
    return statement;
  },
};
