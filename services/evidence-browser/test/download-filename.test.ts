import { describe, expect, it } from "vitest";
import { downloadDisposition } from "../src/read";

const sha256 = "abcdef0123456789".repeat(4);
function filename(artifact_key: string, declared_media_type: string | null = null) {
  return downloadDisposition({ artifact_key, declared_media_type, sha256 });
}
function decoded(header: string): string {
  return decodeURIComponent(header.split("filename*=UTF-8''")[1]);
}

describe("raw download filenames", () => {
  it("preserves collector basenames and existing extensions over declared media types", () => {
    expect(decoded(filename("run/responses/statement.CSV", "application/json"))).toBe(
      "statement.CSV",
    );
    expect(decoded(filename("C:\\collector\\archive.tar.gz", "application/json"))).toBe(
      "archive.tar.gz",
    );
  });
  it("preserves Unicode using RFC 5987 with an ASCII fallback", () => {
    const header = filename("2026/残高 明細.csv", "text/csv");
    expect(header).toMatch(/^attachment; filename="_____\.csv"; filename\*=UTF-8''/);
    expect(decoded(header)).toBe("残高 明細.csv");
    expect(header).not.toMatch(/[^\x20-\x7e]/);
  });
  it("derives extensions only when absent, without pretending unknown bytes are a fixed type", () => {
    expect(decoded(filename("response", "Application/JSON; charset=utf-8"))).toBe("response.json");
    expect(decoded(filename("statement", "application/pdf"))).toBe("statement.pdf");
    expect(decoded(filename("body", "application/problem+json"))).toBe("body.json");
    expect(decoded(filename("body", "application/octet-stream"))).toBe("body");
    expect(decoded(filename("body"))).toBe("body");
  });
  it("removes paths, header injection, reserved names, and misleading bidi controls", () => {
    expect(decoded(filename("../../CON.csv"))).toBe("_CON.csv");
    expect(decoded(filename("LPT1"))).toBe("_LPT1");
    const header = filename('report\r\nX-Evil: "yes"\u202e.txt');
    expect(header).not.toMatch(/[\r\n]/);
    expect(decoded(header)).toBe("report__X-Evil_ _yes__.txt");
    expect(decoded(filename("../..", "text/plain"))).toBe(`artifact-${sha256.slice(0, 16)}.txt`);
    expect(decoded(filename("folder/"))).toBe(`artifact-${sha256.slice(0, 16)}`);
  });
  it("escapes RFC 5987 special characters and bounds long names without losing the extension", () => {
    expect(filename("report's (1).csv")).toContain("report%27s%20%281%29.csv");
    const name = decoded(filename(`${"明".repeat(150)}.csv`));
    expect(Array.from(name)).toHaveLength(120);
    expect(name.endsWith(".csv")).toBe(true);
    expect(() => filename("unpaired\ud800.json")).not.toThrow();
  });
});
