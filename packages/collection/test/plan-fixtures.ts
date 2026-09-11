// Synthetic run plans. Every value here is invented: no provider name that
// maps to a real account, no real amount, no real identifier.
import type { TerminalRunFields } from "../src/manifest";
import type { PersistArtifact, PersistRunPlan } from "../src/writer";
import { bytesOf, fakeSha256Hex } from "./fake-bucket";

export const SYNTHETIC_SOURCE = "kogane-synthetic";

export async function syntheticArtifact(
  artifactKey: string,
  text: string,
  overrides: Partial<Omit<PersistArtifact, "artifactKey" | "body">> = {},
): Promise<PersistArtifact> {
  const bytes = bytesOf(text);
  return {
    artifactKey,
    sha256: await fakeSha256Hex(bytes),
    byteSize: bytes.byteLength,
    mediaType: "application/json",
    role: "provider_response",
    body: { kind: "bytes", bytes },
    ...overrides,
  };
}

export function syntheticRun(overrides: Partial<TerminalRunFields> = {}): TerminalRunFields {
  return {
    source: SYNTHETIC_SOURCE,
    producer: "example-collector",
    producerVersion: "example-collector-1.0.0",
    runId: "run-001",
    attemptId: "attempt-001",
    requestedScope: {
      scopeKind: "full_snapshot",
      startValue: null,
      endValue: null,
      unitKeys: [],
    },
    startedAt: "2026-09-01T00:00:00.000Z",
    completedAt: "2026-09-01T00:01:00.000Z",
    providerOutcome: "success",
    coverageStatus: "unknown",
    persistenceComplete: true,
    units: [],
    ranges: [],
    reports: [],
    transformations: [],
    ...overrides,
  };
}

export async function syntheticPlan(
  overrides: { run?: Partial<TerminalRunFields>; artifacts?: readonly PersistArtifact[] } = {},
): Promise<PersistRunPlan> {
  return {
    run: syntheticRun(overrides.run),
    artifacts: overrides.artifacts ?? [
      await syntheticArtifact("balance.json", '{"synthetic":true}'),
      await syntheticArtifact("statement.json", '{"synthetic":"statement"}'),
    ],
  };
}
