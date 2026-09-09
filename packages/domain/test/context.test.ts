import { describe, expect, test } from "bun:test";
import {
  CanonicalFormError,
  canonicalDigest,
  canonicalJson,
  changedContextInputs,
  contextInputsDigest,
  sha256Hex,
  validFinancialContext,
  validInterpretationContext,
  validTransformManifest,
  type FinancialContext,
  type InterpretationContext,
  type TransformManifest,
} from "../src/context.ts";

const context: FinancialContext = {
  contextId: "ctx:1",
  schemaVersion: "financial-context-v1",
  querySemanticsVersion: "query-semantics-v1",
  perimeterRef: "perimeter:self",
  effectiveTime: { kind: "local-date", value: "2026-08-31", zone: "Asia/Tokyo", basis: "derived" },
  knowledgeCutoff: "2026-08-31T23:59:59+09:00",
  publicationRef: "publication:42",
  sourceSelectionManifestRef: "manifest:sources:a1",
  parserBuildManifestRef: "manifest:parsers:b2",
  metadataBuildManifestRef: "manifest:metadata:c3",
  identityDecisionManifestRef: "manifest:identity:d4",
  eventDecisionManifestRef: "manifest:events:e5",
  referenceManifestRef: "manifest:reference:f6",
  calculationPolicyRef: "policy:calc:v1",
  evaluationClock: "2026-09-08T10:00:00+09:00",
};

describe("canonical JSON", () => {
  test("sorts keys recursively, keeps array order, and is byte-stable", () => {
    expect(canonicalJson({ b: [3, { z: 1, a: null }], a: "x", c: true })).toBe(
      '{"a":"x","b":[3,{"a":null,"z":1}],"c":true}',
    );
    expect(canonicalJson({ a: -0 })).toBe('{"a":0}');
    expect(canonicalJson("日本語 ")).toBe(JSON.stringify("日本語 "));
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  test("rejects anything without an exact canonical form", () => {
    const error = (value: unknown) => {
      try {
        canonicalJson(value);
      } catch (thrown) {
        return thrown instanceof CanonicalFormError ? thrown.code : "not-canonical-error";
      }
      return "no-error";
    };
    expect(error({ a: 0.5 })).toBe("unsafe_number");
    expect(error({ a: Number.NaN })).toBe("unsafe_number");
    expect(error({ a: Number.POSITIVE_INFINITY })).toBe("unsafe_number");
    expect(error({ a: 2 ** 53 })).toBe("unsafe_number");
    expect(error({ a: 10n })).toBe("unsupported_type");
    expect(error({ a: undefined })).toBe("undefined_value");
    expect(error([undefined])).toBe("undefined_value");
    expect(error({ a: () => 1 })).toBe("unsupported_type");
    expect(error({ a: new Date(0) })).toBe("unsupported_type");
    expect(error(new Map())).toBe("unsupported_type");
    let deep: unknown = 1;
    for (let i = 0; i < 70; i += 1) deep = [deep];
    expect(error(deep)).toBe("depth_exceeded");
  });

  test("sha256 matches known vectors and digests are stable", async () => {
    expect(await sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(await sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await canonicalDigest({ b: 1, a: 2 })).toBe(await canonicalDigest({ a: 2, b: 1 }));
    expect(await canonicalDigest({ a: 2, b: 1 })).toBe(await sha256Hex('{"a":2,"b":1}'));
  });
});

describe("FinancialContext", () => {
  test("validates the fixed field set and rejects unknown keys or loose times", () => {
    expect(validFinancialContext(context)).toBe(true);
    expect(validFinancialContext({ ...context, extra: 1 })).toBe(false);
    expect(validFinancialContext({ ...context, knowledgeCutoff: "2026-08-31" })).toBe(false);
    expect(validFinancialContext({ ...context, schemaVersion: "financial-context-v2" })).toBe(
      false,
    );
    const { calculationPolicyRef: _dropped, ...missing } = context;
    expect(validFinancialContext(missing)).toBe(false);
  });

  test("any changed input is reported and changes the digest (INV09)", async () => {
    const changed: FinancialContext = {
      ...context,
      contextId: "ctx:2",
      calculationPolicyRef: "policy:calc:v2",
    };
    expect(changedContextInputs(context, changed)).toEqual(["calculationPolicyRef"]);
    expect(changedContextInputs(context, { ...context, contextId: "ctx:9" })).toEqual([]);
    expect(await contextInputsDigest(context)).toBe(
      await contextInputsDigest({ ...context, contextId: "ctx:9" }),
    );
    expect(await contextInputsDigest(context)).not.toBe(await contextInputsDigest(changed));
  });

  test("transform manifests and interpretation contexts are closed shapes", () => {
    const manifest: TransformManifest = {
      transformerId: "parser:sbi-foreign-cash-balances",
      semanticVersion: "0.3.0",
      codeDigest: "sha256:abc",
      inputContractVersion: "artifact-meta-v1",
      outputContractVersion: "observation-v1",
      metadataExtractorRelease: "legacy-metadata-v1",
      dependencyDigests: { "shared/normalized-decimal.ts": "sha256:def" },
    };
    expect(validTransformManifest(manifest)).toBe(true);
    expect(validTransformManifest({ ...manifest, commitSha: "x" })).toBe(false);
    expect(validTransformManifest({ ...manifest, dependencyDigests: { a: 1 } })).toBe(false);
    const interpretation: InterpretationContext = {
      mode: "latest",
      snapshotId: null,
      identityRelease: "identity-policy-2",
      productCatalogueRelease: "2026-09-08.2",
      productResolverRelease: "own-row-v3",
      measurePolicyRelease: "financial-measures-v2",
      decimalPolicyRelease: "decimal-v1",
    };
    expect(validInterpretationContext(interpretation)).toBe(true);
    expect(validInterpretationContext({ ...interpretation, mode: "snapshot" })).toBe(false);
    expect(
      validInterpretationContext({ ...interpretation, mode: "snapshot", snapshotId: "snap:1" }),
    ).toBe(true);
    expect(validInterpretationContext({ ...interpretation, snapshotId: "snap:1" })).toBe(false);
    expect(validInterpretationContext({ ...interpretation, mode: "current" })).toBe(false);
  });
});
