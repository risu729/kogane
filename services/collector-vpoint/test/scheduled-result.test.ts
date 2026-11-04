import { expect, test } from "bun:test";
import { awaitingReauthentication, vPointScheduledResult } from "../src/scheduled-result";
import type { CollectionManifest } from "../src/types";

const manifest: Pick<CollectionManifest, "status" | "runId" | "failures"> = {
  status: "failed",
  runId: "synthetic-run",
  failures: [
    {
      operation: "collect",
      errorType: "VPointSessionExpiredError",
      message: "authentication_required",
    },
  ],
};
test("email reauthentication waiting is not a generic failure or premature collection success", () => {
  expect(awaitingReauthentication(manifest)).toBe(true);
  expect(vPointScheduledResult({ manifest, terminal: { persisted: true } })).toEqual({
    status: "failed",
    runIds: ["synthetic-run"],
    failureCode: "reauthentication_pending",
  });
  expect(vPointScheduledResult({ manifest, terminal: { persisted: false } }).failureCode).toBe(
    "terminal_persistence_failed",
  );
});
test("an additional auth failure is not hidden as ordinary waiting", () => {
  const failures = [
    ...manifest.failures,
    { operation: "reauthenticate", errorType: "Error", message: "operation_failed" },
  ];
  expect(awaitingReauthentication({ ...manifest, failures })).toBe(false);
  expect(
    vPointScheduledResult({ manifest: { ...manifest, failures }, terminal: { persisted: true } })
      .failureCode,
  ).toBe("collection_failed");
});
test("only the independently successful persisted follow-up is complete", () => {
  expect(
    vPointScheduledResult({
      manifest: { status: "success", runId: "follow-up", failures: [] },
      terminal: { persisted: true },
    }),
  ).toEqual({ status: "completed", runIds: ["follow-up"], failureCode: null });
});
