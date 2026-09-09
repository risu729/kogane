// Golden vectors for descriptor-v1.
//
// The expected normalized JSON, canonical bytes, and SHA-256 digests in
// fixtures/golden-vectors.json were produced by the PRE-REFACTOR
// implementations at commit 130912af (collector-r2-importer central.ts
// centralDescriptorSha256 for the client path; raw-evidence store.ts
// parseArtifact + canonical.ts for the server path), not by the code under
// test. A failing vector therefore means a persisted digest would move.
// Never regenerate the fixture from the current code to make a test pass:
// a normalization change needs descriptor-v2 (docs/evidence-contract.md).
import { describe, expect, test } from "bun:test";
import {
  ContractError,
  canonicalJsonV1,
  descriptorContractV1,
  descriptorDigestV1,
  descriptorSha256V1,
  encodeDescriptorV1,
  normalizeDescriptorV1,
  parseArtifactRequest,
  type ArtifactRequest,
  type JsonValue,
} from "../src/index";

interface VectorResult {
  normalized: unknown;
  canonical: string;
  sha256: string;
}
interface VectorFailure {
  error: string;
}
interface Vector {
  name: string;
  description: string;
  runId: number;
  serverPostable: boolean;
  sameClientDigestAs?: string;
  sameServerDigestAs?: string;
  input: Record<string, unknown>;
  client: VectorResult | VectorFailure;
  server: VectorResult | VectorFailure;
}
interface Fixture {
  contractVersion: string;
  producedBy: string;
  object: { text: string; sha256: string; byteSize: number };
  vectors: Vector[];
}

const fixture = JSON.parse(
  await Bun.file(new URL("../fixtures/golden-vectors.json", import.meta.url)).text(),
) as Fixture;
const byName = new Map(fixture.vectors.map((vector) => [vector.name, vector]));

function isFailure(result: VectorResult | VectorFailure): result is VectorFailure {
  return "error" in result;
}

const REQUIRED_COVERAGE = [
  "canonical-storage-explicit",
  "canonical-storage-key-order-reversed",
  "client-fills-null-and-empty-defaults",
  "optional-scalar-null",
  "optional-scalar-omitted",
  "container-kind-omitted",
  "media-type-uppercase",
  "storage-optional-values-present",
  "storage-optional-values-omitted",
  "storage-time-pair-mismatch",
  "storage-unknown-key",
  "unknown-top-level-field",
  "unicode-nfc",
  "unicode-nfd-not-normalized",
  "integer-max-safe",
  "integer-2-pow-53-rejected",
  "float-rejected",
  "negative-integer",
  "storage-origin-not-object",
  "http-origin-canonical",
  "http-origin-unsorted-query-names",
  "file-origin",
  "file-origin-source-modified-omitted",
  "email-origin-direct",
  "email-origin-forwarded-minimal",
  "ranges-canonical",
  "ranges-reordered-boolean-inclusive",
  "transform-steps-canonical",
  "transform-steps-reversed",
  "relations-explicit-parent-run",
  "relations-parent-run-defaulted",
  "unit-and-page-references",
  "page-index-without-group",
];

describe("descriptor-v1 golden vectors", () => {
  test("fixture identifies the contract version and its pre-refactor origin", () => {
    expect(fixture.contractVersion).toBe(descriptorContractV1.contractVersion);
    expect(fixture.producedBy).toContain("130912af");
    expect(fixture.vectors.map((vector) => vector.name)).toEqual(
      expect.arrayContaining(REQUIRED_COVERAGE),
    );
    expect(new Set(fixture.vectors.map((vector) => vector.name)).size).toBe(fixture.vectors.length);
  });

  test("the fixture object is the bytes every vector references", async () => {
    const bytes = new TextEncoder().encode(fixture.object.text);
    expect(bytes.byteLength).toBe(fixture.object.byteSize);
    expect(await descriptorDigestV1(bytes)).toBe(fixture.object.sha256);
  });

  for (const vector of fixture.vectors) {
    describe(vector.name, () => {
      test("client normalize → encode → digest matches the pre-refactor bytes", async () => {
        const input = structuredClone(vector.input) as unknown as ArtifactRequest;
        if (isFailure(vector.client)) {
          await expect(descriptorSha256V1(input)).rejects.toThrow(
            new TypeError(vector.client.error),
          );
          return;
        }
        const normalized = normalizeDescriptorV1(input);
        expect(JSON.parse(canonicalJsonV1(normalized as unknown as JsonValue))).toEqual(
          vector.client.normalized,
        );
        const bytes = encodeDescriptorV1(normalized);
        expect([...bytes]).toEqual([...new TextEncoder().encode(vector.client.canonical)]);
        expect(await descriptorDigestV1(bytes)).toBe(vector.client.sha256);
        expect(await descriptorSha256V1(input)).toBe(vector.client.sha256);
        const contractBytes = descriptorContractV1.encode(descriptorContractV1.normalize(input));
        expect(await descriptorContractV1.digest(contractBytes)).toBe(vector.client.sha256);
      });

      test("server parse → normalize → encode → digest matches the pre-refactor bytes", async () => {
        const input = structuredClone(vector.input);
        if (isFailure(vector.server)) {
          expect(() => parseArtifactRequest(input, { runId: vector.runId })).toThrow(
            new ContractError(vector.server.error),
          );
          return;
        }
        const validated = descriptorContractV1.parseRequest(input, { runId: vector.runId });
        const normalized = descriptorContractV1.normalize(validated);
        expect(JSON.parse(canonicalJsonV1(normalized as unknown as JsonValue))).toEqual(
          vector.server.normalized,
        );
        const bytes = descriptorContractV1.encode(normalized);
        expect(new TextDecoder().decode(bytes)).toBe(vector.server.canonical);
        expect(await descriptorContractV1.digest(bytes)).toBe(vector.server.sha256);
      });

      test("recorded digest equivalences hold", () => {
        if (vector.sameClientDigestAs) {
          const other = byName.get(vector.sameClientDigestAs)!;
          expect(isFailure(vector.client) || isFailure(other.client)).toBe(false);
          expect((vector.client as VectorResult).sha256).toBe(
            (other.client as VectorResult).sha256,
          );
        }
        if (vector.sameServerDigestAs) {
          const other = byName.get(vector.sameServerDigestAs)!;
          expect(isFailure(vector.server) || isFailure(other.server)).toBe(false);
          expect((vector.server as VectorResult).sha256).toBe(
            (other.server as VectorResult).sha256,
          );
        }
      });
    });
  }

  test("a request already in server-canonical form hashes identically on both sides", () => {
    for (const vector of fixture.vectors) {
      if (isFailure(vector.client) || isFailure(vector.server)) continue;
      const roundTrip = parseArtifactRequest(structuredClone(vector.input), {
        runId: vector.runId,
      });
      const canonicalInput =
        canonicalJsonV1(normalizeDescriptorV1(roundTrip) as unknown as JsonValue) ===
        canonicalJsonV1(
          normalizeDescriptorV1(vector.input as unknown as ArtifactRequest) as unknown as JsonValue,
        );
      expect(canonicalInput).toBe(vector.client.sha256 === vector.server.sha256);
    }
  });

  test("Unicode is hashed as raw UTF-8 without normalization", () => {
    const nfc = byName.get("unicode-nfc")!.client as VectorResult;
    const nfd = byName.get("unicode-nfd-not-normalized")!.client as VectorResult;
    expect(nfc.canonical).toContain("café");
    expect(nfd.canonical).toContain("café");
    expect(nfc.canonical).not.toContain("\\u");
    expect(nfc.sha256).not.toBe(nfd.sha256);
    expect(nfc.canonical.normalize("NFC")).toBe(nfd.canonical.normalize("NFC"));
  });

  test("array order is preserved by the client and canonicalized only by the server", () => {
    const ordered = byName.get("transform-steps-canonical")!;
    const reversed = byName.get("transform-steps-reversed")!;
    expect((ordered.client as VectorResult).sha256).not.toBe(
      (reversed.client as VectorResult).sha256,
    );
    expect((ordered.server as VectorResult).sha256).toBe((reversed.server as VectorResult).sha256);
  });

  test("unknown keys are rejected by the request parser, not silently hashed", () => {
    for (const name of ["unknown-top-level-field", "storage-unknown-key"]) {
      const vector = byName.get(name)!;
      expect(() => parseArtifactRequest(structuredClone(vector.input), { runId: 1 })).toThrow(
        new ContractError("unknown_field"),
      );
    }
  });
});
