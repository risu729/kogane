import { expect, test } from "bun:test";
import { validApiResponse } from "../shared/api-validation.ts";
import { parsingHealthMessage } from "../web/src/parsing-health.tsx";
import { LOCAL_STORE_CAPABILITIES } from "../shared/api-schema.ts";

const metadata = {
  apiVersion: 1,
  source: { kind: "local-store", classification: "unknown" },
  capabilities: LOCAL_STORE_CAPABILITIES,
};
test("parsing health remains optional for local/demo and rejects invalid counts", () => {
  expect(validApiResponse("/api/meta", metadata)).toBe(true);
  expect(
    validApiResponse("/api/meta", {
      ...metadata,
      parsingHealth: { pending: 2, running: 1, failed: 3 },
    }),
  ).toBe(true);
  for (const failed of [-1, 0.5, "2", Number.MAX_SAFE_INTEGER + 1]) {
    expect(
      validApiResponse("/api/meta", {
        ...metadata,
        parsingHealth: { pending: 0, running: 0, failed },
      }),
    ).toBe(false);
  }
});
test("incomplete parsing gets an explicit coverage warning without a freshness assertion", () => {
  expect(parsingHealthMessage(undefined)).toBeNull();
  expect(parsingHealthMessage({ pending: 0, running: 0, failed: 0 })).toBeNull();
  for (const health of [
    { pending: 2, running: 0, failed: 0 },
    { pending: 0, running: 1, failed: 0 },
    { pending: 0, running: 0, failed: 3 },
  ]) {
    const message = parsingHealthMessage(health)!;
    expect(message).toContain("未反映の記録");
    expect(message).toContain("データの新しさを示しません");
    expect(message).toContain(`解析失敗 ${health.failed}件`);
  }
});
