import type { JPointHistory } from "../../domain/src/myjcb-jpoint-history.ts";
export function syntheticJPointHistory(): JPointHistory {
  return {
    schemaVersion: "myjcb-jpoint-history-v1",
    reportedTotal: "100",
    rows: [
      {
        acquiredOn: "2099-01-15",
        paymentText: "(2/10)",
        earned: "90",
        used: "-70",
        expired: "0",
        remaining: "60",
        normal: "60",
        preferential: "10",
        bonus: "20",
        expiryMonth: "2099-06",
        status: "有効",
      },
      {
        acquiredOn: "2098-12-15",
        paymentText: "(1/10)",
        earned: "80",
        used: "-20",
        expired: "-10",
        remaining: "40",
        normal: "50",
        preferential: "10",
        bonus: "20",
        expiryMonth: "2099-05",
        status: "有効",
      },
      {
        acquiredOn: "2098-11-15",
        paymentText: "(-)",
        earned: "10",
        used: "0",
        expired: "0",
        remaining: "0",
        normal: "10",
        preferential: "0",
        bonus: "0",
        expiryMonth: null,
        status: "-",
      },
    ],
  };
}
export function syntheticJPointHistoryHtml(data = syntheticJPointHistory()): string {
  const date = (row: JPointHistory["rows"][number]) =>
    `<td class="sp-fnt10px">${row.acquiredOn.replaceAll("-", "/")}<br class="sp-block"> <span>${row.paymentText}</span> </td>`;
  const numeric = (value: string) => `<td class="num sp-fnt10px">${value}</td>`;
  const heads = [
    ["獲得月（支払月）", "獲得ポイント", "使用済ポイント", "失効ポイント", "ポイント残高"],
    ["獲得月（支払月）", "当月獲得ポイント合計", "詳細"],
    ["獲得月（支払月）", "失効予定ポイント", "失効予定月", "ステータス"],
  ];
  const bodies = [
    data.rows.map(
      (r) =>
        `<tr>${date(r)}${[r.earned, r.used, r.expired, r.remaining].map(numeric).join("")}</tr>`,
    ),
    data.rows.map(
      (r) =>
        `<tr>${date(r)}<td class="num sp-fnt10px no-padding"><div class="inner">${r.earned}</div><div class="js-toggle-content"><dl class="detail"><dt>通常獲得ポイント</dt><dd>${r.normal}</dd><dt>優遇ポイント</dt><dd>${r.preferential}</dd><dt>ボーナスポイント</dt><dd>${r.bonus}</dd></dl></div></td><td class="js-toggle-item">開く</td></tr>`,
    ),
    data.rows.map(
      (r) =>
        `<tr>${date(r)}${numeric(r.remaining)}<td>${r.expiryMonth?.replace("-", "/") ?? "-"}</td><td>${r.status}</td></tr>`,
    ),
  ];
  return `<!doctype html><html><head><title>Synthetic reward history</title></head><body><div class="tab-group">${heads.map((headers, index) => `<div class="tab-panel"><div class="js-scrollable-tbl"><table><thead><tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>${bodies[index]!.join("")}</tbody></table></div></div>`).join("")}</div></body></html>`;
}
