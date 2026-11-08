import { describe, expect, test } from "bun:test";
import { renderUi } from "../src/ui";

describe("renderUi", () => {
  test("emits syntactically valid inline JavaScript", () => {
    const html = renderUi({ nonce: "test-nonce" });
    const opening = html.indexOf('<script nonce="test-nonce">');
    const bodyStart = opening === -1 ? -1 : html.indexOf(">", opening) + 1;
    const closing = html.lastIndexOf("</script>");
    expect(opening).not.toBe(-1);
    expect(closing).toBeGreaterThan(bodyStart);
    expect(() => new Function(html.slice(bodyStart, closing))).not.toThrow();
  });

  test("does not expose date controls", () => {
    const html = renderUi({ nonce: "test-nonce" });
    expect(html).not.toContain('type="date"');
    expect(html).toContain("取得可能な全期間");
  });

  test("a saved open-day acquisition explains fresh approval recovery, then clears the warning", () => {
    const html = renderUi({ nonce: "test-nonce" });
    const opening = html.indexOf('<script nonce="test-nonce">');
    const script = html.slice(html.indexOf(">", opening) + 1, html.lastIndexOf("</script>"));
    const elements = new Map<
      string,
      { textContent: string; hidden: boolean; addEventListener: () => void }
    >();
    const document = {
      getElementById: (id: string) => {
        const element = elements.get(id) ?? {
          textContent: "",
          hidden: false,
          addEventListener: () => {},
        };
        elements.set(id, element);
        return element;
      },
    };
    const screen = new Function("document", "fetch", script + ";return {showProgress};")(
      document,
      () => new Promise(() => {}),
    );
    screen.showProgress({
      phase: "success",
      publicationStatus: "persisted",
      coverageStatus: "partial",
      coverageErrorCode: "coverage_day_not_finished",
    });
    expect(elements.get("status")?.textContent).toContain("取得範囲: 未完了");
    expect(elements.get("status")?.textContent).toContain("QRを新しく生成して承認");
    expect(elements.get("status")?.textContent).toContain(
      "共有保存の再試行だけでは取得範囲は完了しません",
    );
    expect(elements.get("publish")?.hidden).toBeTrue();
    screen.showProgress({
      phase: "success",
      publicationStatus: "persisted",
      coverageStatus: "complete",
      coverageErrorCode: null,
    });
    expect(elements.get("status")?.textContent).not.toContain("取得範囲: 未完了");
    expect(elements.get("status")?.textContent).not.toContain("QRを新しく生成して承認");
  });
});
