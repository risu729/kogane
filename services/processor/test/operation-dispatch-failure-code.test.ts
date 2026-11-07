// The real dispatch callback is the Worker log's input. Registration throws
// remain retries, while writable error names never reach the diagnostic.
import { beforeAll, expect, test } from "bun:test";
import { d1CommandStore, type Principal } from "../../../packages/application/src/index.ts";
import {
  readOperation,
  requestImport,
} from "../../../packages/application/src/operations/requests.ts";
import { fullCoreDatabase, sqliteD1 } from "../../../packages/storage-d1/test/sqlite.ts";
import { dispatchOperations } from "../src/operations/dispatch.ts";
import { collectionHarness, persistSyntheticRun, SOURCE } from "./collection-harness.ts";

beforeAll(() => {
  fullCoreDatabase().close();
}, 60_000);

const PRINCIPAL: Principal = {
  id: "operator-1",
  kind: "human",
  verification: "server",
  capabilities: [],
};
const NOW = "2026-09-11T00:00:00Z";

test("dispatch registration diagnostics refuse unsafe names without changing the retry", async () => {
  const privateText = "synthetic/private/key";
  const named = (name: string) => Object.assign(new Error(privateText), { name });
  const cases: [unknown, string][] = [
    [new TypeError(privateText), "TypeError"],
    [named(privateText), "Error"],
    [named("synthetic_private_key_123"), "Error"],
    [named("private\ntext"), "Error"],
    [named("A".repeat(65)), "Error"],
    [privateText, "unknown"],
    [null, "unknown"],
  ];
  for (const [failure, expected] of cases) {
    const harness = collectionHarness({ OPS_DISPATCH_ENABLED: "true" });
    const store = d1CommandStore(sqliteD1(harness.db) as never);
    await persistSyntheticRun(harness);
    const accepted = await requestImport({
      store,
      principal: PRINCIPAL,
      now: NOW,
      request: { source: SOURCE, runId: "run-001" },
    });
    if (!accepted.ok) throw new Error("acceptance failed");
    harness.bucket.head = async () => {
      throw failure;
    };
    const codes: string[] = [];
    expect(
      await dispatchOperations(harness.env, {
        now: () => new Date(NOW),
        onFailure: (code) => codes.push(code),
      }),
    ).toMatchObject({ claimed: 1, dispatched: 0, failed: 1 });
    expect(codes).toEqual([expected]);
    expect(JSON.stringify(codes)).not.toContain(privateText);
    expect(JSON.stringify(codes)).not.toContain("synthetic_private_key_123");
    const receipt = await readOperation({
      store,
      principal: PRINCIPAL,
      now: NOW,
      operationId: accepted.receipt.operationId,
    });
    if (!receipt.ok) throw new Error("receipt missing");
    expect(receipt.receipt.status).toBe("accepted");
    expect(receipt.receipt.dispatch).toMatchObject({ state: "dispatch_pending", attempts: 1 });
    expect(receipt.receipt.failureCode).toBe("registration_failed");
    expect(
      harness.db
        .query<{ n: number }, [string]>(
          "SELECT count(*) AS n FROM ops_request_stages WHERE operation_id=?1",
        )
        .get(accepted.receipt.operationId),
    ).toEqual({ n: 0 });
  }
});
