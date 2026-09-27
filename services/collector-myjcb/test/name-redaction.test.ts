// ADR 0029, amendment 2026-09-27: the account holder's name leaves a MyJCB
// page before it is stored; the other rows of the カード情報 table stay.
// Synthetic page only: every value below is a made-up placeholder, and the
// markup mirrors the observed structure (a vertical th/td table-data table
// under an h3 「カード情報」), not any real page's text.
import { describe, expect, spyOn, test } from "bun:test";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import { readTerminal } from "../../../packages/collection/src/index";
import { NAME_REDACTION_MARKER, nameRedactionCount } from "../src/name-redaction";
import { redactedStatementHtml } from "../src/parsers";
import { assertRedactedHtml } from "../src/redaction";
import { persistSharedRun, type SharedRunInput } from "../src/shared-collection";

const HOLDER = "*見本* 名*";
const KEPT = {
  カード名称: "架空カード",
  カード発行会社: "架空発行会社",
  金融機関名: "架空見本銀行",
  支店名: "見本支店",
  "科目・口座番号": "普通 0000***",
} as const;

function cardInformationPage(holderRow = `<tr><th>口座名義</th><td>${HOLDER}</td></tr>`): string {
  const rows = Object.entries(KEPT)
    .map(([label, value]) => `<tr><th>${label}</th><td>${value}</td></tr>`)
    .join("");
  return (
    '<html><body><h2 class="hdg-H2">カードご利用代金明細(確定分)</h2>' +
    '<div class="detail-list-01"><div class="head"><div class="cell">ご利用日</div></div></div>' +
    '<h3 class="hdg-H3">カード情報</h3>' +
    '<div class="detail-lyt-02 border-01"><div class="col-01"><table class="table-data"><tbody>' +
    rows +
    holderRow +
    "</tbody></table></div></div></body></html>"
  );
}

describe("the 口座名義 cell is replaced before a MyJCB page is stored", () => {
  test("the holder's name becomes the marker; the other カード情報 rows are kept", () => {
    const redacted = redactedStatementHtml(cardInformationPage());
    expect(redacted).not.toContain(HOLDER);
    expect(redacted).toContain(`<th>口座名義</th><td>${NAME_REDACTION_MARKER}</td>`);
    for (const [label, value] of Object.entries(KEPT)) {
      expect(redacted).toContain(`<th>${label}</th><td>${value}</td>`);
    }
    expect(nameRedactionCount(redacted)).toBe(1);
    expect(() => assertRedactedHtml(redacted)).not.toThrow();
    // Redacting again changes nothing: the marker is not a name.
    expect(redactedStatementHtml(redacted)).toBe(redacted);
  });

  test("the label is matched as the whole header text, whitespace aside", () => {
    const redacted = redactedStatementHtml(
      cardInformationPage(
        `<tr><th class="x">\n  口座名義 </th>\n<td><span>${HOLDER}</span></td></tr>`,
      ),
    );
    expect(redacted).not.toContain(HOLDER);
    expect(nameRedactionCount(redacted)).toBe(1);
    // A header that only mentions the word is not the row.
    const other = redactedStatementHtml(
      cardInformationPage("<tr><th>口座名義の変更について</th><td>見本の案内</td></tr>"),
    );
    expect(other).toContain("見本の案内");
    expect(nameRedactionCount(other)).toBe(0);
  });

  test("a 口座名義 header without a value cell is refused, not stored", () => {
    for (const row of [
      "<tr><th>口座名義</th></tr>",
      `<tr><th>口座名義</th><th>${HOLDER}</th></tr>`,
    ]) {
      expect(() => redactedStatementHtml(cardInformationPage(row))).toThrow(
        "artifact_name_redaction_invalid",
      );
    }
  });

  test("the shared path refuses a page whose 口座名義 cell still holds text", () => {
    const sanitizedOnly = redactedStatementHtml(cardInformationPage()).replace(
      NAME_REDACTION_MARKER,
      HOLDER,
    );
    expect(() => assertRedactedHtml(sanitizedOnly)).toThrow("artifact_html_redaction_invalid");
  });

  test("the shared check finds the header in any markup the redaction would", () => {
    // Each row is one the redaction replaces; unredacted, the check refuses it.
    for (const row of [
      `<tr><th><span>口座名義</span></th><td>${HOLDER}</td></tr>`,
      `<tr><th class="x">\n 口座 名義 </th>\n<td>${HOLDER}</td></tr>`,
      `<tr><th>口座名義</th><td>${NAME_REDACTION_MARKER}<span>${HOLDER}</span></td></tr>`,
      "<tr><th>口座名義</th></tr>",
    ]) {
      expect(() => assertRedactedHtml(cardInformationPage(row))).toThrow(
        "artifact_html_redaction_invalid",
      );
    }
    const redacted = redactedStatementHtml(
      cardInformationPage(`<tr><th><span>口座名義</span></th><td>${HOLDER}</td></tr>`),
    );
    expect(() => assertRedactedHtml(redacted)).not.toThrow();
    // A page without the カード情報 table has nothing to check.
    expect(() => assertRedactedHtml("<html><body><h1>見本</h1></body></html>")).not.toThrow();
  });

  test("DATA holds the marker, the manifest its count, and nothing logs a page value", async () => {
    const detail = redactedStatementHtml(cardInformationPage());
    const menu = redactedStatementHtml("<html><body><h1>見本メニュー</h1></body></html>");
    const input: SharedRunInput = {
      schemaVersion: "myjcb-worker-poc-v1",
      runId: "7d8f4b16-6d5c-4f0f-9a3e-0a1b2c3d4e60",
      startedAt: "2026-09-11T21:00:00.000Z",
      completedAt: "2026-09-11T21:06:00.000Z",
      status: "success",
      trigger: "scheduled",
      connections: [
        {
          summary: {
            connectionId: "account-one",
            bootstrapMode: "password",
            status: "success",
            cardCount: 1,
            periodCount: 1,
            artifactCount: 2,
          },
          artifacts: [
            {
              dataset: "credit-menu",
              filename: "credit-menu.html",
              body: menu,
              mediaType: "text/html; charset=utf-8",
            },
            {
              dataset: "credit-detail",
              filename: "credit-detail-01.html",
              body: detail,
              mediaType: "text/html; charset=utf-8",
              statementState: "confirmed",
              period: "2026-09",
            },
          ],
        },
      ],
      failures: [],
    };
    const logged: unknown[][] = [];
    const spies = (["log", "warn", "error", "info", "debug"] as const).map((level) =>
      spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args)),
    );
    const bucket = new FakeR2Bucket();
    try {
      const outcome = await persistSharedRun(bucket, input);
      expect(outcome.result.outcome).toBe("persisted");
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
    const stored = [...bucket.entries.values()]
      .map((entry) => new TextDecoder().decode(entry.bytes))
      .join("\n");
    expect(stored).not.toContain(HOLDER);
    expect(stored).toContain(KEPT.金融機関名);
    const text = JSON.stringify(logged);
    for (const value of [HOLDER, ...Object.values(KEPT)]) expect(text).not.toContain(value);

    const read = await readTerminal(bucket, "myjcb", input.runId);
    if (read.outcome !== "found") throw new Error("terminal missing");
    const ref = read.manifest.artifacts.find((entry) => entry.artifactKey === "manifest.json")!
      .storageRef.key;
    const manifest = JSON.parse(new TextDecoder().decode(bucket.entries.get(ref)!.bytes)) as {
      artifacts: { dataset: string; redactedFieldCount?: number }[];
    };
    expect(
      manifest.artifacts.map((artifact) => [artifact.dataset, artifact.redactedFieldCount]),
    ).toEqual([
      ["credit-menu", 0],
      ["credit-detail", 1],
    ]);
  });
});
