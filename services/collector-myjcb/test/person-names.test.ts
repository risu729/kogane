// ADR 0029, amendment 2: a stored MyJCB page keeps the account holder's name
// in the カード情報 table as the provider displays it; the sanitizer still
// removes full card numbers, credentials and executable markup, and nothing
// logs a page value. Synthetic page only: every value below is a made-up
// placeholder, and the markup mirrors the observed structure (a vertical
// th/td table-data table under an h3 「カード情報」), not any real page's text.
import { describe, expect, spyOn, test } from "bun:test";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import { readTerminal } from "../../../packages/collection/src/index";
import { redactedStatementHtml } from "../src/parsers";
import { assertRedactedHtml } from "../src/redaction";
import { persistSharedRun, type SharedRunInput } from "../src/shared-collection";

const HOLDER = "*見本* 名*";
const ROWS = {
  カード名称: "架空カード",
  カード発行会社: "架空発行会社",
  金融機関名: "架空見本銀行",
  支店名: "見本支店",
  "科目・口座番号": "普通 0000***",
  口座名義: HOLDER,
} as const;
// A made-up 16-digit number in the shape the sanitizer removes.
const FULL_CARD_NUMBER = "0000 1111 2222 3333";

function cardInformationPage(extraRow = ""): string {
  const rows = Object.entries(ROWS)
    .map(([label, value]) => `<tr><th>${label}</th><td>${value}</td></tr>`)
    .join("");
  return (
    '<html><body><h2 class="hdg-H2">カードご利用代金明細(確定分)</h2>' +
    '<div class="detail-list-01"><div class="head"><div class="cell">ご利用日</div></div></div>' +
    '<h3 class="hdg-H3">カード情報</h3>' +
    '<div class="detail-lyt-02 border-01"><div class="col-01"><table class="table-data"><tbody>' +
    rows +
    extraRow +
    "</tbody></table></div></div></body></html>"
  );
}

describe("a stored MyJCB page keeps the カード情報 table as displayed", () => {
  test("every row, the 口座名義 cell included, is kept and passes the shared check", () => {
    const stored = redactedStatementHtml(cardInformationPage());
    for (const [label, value] of Object.entries(ROWS)) {
      expect(stored).toContain(`<th>${label}</th><td>${value}</td>`);
    }
    expect(stored).not.toContain("[redacted:name]");
    expect(() => assertRedactedHtml(stored)).not.toThrow();
    expect(redactedStatementHtml(stored)).toBe(stored);
  });

  test("a full card number is still removed, and the shared check still refuses one", () => {
    const page = cardInformationPage(`<tr><th>見本</th><td>${FULL_CARD_NUMBER}</td></tr>`);
    const stored = redactedStatementHtml(page);
    expect(stored).not.toContain(FULL_CARD_NUMBER);
    expect(stored).toContain(HOLDER);
    expect(() => assertRedactedHtml(stored)).not.toThrow();
    expect(() => assertRedactedHtml(page)).toThrow("artifact_html_redaction_invalid");
  });

  test("DATA holds the page as sanitized, the manifest no name count, and nothing logs a page value", async () => {
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
    const decoded = [...bucket.entries.values()].map((entry) =>
      new TextDecoder().decode(entry.bytes),
    );
    // The stored page is the sanitized page byte for byte.
    expect(decoded).toContain(detail);
    const text = JSON.stringify(logged);
    for (const value of Object.values(ROWS)) expect(text).not.toContain(value);

    const read = await readTerminal(bucket, "myjcb", input.runId);
    if (read.outcome !== "found") throw new Error("terminal missing");
    const ref = read.manifest.artifacts.find((entry) => entry.artifactKey === "manifest.json")!
      .storageRef.key;
    const manifest = JSON.parse(new TextDecoder().decode(bucket.entries.get(ref)!.bytes)) as {
      artifacts: Record<string, unknown>[];
    };
    for (const artifact of manifest.artifacts) {
      expect(Object.keys(artifact)).not.toContain("redactedFieldCount");
    }
    expect(
      read.manifest.transformations
        .filter((step) => step.stepKind === "redacted")
        .map((step) => [step.transformerId, step.transformerVersion]),
    ).toEqual([
      ["myjcb-sanitizer", "v3"],
      ["myjcb-sanitizer", "v3"],
    ]);
  });
});
