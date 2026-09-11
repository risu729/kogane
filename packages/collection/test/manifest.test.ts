import { describe, expect, test } from "bun:test";
import { canonicalTerminalJson, terminalDigest } from "../src/digest";
import { objectKey } from "../src/keys";
import {
  parseTerminalManifest,
  TERMINAL_MANIFEST_VERSION,
  TerminalManifestError,
  tryParseTerminalManifest,
} from "../src/manifest";
import { planManifest } from "../src/writer";
import { syntheticArtifact, syntheticPlan, syntheticRun } from "./plan-fixtures";

const DIGEST = "cb8daed7b30399a1c3c8b83b3b7bee4b774a30fc389afc1d375e4c23a3cc4ae8";

function manifestOf(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...syntheticRun(),
    manifestVersion: TERMINAL_MANIFEST_VERSION,
    artifacts: [
      {
        artifactKey: "example.json",
        storageRef: { store: "DATA", key: objectKey(DIGEST) },
        sha256: DIGEST,
        byteSize: 19,
        mediaType: "application/json",
        role: "synthetic",
      },
    ],
    ...overrides,
  };
}

describe("terminal-v1 manifest", () => {
  test("accepts the control shape of contracts/terminal.example.json", () => {
    const manifest = parseTerminalManifest(manifestOf());
    expect(manifest.manifestVersion).toBe("terminal-v1");
    expect(manifest.persistenceComplete).toBe(true);
    expect(manifest.artifacts[0]).toEqual({
      artifactKey: "example.json",
      storageRef: { store: "DATA", key: `objects/cb/${DIGEST}` },
      sha256: DIGEST,
      byteSize: 19,
      mediaType: "application/json",
      role: "synthetic",
    });
  });

  test("rejects unknown fields, wrong versions and a storageRef that is not the digest", () => {
    expect(() => parseTerminalManifest({ ...manifestOf(), extra: 1 })).toThrow(
      new TerminalManifestError("unknown_field"),
    );
    expect(() =>
      parseTerminalManifest(manifestOf({ manifestVersion: "proposal-terminal-v1" })),
    ).toThrow(new TerminalManifestError("invalid_manifest_version"));
    expect(() =>
      parseTerminalManifest(
        manifestOf({
          artifacts: [
            {
              artifactKey: "example.json",
              storageRef: { store: "DATA", key: "objects/ff/somewhere-else" },
              sha256: DIGEST,
              byteSize: 19,
              mediaType: "application/json",
              role: "synthetic",
            },
          ],
        }),
      ),
    ).toThrow(new TerminalManifestError("artifact_storage_ref_mismatch"));
  });

  // G1-08: a partial acquisition stays partial. Persistence is complete and
  // the financial coverage gap is stated at the same time.
  test("G1-08 partial keeps the persistence claim and the coverage gap together", () => {
    const manifest = parseTerminalManifest(
      manifestOf({
        providerOutcome: "partial",
        coverageStatus: "partial",
        safeErrorCode: "provider_page_missing",
      }),
    );
    expect(manifest.providerOutcome).toBe("partial");
    expect(manifest.persistenceComplete).toBe(true);
    expect(manifest.coverageStatus).toBe("partial");
    expect(manifest.safeErrorCode).toBe("provider_page_missing");
    // The combination a caller would use to make partial look like success.
    expect(() =>
      parseTerminalManifest(
        manifestOf({
          providerOutcome: "partial",
          coverageStatus: "complete",
          safeErrorCode: "provider_page_missing",
        }),
      ),
    ).toThrow(new TerminalManifestError("incomplete_run_claims_complete_coverage"));
    expect(() =>
      parseTerminalManifest(manifestOf({ providerOutcome: "partial", coverageStatus: "partial" })),
    ).toThrow(new TerminalManifestError("safe_error_code_required"));
  });

  // G1-09: a failed run with nothing stored stays a failure; it is not a
  // complete observation of "zero".
  test("G1-09 failed with zero artifacts is a real failure, not an empty success", () => {
    const manifest = parseTerminalManifest(
      manifestOf({
        providerOutcome: "failed",
        coverageStatus: "unknown",
        safeErrorCode: "collector_failed",
        artifacts: [],
      }),
    );
    expect(manifest.artifacts).toEqual([]);
    expect(manifest.providerOutcome).toBe("failed");
    expect(manifest.coverageStatus).toBe("unknown");
    expect(() =>
      parseTerminalManifest(
        manifestOf({
          providerOutcome: "failed",
          coverageStatus: "complete",
          safeErrorCode: "collector_failed",
          artifacts: [],
        }),
      ),
    ).toThrow(new TerminalManifestError("incomplete_run_claims_complete_coverage"));
    expect(() => parseTerminalManifest(manifestOf({ safeErrorCode: "collector_failed" }))).toThrow(
      new TerminalManifestError("safe_error_code_on_success"),
    );
  });

  // G1-16: one acquisition session over several sources keeps a run and a
  // terminal per source; the session ref links them without merging them.
  test("G1-16 a multi-source session keeps one run per source", async () => {
    const sessionRef = "session-2026-09-01";
    const first = parseTerminalManifest(
      manifestOf({ source: "kogane-synthetic", acquisitionSessionRef: sessionRef }),
    );
    const second = parseTerminalManifest(
      manifestOf({ source: "kogane-synthetic-two", acquisitionSessionRef: sessionRef }),
    );
    expect(first.acquisitionSessionRef).toBe(sessionRef);
    expect(second.acquisitionSessionRef).toBe(sessionRef);
    expect(first.source).not.toBe(second.source);
    expect(await terminalDigest(first)).not.toBe(await terminalDigest(second));
  });

  test("arrays are sorted so two statements of the same run share a digest", async () => {
    const plan = await syntheticPlan({
      artifacts: [
        await syntheticArtifact("b.json", '{"b":1}'),
        await syntheticArtifact("a.json", '{"a":1}'),
      ],
    });
    const reversed = await syntheticPlan({
      artifacts: [...plan.artifacts].reverse(),
    });
    const left = planManifest(plan);
    const right = planManifest(reversed);
    expect(left.artifacts.map((entry) => entry.artifactKey)).toEqual(["a.json", "b.json"]);
    expect(await terminalDigest(left)).toBe(await terminalDigest(right));
    expect(canonicalTerminalJson(left)).toBe(canonicalTerminalJson(right));
  });

  test("cross references must resolve inside the manifest", () => {
    expect(() =>
      parseTerminalManifest(
        manifestOf({
          artifacts: [
            {
              artifactKey: "example.json",
              storageRef: { store: "DATA", key: objectKey(DIGEST) },
              sha256: DIGEST,
              byteSize: 19,
              mediaType: "application/json",
              role: "synthetic",
              unitKey: "card-001",
            },
          ],
        }),
      ),
    ).toThrow(new TerminalManifestError("artifact_unit_key_unknown"));
  });

  test("a corrupt manifest reports a code instead of throwing into a scan", () => {
    expect(tryParseTerminalManifest({ manifestVersion: "terminal-v1", nope: 1 })).toEqual({
      ok: false,
      code: "unknown_field",
    });
    expect(tryParseTerminalManifest({ ...manifestOf(), source: "Not A Source" })).toEqual({
      ok: false,
      code: "invalid_source",
    });
    expect(tryParseTerminalManifest("not an object")).toEqual({
      ok: false,
      code: "invalid_manifest",
    });
    const parsed = tryParseTerminalManifest(manifestOf());
    expect(parsed.ok).toBe(true);
  });
});
