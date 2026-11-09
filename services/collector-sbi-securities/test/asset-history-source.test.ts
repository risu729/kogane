import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { assetHistoryArtifacts } from "../src/asset-history";
import { assetHistoryViews } from "../../../packages/parsers/src/parsers/sbi-asset-history-schema";
import { sbiAccountAssetsHistory as parser } from "../../../packages/parsers/src/parsers/sbi-account-assets-history";
import type { ArtifactMeta } from "../../../packages/parsers/src/types";

const fixture = () =>
  JSON.parse(
    readFileSync(
      new URL(
        "../../../tests/fixtures/observation-pipeline/sbi-parser-boundaries/account-assets-history.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as unknown;
const meta: ArtifactMeta = {
  id: 1,
  sourceId: "sbi-securities",
  dataset: "account-assets-history",
  runStatus: "success",
  runFailureCount: 0,
  url: null,
  mime: "application/json",
  fetchedAt: "2020-01-01T00:00:00Z",
  sha256: "0".repeat(64),
};
const encoded = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

async function sameRefusal(body: unknown, code: string): Promise<void> {
  const bytes = encoded(body);
  const original = bytes.slice();
  expect(() => parser.parse(bytes, meta)).toThrow(`sbi_asset_history_${code}`);
  await expect(
    assetHistoryArtifacts({ body, bytes, capturedAt: "2020-01-01T00:00:00.000Z" }),
  ).rejects.toThrow(`sbi_asset_history_${code}`);
  expect(bytes).toEqual(original);
}

test("a year boundary cannot hide a missing week or a completely missing year", async () => {
  for (const weeks of [1, 53]) {
    const body = fixture();
    for (const view of assetHistoryViews(body)) {
      if (view.transitions === null) continue;
      const old = Object.keys(view.transitions).sort()[0]!;
      const next = String(Number(old) - weeks * 7 * 86400000);
      view.transitions[next] = view.transitions[old]!;
      delete view.transitions[old];
      view.balances[0]![0] = Number(next);
      view.acquisitionCosts[0]![0] = Number(next);
    }
    await sameRefusal(body, "weekly_gap");
  }
});

test("extra native tuples outside the transition calendar cannot be filtered away", async () => {
  for (const field of ["balances", "acquisitionCosts"] as const) {
    const body = fixture();
    assetHistoryViews(body)[0]![field].push([4070444400000, 42]);
    await sameRefusal(body, "native_mismatch");
  }
});

test("raw financial tokens are checked even when the caller already supplied a rounded object", async () => {
  for (const literal of [
    "0.99999999999999999",
    "1.00000000000000001",
    "9007199254740991.1",
    "1e-999",
  ]) {
    const text = JSON.stringify(fixture()).replace('"profitLoss":10', `"profitLoss":${literal}`);
    const bytes = new TextEncoder().encode(text);
    const original = bytes.slice();
    expect(() => parser.parse(bytes, meta)).toThrow("sbi_asset_history_money");
    await expect(
      assetHistoryArtifacts({
        body: JSON.parse(text) as unknown,
        bytes,
        capturedAt: "2020-01-01T00:00:00.000Z",
      }),
    ).rejects.toThrow("sbi_asset_history_money");
    expect(bytes).toEqual(original);
  }
});
