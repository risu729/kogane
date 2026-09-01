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
});
