import { describe, expect, spyOn, test } from "bun:test";
import {
  artifactDataset,
  artifactRequest,
  hasProviderArtifact,
} from "../../../packages/application/src/collection/descriptors";
import { FakeR2Bucket } from "../../../packages/collection/test/fake-bucket";
import {
  encodeTerminal,
  objectKey,
  persistRun,
  planManifest,
  sha256Hex,
  terminalDigest,
  terminalKey,
} from "../../../packages/collection/src";
import {
  buildHistoryEvidencePlan,
  persistHistoryEvidence,
  readHistoryEvidence,
  type HistoryEvidenceInput,
} from "../src/local/history-evidence";

const scope = { accountNo: "111111111111111", fromDate: "20300101", toDate: "20300131" };
const row = {
  txnReferenceNo: "synthetic-a",
  description: "Synthetic 日本語 😀",
  credit: "",
  debit: "12.50",
  postingDate: "2030/01/02",
  balance: "80.00",
  tradeTypeCode: "synthetic-code",
};
const wrapper = (responseParam: unknown, statusID = "00000") => ({
  requestParam: { nationalid: "synthetic-owner" },
  responseParam,
  header: {
    referenceNo: "synthetic-ref",
    systemCode: "synthetic-system",
    langCode: "synthetic-lang",
  },
  errorInfo: { statusID, statusMessage: "synthetic-message" },
});
function input(empty = false): HistoryEvidenceInput {
  const activity = empty
    ? wrapper(
        {
          type: "",
          fromDate: "",
          toDate: "",
          purgeflag: "",
          currentBalance: "",
          accountNo: "",
          currency: "",
          activityDetails: [],
        },
        "30224",
      )
    : wrapper({
        type: "1",
        fromDate: "2030/01/01",
        toDate: "2030/01/31",
        purgeflag: "Y",
        currentBalance: "80.00",
        accountNo: scope.accountNo,
        currency: "JPY",
        activityDetails: [row],
      });
  const responseParam = empty
    ? { activity, sysTimeForCsvDownload: "synthetic-time" }
    : {
        activity,
        memoInquiry: wrapper({
          memoInquiryDetails: [{ txnReferenceNo: row.txnReferenceNo, memo: "" }],
        }),
        summaryColumnTransformation: wrapper({
          descriptionTransformDetails: [
            { txnReferenceNo: row.txnReferenceNo, descriptionTransform: row.description },
          ],
        }),
        sysTimeForCsvDownload: "synthetic-time",
      };
  return {
    runId: "00000000-0000-4000-8000-000000000001",
    startedAt: "2030-01-31T01:00:00Z",
    completedAt: "2030-01-31T01:01:00Z",
    requestContext: { ...scope },
    response: {
      status: 200,
      mediaType: "application/json",
      body: ` \n${JSON.stringify({ requestParam: { accountActivityDetails: [] }, header: { adapterResultCode: "0" }, responseParam }, null, 2)}\n`,
    },
  };
}
function withBody(body: string): HistoryEvidenceInput {
  return { ...input(), response: { ...input().response, body } };
}
const key = (runId = input().runId) => terminalKey("sbi-shinsei", runId);
async function saved(bucket: FakeR2Bucket, value = input()) {
  const result = await persistHistoryEvidence(bucket, value);
  if (result.outcome !== "persisted") throw new Error("synthetic-test-persist-failed");
  return result;
}

describe("offline decoded history evidence", () => {
  test("preserves decoded UTF-8 exactly, classifies as derived with no fabricated parent or coverage", async () => {
    const value = input();
    const plan = await buildHistoryEvidencePlan(value);
    const manifest = planManifest(plan);
    expect(manifest.providerOutcome).toBe("partial");
    expect(manifest.coverageStatus).toBe("unknown");
    expect(manifest.safeErrorCode).toBe("history_capture_origin_unverified");
    expect(manifest.artifacts.map((artifact) => artifact.role).sort()).toEqual([
      "collector_derived",
      "collector_manifest",
    ]);
    expect(manifest.units).toEqual([
      { unitKey: "yen-period", unitKind: "account", artifactCount: 1, coverageStatus: "unknown" },
    ]);
    expect(
      manifest.ranges.every(
        (range) => range.rangeKind === "requested" && range.basis === "request",
      ),
    ).toBe(true);
    expect(
      manifest.transformations.every((transform) => transform.inputArtifactKeys.length === 0),
    ).toBe(true);
    expect(JSON.stringify(manifest)).not.toContain(scope.accountNo);
    const body = plan.artifacts.find(
      (artifact) => artifact.artifactKey === "history-decoded.json",
    )!;
    if (body.body.kind !== "bytes") throw new Error("synthetic-test-kind");
    expect(body.body.bytes).toEqual(new TextEncoder().encode(value.response.body));
    expect(body.sha256).toBe(await sha256Hex(new TextEncoder().encode(value.response.body)));
    expect(
      manifest.transformations.find((transform) => transform.outputArtifactKey === body.artifactKey)
        ?.stepKind,
    ).toBe("reencoded");
    expect(hasProviderArtifact(manifest)).toBe(false);
    for (const artifact of manifest.artifacts) {
      expect(artifactDataset(manifest.source, artifact)).toBeNull();
      const request = artifactRequest(manifest, artifact, new Map([["yen-period", 1]]));
      expect(request.dataset).toBeUndefined();
      expect(request.relations).toBeUndefined();
      if (artifact.artifactKey === "history-decoded.json")
        expect(request).toMatchObject({
          payloadFidelity: "transformed",
          lineageDisposition: "source_bytes_not_available",
        });
    }
  });

  test("writes terminal last, verifies both objects, and performs no provider network call", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("synthetic-network-forbidden"),
    );
    try {
      const bucket = new FakeR2Bucket();
      const get = spyOn(bucket, "get");
      const result = await saved(bucket);
      expect(bucket.putKeys.at(-1)).toBe(key());
      expect(bucket.putKeys).toHaveLength(3);
      expect(get.mock.calls.filter(([name]) => name.startsWith("objects/"))).toHaveLength(2);
      expect(result.readback.outcome).toBe("verified");
      if (result.readback.outcome === "verified")
        expect(result.readback.summary).toMatchObject({
          rowCount: 1,
          periodEchoVerified: true,
          captureVerified: false,
          providerOriginVerified: false,
          registrationReady: false,
          coverageStatus: "unknown",
        });
      expect(JSON.stringify(result)).not.toContain(scope.accountNo);
      expect(JSON.stringify(result)).not.toContain(row.description);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("empty provider status retains private request context but does not prove coverage or echo", async () => {
    const result = await saved(new FakeR2Bucket(), input(true));
    expect(result.readback).toMatchObject({
      outcome: "verified",
      summary: {
        inspectionOutcome: "provider_reported_empty",
        rowCount: 0,
        periodEchoVerified: false,
        coverageStatus: "unknown",
      },
    });
  });

  test("snapshots every input primitive before awaiting a digest", async () => {
    const value = structuredClone(input()) as {
      -readonly [K in keyof HistoryEvidenceInput]: HistoryEvidenceInput[K];
    };
    const expected = await buildHistoryEvidencePlan(value);
    const promise = buildHistoryEvidencePlan(value);
    value.runId = "00000000-0000-4000-8000-000000000099";
    value.startedAt = "synthetic-mutated";
    Object.assign(value.requestContext, { accountNo: "999999999999999" });
    Object.assign(value.response, { body: "synthetic-secret", status: 500 });
    expect(await terminalDigest(planManifest(await promise))).toBe(
      await terminalDigest(planManifest(expected)),
    );
  });

  test.each([
    (value: HistoryEvidenceInput) => ({ ...value, token: "synthetic-secret" }),
    (value: HistoryEvidenceInput) => ({
      ...value,
      requestContext: { ...value.requestContext, token: "synthetic-secret" },
    }),
    (value: HistoryEvidenceInput) => ({
      ...value,
      response: { ...value.response, headers: { authorization: "synthetic-secret" } },
    }),
    (value: HistoryEvidenceInput) => ({ ...value, runId: "synthetic-secret" }),
    (value: HistoryEvidenceInput) => ({ ...value, startedAt: "2030-02-30T01:00:00Z" }),
    (value: HistoryEvidenceInput) => ({ ...value, response: { ...value.response, status: "200" } }),
    (value: HistoryEvidenceInput) => ({ ...value, response: { ...value.response, status: 401 } }),
    (value: HistoryEvidenceInput) => ({
      ...value,
      response: { ...value.response, mediaType: "text/html" },
    }),
    (value: HistoryEvidenceInput) => ({ ...value, [Symbol("synthetic-secret")]: true }),
    (value: HistoryEvidenceInput) =>
      Object.defineProperty({ ...value }, "runId", {
        get() {
          throw new Error("synthetic-secret");
        },
      }),
  ])("rejects unsupported metadata without any writes or leaked exceptions", async (change) => {
    const bucket = new FakeR2Bucket();
    expect(await persistHistoryEvidence(bucket, change(input()) as HistoryEvidenceInput)).toEqual({
      outcome: "refused",
      reasonCode: "history_evidence_refused",
    });
    expect(bucket.entries.size).toBe(0);
  });

  test.each([
    "not json synthetic-secret",
    '{"a":1,"a":2}',
    input().response.body.replace(
      '"adapterResultCode": "0"',
      '"adapterResultCode":"synthetic-secret","adapterResultCode":"0"',
    ),
    input().response.body.replace(
      '"adapterResultCode": "0"',
      '"adapterResultCode":"synthetic-secret","adapterResult\\u0043ode":"0"',
    ),
    input().response.body.replace(
      '"header": {',
      '"header":{"newToken":"synthetic-secret"},"header":{',
    ),
    input().response.body.replace(
      '"statusMessage": "synthetic-message"',
      '"statusMessage":"synthetic-secret","statusMessage":"synthetic-message"',
    ),
    input().response.body.replace(
      '"adapterResultCode": "0"',
      '"adapterResultCode":"0","newToken":"synthetic-secret"',
    ),
    input().response.body.replace("synthetic-message", "\ud800"),
    input().response.body.replace("synthetic-message", "\\ud800"),
    input().response.body.replace("synthetic-message", "\\udc00"),
    "[".repeat(65) + "0" + "]".repeat(65),
    " ".repeat(2 * 1024 * 1024 + 1),
  ])("refuses lossy, duplicate, secret-bearing or over-budget JSON before writes", async (body) => {
    const bucket = new FakeR2Bucket();
    expect(await persistHistoryEvidence(bucket, withBody(body))).toEqual({
      outcome: "refused",
      reasonCode: "history_evidence_refused",
    });
    expect(bucket.entries.size).toBe(0);
  });

  test("scanner accepts escaped syntax, scalars and supplementary Unicode in strings", async () => {
    const body = input().response.body.replaceAll(
      "synthetic-message",
      'escaped \\" quote \\\\ slash { [ , : ] } \\ud83d\\ude00',
    );
    const result = await saved(new FakeR2Bucket(), withBody(body));
    expect(result.readback.outcome).toBe("verified");
  });

  test("resends verify actual bytes again, including corruption hidden by matching checksum metadata", async () => {
    const bucket = new FakeR2Bucket();
    const first = await saved(bucket);
    const get = spyOn(bucket, "get");
    const second = await persistHistoryEvidence(bucket, input());
    expect(second.outcome).toBe("already_persisted");
    expect(get.mock.calls.filter(([name]) => name.startsWith("objects/"))).toHaveLength(2);
    const plan = await buildHistoryEvidencePlan(input());
    const object = bucket.entries.get(objectKey(plan.artifacts[0]!.sha256))!;
    object.bytes[0] = 33;
    const third = await persistHistoryEvidence(bucket, input());
    expect(third).toMatchObject({
      outcome: "already_persisted",
      terminalDigest: first.terminalDigest,
      readback: { outcome: "refused" },
    });
    expect(bucket.putKeys).toHaveLength(3);
  });

  test("different bytes at the same run are a conflict and never overwrite", async () => {
    const bucket = new FakeR2Bucket();
    await saved(bucket);
    const before = structuredClone([...bucket.entries]);
    expect(await persistHistoryEvidence(bucket, withBody(`${input().response.body} `))).toEqual({
      outcome: "conflict",
      reasonCode: "history_evidence_conflict",
    });
    expect([...bucket.entries]).toEqual(before);
    expect(bucket.putKeys).toHaveLength(3);
  });

  test.each([0, 1, 2])(
    "write failure at position %i preserves earlier bytes and resumes from evidence",
    async (position) => {
      const plan = await buildHistoryEvidencePlan(input());
      // Writer order follows the sorted manifest inventory; terminal is last.
      const keys = [
        ...planManifest(plan).artifacts.map((artifact) => objectKey(artifact.sha256)),
        key(),
      ];
      const bucket = new FakeR2Bucket({ failPut: new Set([keys[position]!]) });
      expect(await persistHistoryEvidence(bucket, input())).toMatchObject({
        outcome: "incomplete",
      });
      expect(bucket.entries.has(key())).toBe(false);
      expect(bucket.entries.size).toBe(position);
      const earlier = [...bucket.entries].map(([name, entry]) => [name, entry.bytes] as const);
      bucket.faults = {};
      expect((await saved(bucket)).readback.outcome).toBe("verified");
      for (const [name, bytes] of earlier) expect(bucket.entries.get(name)?.bytes).toEqual(bytes);
      expect(bucket.putKeys.at(-1)).toBe(key());
    },
  );

  test.each(["missing", "size", "hash", "context"])(
    "readback refuses %s damage with closed diagnostics",
    async (damage) => {
      const bucket = new FakeR2Bucket();
      const receipt = await saved(bucket);
      const plan = await buildHistoryEvidencePlan(input());
      const index = damage === "context" ? 1 : 0;
      const name = objectKey(plan.artifacts[index]!.sha256);
      if (damage === "missing") bucket.entries.delete(name);
      else if (damage === "size") bucket.entries.get(name)!.bytes = new Uint8Array();
      else bucket.entries.get(name)!.bytes[0] = 255;
      expect(
        await readHistoryEvidence(bucket, {
          runId: receipt.runId,
          terminalDigest: receipt.terminalDigest,
        }),
      ).toEqual({ outcome: "refused", reasonCode: "history_evidence_readback_refused" });
    },
  );

  test.each(["role", "producer", "range", "identity", "transform", "inventory"])(
    "rebuilt manifest refuses internally valid %s tampering even with a matching receipt",
    async (field) => {
      const bucket = new FakeR2Bucket();
      const plan = await buildHistoryEvidencePlan(input());
      const manifest = structuredClone(planManifest(plan));
      if (field === "role") Object.assign(manifest.artifacts[0]!, { role: "provider_original" });
      if (field === "producer") Object.assign(manifest, { producer: "synthetic-other" });
      if (field === "range") Object.assign(manifest.ranges[0]!, { basis: "source" });
      if (field === "identity") Object.assign(manifest, { attemptId: "synthetic-other" });
      if (field === "transform")
        Object.assign(manifest.transformations[0]!, { transformerVersion: "synthetic-other" });
      if (field === "inventory") Object.assign(manifest.artifacts[0]!, { mediaType: "text/plain" });
      await persistRun(bucket, plan);
      await bucket.seed(key(), encodeTerminal(manifest));
      expect(
        await readHistoryEvidence(bucket, {
          runId: input().runId,
          terminalDigest: await terminalDigest(manifest),
        }),
      ).toMatchObject({ outcome: "refused" });
    },
  );

  test.each(["summary", "extra", "invalid-utf8", "scope"])(
    "rejects self-consistent object hashes with invalid %s context",
    async (damage) => {
      const bucket = new FakeR2Bucket();
      const plan = await buildHistoryEvidencePlan(input());
      const contextArtifact = plan.artifacts.find(
        (artifact) => artifact.artifactKey === "history-context.json",
      )!;
      if (contextArtifact.body.kind !== "bytes") throw new Error("synthetic-test-kind");
      const context = JSON.parse(new TextDecoder().decode(contextArtifact.body.bytes));
      if (damage === "summary") context.inspection.rowCount = 99;
      if (damage === "extra") context.token = "synthetic-secret";
      if (damage === "scope") context.requestContext.accountNo = "999999999999999";
      const bytes =
        damage === "invalid-utf8"
          ? new Uint8Array([255])
          : new TextEncoder().encode(JSON.stringify(context));
      const altered = {
        ...contextArtifact,
        sha256: await sha256Hex(bytes),
        byteSize: bytes.byteLength,
        body: { kind: "bytes" as const, bytes },
      };
      const alteredPlan = {
        ...plan,
        artifacts: plan.artifacts.map((artifact) =>
          artifact === contextArtifact ? altered : artifact,
        ),
      };
      await persistRun(bucket, alteredPlan);
      expect(
        await readHistoryEvidence(bucket, {
          runId: input().runId,
          terminalDigest: await terminalDigest(planManifest(alteredPlan)),
        }),
      ).toMatchObject({ outcome: "refused" });
    },
  );

  test("invalid receipt and unexpected storage failures disclose no provider data", async () => {
    const bucket = new FakeR2Bucket();
    expect(
      await readHistoryEvidence(bucket, {
        runId: "synthetic-secret",
        terminalDigest: "synthetic-secret",
      }),
    ).toMatchObject({ outcome: "refused" });
    spyOn(bucket, "get").mockRejectedValue(new Error("synthetic-secret"));
    spyOn(bucket, "head").mockRejectedValue(new Error("synthetic-secret"));
    expect(await persistHistoryEvidence(bucket, input())).toEqual({
      outcome: "unknown",
      reasonCode: "history_evidence_persist_failed",
    });
  });
});
