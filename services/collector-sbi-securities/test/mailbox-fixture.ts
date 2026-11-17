import type { MailboxRow } from "../src/mailbox-contract";

export function mailboxRow(sequence = "synthetic-sequence-1"): MailboxRow {
  return {
    readSts: "synthetic-state",
    sBaseDate: "20990101",
    sName: "synthetic name",
    sType: "NULL",
    kofuInfoKtitle: "synthetic title",
    busiSys: "synthetic-business",
    kofuHms: "synthetic-time",
    etsuranKigen: "synthetic-expiry",
    sIntFileId: "synthetic-list-file",
    sOriFileId: "synthetic-list-origin",
    sCount: "synthetic-count",
    sCd: "FR81011D02",
    sCdSeq: sequence,
    userTokuteiId: "synthetic-user",
    sTypeCd: " ",
    starSts: "synthetic-star",
    sDoiyoKbn: "synthetic-state",
    rDoiyoKbn: "synthetic-state",
    kofuInfoKinfo: null,
    kofuDetailList: null,
    kakuninFlg: null,
  };
}

export const mailboxEnvelope = (body: Record<string, unknown>) => ({
  ctt: null,
  code: "200000",
  message: "",
  ...body,
});
export const mailboxList = (rows: readonly Record<string, unknown>[] = [mailboxRow()]) =>
  mailboxEnvelope({ outlist: rows, allCountKen: rows.length });
export const mailboxSummary = (total = 1) =>
  mailboxEnvelope({
    summaryList: [
      {
        busiSys: "synthetic-business",
        userTokuteiId: "synthetic-user",
        kofuKensu: total,
        mikaifuKensu: 0,
      },
    ],
  });
export const mailboxDetailFixture = () =>
  mailboxEnvelope({
    kofuInfoKinfo: "synthetic info",
    kofuInfo: "synthetic info",
    readSts: "synthetic-state",
    readHms: "synthetic-time",
    tsuchiInfo: "synthetic notice\nsecond synthetic line",
    tsuchiInfoKinfo: "synthetic-info",
    torizanKbn: "synthetic-state",
    sDoiyoKbn: "synthetic-state",
    rDoiyoKbn: "synthetic-state",
    sTypeCd: " ",
    kofuDetailList: [{ sOriFileId: "synthetic-document.pdf", sIntFileId: "synthetic-detail-file" }],
    doiHms: null,
    doiCreateSts: null,
    doiHonbun: null,
    doiComment: null,
    kakuninFlg: null,
  });

export const mailboxBootstrapHtml = () => `<!doctype html><html><head></head><body><script>
window.onload = function() {
${["dp-csrf", "dp-riyoCd", "dp-dId", "dp-userName", "dp-lastLoginTime", "dp-sentakukino", "dp-hyoujiseigyo", "dp-sfn"].map((key) => `sessionStorage.setItem("${key}", "synthetic-${key}");`).join("\n")}
autoRedirect();
};
function autoRedirect() { window.location.href = "https://plus.e-shishobako.ne.jp" + "/dp_apl/usr/"; }
</script></body></html>`;

export const mailboxFormHtml = (action: string, fields: readonly string[]) =>
  `<!doctype html><html><body><form method="POST" action="${action}">${fields.map((key) => `<input type="hidden" name="${key}" value="synthetic-${key}">`).join("")}</form></body></html>`;
