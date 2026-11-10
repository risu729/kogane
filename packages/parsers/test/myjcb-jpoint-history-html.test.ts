import { expect, test } from "bun:test";
import { normalizeJPointHistoryHtml as normalize } from "../src/parsers/myjcb-jpoint-history-html.ts";
import { syntheticJPointHistory, syntheticJPointHistoryHtml } from "./myjcb-jpoint-history-fixture.ts";
test("raw server tables validate across all tabs without generated scroll wrappers or double publication", () => {
  const input = syntheticJPointHistory();
  const html = syntheticJPointHistoryHtml(input);
  expect(html).not.toContain("js-scrollable-tbl-body");
  expect(html).not.toContain("js-scrollable-tbl-head");
  expect(normalize(html, input.reportedTotal)).toEqual(input);
  expect(normalize(html, input.reportedTotal).rows).toHaveLength(3);
  expect(normalize(html, input.reportedTotal).rows[0]?.remaining).toBe("60");
});
test("raw table membership and labelled detail totals must agree, without reconstructing remaining quantities", () => {
  const html = syntheticJPointHistoryHtml();
  for (const input of [
    html.replace("<div class=\"inner\">90", "<div class=\"inner\">91"),
    html.replace("<th>失効予定月</th>", "<th>Unknown</th>"),
    html.replace("<dd>60</dd>", "<dd>60ポイント</dd>"),
    html.replace("<dt>通常獲得ポイント</dt>", "<dt>Unknown</dt>"),
    html.replace("2099/06", "2099/13"),
    html.replace("<td>有効</td>", "<td>集計中</td>"),
    html.replace('<div class="tab-panel">', '<div class="other">'),
    html.replace("</body>", ""), html.replace("</html>", ""),
    html.slice(0, html.indexOf("<div class=\"tab-panel\">") + 100),
    html.replace('90</td>', '9,000</td>'),
    html.replace('class="sp-fnt10px">2099/01/15', 'class="sp-fnt10px">2099/02/30'),
    html.replace('<br class="sp-block">', '<br>'),
    html.replace("</tbody></table></div></div>", "</tbody></table></div>"),
  ]) expect(() => normalize(input, "100")).toThrow();
  expect(() => normalize(html, "101")).toThrow("overview_total_mismatch");
});
