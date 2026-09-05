import { env, SELF } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../src/canonical";
import fixture from "./fixtures/source-usecases.v1.json";

const AUTH = "Bearer test.test-secret-at-least-twenty-chars";
const PRODUCER = "collector-r2-importer";
const STORAGE_TEMPLATE = "runs/{redacted}/artifact";
const FINGERPRINT_VERSION = "fixture-hmac-v1";
const SBI_STORAGE_TEMPLATE = "raw/sbi-securities/{date}/{run-id}/{artifact}.json";
const MOBILE_SUICA_STORAGE_TEMPLATE = "raw/mobile-suica/{date}/{run-id}/{artifact}";
const SBI_FINGERPRINT_VERSION = "collector-r2-v1";
const cases = fixture.cases;

interface InventoryItem {
  artifactKey: string;
  sha256: string;
  descriptorSha256: string;
}

async function post(path: string, body: unknown): Promise<Response> {
  return SELF.fetch(`https://example.test${path}`, {
    method: "POST",
    headers: { authorization: AUTH, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function expectPost(path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await post(path, body);
  expect(response.status, `${path}: ${await response.clone().text()}`).toBe(201);
  return response.json() as Promise<Record<string, unknown>>;
}

async function createRun(sourceId: string, externalSessionId: string, sourceRunKey = "default") {
  const value = await expectPost("/v1/runs", {
    producerId: PRODUCER,
    sourceId,
    externalIdNamespace: "sanitized-fixture",
    externalSessionId,
    sourceRunKey,
  });
  return { sessionId: Number(value.sessionId), runId: Number(value.runId) };
}

function bytes(value: string | Uint8Array): Uint8Array {
  return typeof value === "string" ? new TextEncoder().encode(value) : value;
}

async function upload(runId: number, value: string | Uint8Array) {
  const body = bytes(value);
  const sha256 = await sha256Hex(body);
  const response = await SELF.fetch(
    `https://example.test/v1/runs/${runId}/objects/${sha256}`,
    {
      method: "PUT",
      headers: {
        authorization: AUTH,
        "content-length": String(body.byteLength),
        "x-kogane-byte-size": String(body.byteLength),
      },
      body,
    },
  );
  expect([200, 201]).toContain(response.status);
  return { sha256, byteSize: body.byteLength };
}

async function storageOrigin(artifactKey: string) {
  return {
    storageKind: "r2",
    containerName: "sanitized-fixture-staging",
    objectKeyTemplate: STORAGE_TEMPLATE,
    objectKeyFingerprint: await sha256Hex(new TextEncoder().encode(`fixture:${artifactKey}`)),
    fingerprintKeyVersion: FINGERPRINT_VERSION,
    redactionVersion: "v1",
  };
}

async function sbiStorageOrigin(artifactKey: string) {
  return {
    storageKind: "r2",
    containerName: "kogane-sbi-collector-poc",
    objectKeyTemplate: SBI_STORAGE_TEMPLATE,
    objectKeyFingerprint: await sha256Hex(
      new TextEncoder().encode(`fixture-sbi:${artifactKey}`),
    ),
    fingerprintKeyVersion: SBI_FINGERPRINT_VERSION,
    redactionVersion: "v1",
  };
}

async function mobileSuicaStorageOrigin(artifactKey: string) {
  return {
    storageKind: "r2",
    containerName: "kogane-mobile-suica-collector-poc",
    objectKeyTemplate: MOBILE_SUICA_STORAGE_TEMPLATE,
    objectKeyFingerprint: await sha256Hex(
      new TextEncoder().encode(`fixture-mobile-suica:${artifactKey}`),
    ),
    fingerprintKeyVersion: SBI_FINGERPRINT_VERSION,
    redactionVersion: "v1",
  };
}

async function catalogue(
  runId: number,
  artifactKey: string,
  value: string | Uint8Array,
  fields: Record<string, unknown> = {},
): Promise<InventoryItem> {
  const object = await upload(runId, value);
  return catalogueUploaded(runId, artifactKey, object, fields);
}

async function catalogueUploaded(
  runId: number,
  artifactKey: string,
  object: { sha256: string; byteSize: number },
  fields: Record<string, unknown> = {},
): Promise<InventoryItem> {
  const response = await expectPost(`/v1/runs/${runId}/artifacts`, {
    artifactKey,
    artifactRole: "provider_response",
    payloadFidelity: "exact",
    containerKind: "single",
    lineageDisposition: "not_applicable",
    storage: await storageOrigin(artifactKey),
    ...fields,
    sha256: object.sha256,
    byteSize: object.byteSize,
  });
  return {
    artifactKey,
    sha256: object.sha256,
    descriptorSha256: String(response.descriptorSha256),
  };
}

async function terminal(runId: number, count: number, outcome = "success") {
  await expectPost(`/v1/runs/${runId}/reports`, {
    reportKey: "terminal",
    reportKind: "terminal",
    manifestSchemaVersion: "sanitized-fixture-v1",
    normalizedOutcome: outcome,
    declaredArtifactCount: count,
    artifactCountScope: "all_catalogued",
  });
}

async function seal(runId: number, artifacts: InventoryItem[], suffix: string) {
  const response = await expectPost(`/v1/runs/${runId}/seal`, {
    artifacts,
    declarationBasis: "producer_manifest",
    externalAttemptId: `fixture-${suffix}`,
  });
  expect(response.sealed).toBe(true);
}

async function unit(runId: number, unitKind: string, unitKey: string) {
  const response = await expectPost(`/v1/runs/${runId}/units`, {
    unitKind,
    unitKey,
    terminalReportRequired: true,
  });
  return Number(response.unitId);
}

async function unitTerminal(
  unitId: number,
  count: number,
  outcome: "success" | "partial" | "failed" = "success",
  safeFailureCode?: string,
) {
  await expectPost(`/v1/units/${unitId}/reports`, {
    reportKey: "terminal",
    reportKind: "terminal",
    normalizedOutcome: outcome,
    declaredArtifactCount: count,
    artifactCountScope: "direct",
    ...(safeFailureCode ? { safeFailureCode } : {}),
  });
}

beforeAll(async () => {
  const sourceIds = [...new Set(Object.values(cases).flatMap((entry) => {
    const value = entry as { sourceId: string; reconciliationSourceId?: string };
    return [value.sourceId, ...(value.reconciliationSourceId ? [value.reconciliationSourceId] : [])];
  }))];
  await env.DB.batch([
    env.DB.prepare("INSERT INTO ingest_clients (id, display_name) VALUES ('test', 'Sanitized fixture client')"),
    env.DB.prepare("INSERT INTO ingest_client_producers (ingest_client_id, producer_id) VALUES ('test', ?)")
      .bind(PRODUCER),
    ...sourceIds.map((sourceId) => env.DB.prepare(`
      INSERT INTO ingest_client_routes (ingest_client_id, producer_id, source_id)
      VALUES ('test', ?, ?)
    `).bind(PRODUCER, sourceId)),
    ...sourceIds.map((sourceId) => env.DB.prepare(`
      INSERT INTO origin_template_policies (
        source_id, origin_kind, template, redaction_version, fingerprint_key_version
      ) VALUES (?, 'storage', ?, 'v1', ?)
    `).bind(sourceId, STORAGE_TEMPLATE, FINGERPRINT_VERSION)),
    env.DB.prepare(`
      INSERT INTO origin_template_policies (
        source_id, origin_kind, template, redaction_version, fingerprint_key_version
      ) VALUES ('v-point-pay', 'email', '{redacted}.{extension}', 'v1', ?)
    `).bind(FINGERPRINT_VERSION),
  ]);
});

describe("sanitized source-usecase contract", () => {
  it("represents a Vpass multi-card bundle with complete per-card units", async () => {
    const value = cases.vpassMultiCard;
    const { runId } = await createRun(value.sourceId, value.sessionId);
    const artifacts: InventoryItem[] = [];
    for (const cardKey of value.cardKeys) {
      const unitId = await unit(runId, "card", cardKey);
      artifacts.push(await catalogue(runId, `${cardKey}/snapshot.json`, value.snapshotBody, {
        fetchUnitId: unitId,
        artifactRole: "collector_derived",
        payloadFidelity: "transformed",
        containerKind: "bundle",
        lineageDisposition: "embedded_source_bytes",
        dataset: "statement-snapshot",
        formatId: "vpass-snapshot-json",
        declaredMediaType: "application/json",
        mediaTypeBasis: "manifest",
        transformSteps: [{
          stepIndex: 0,
          stepKind: "bundled",
          transformerId: "vpass-bundler",
          transformerVersion: "fixture-v1",
        }, {
          stepIndex: 1,
          stepKind: "reencoded",
          transformerId: "vpass-bundler",
          transformerVersion: "fixture-v1",
        }],
      }));
      artifacts.push(await catalogue(runId, `${cardKey}/manifest.json`, value.manifestBody, {
        fetchUnitId: unitId,
        artifactRole: "collector_manifest",
        payloadFidelity: "generated",
        dataset: "collector-manifest",
        declaredMediaType: "application/json",
        mediaTypeBasis: "manifest",
      }));
      await unitTerminal(unitId, 2);
    }
    await terminal(runId, artifacts.length);
    await seal(runId, artifacts, "vpass");
  });

  it("seals SBI Securities partial evidence without losing a failed scope", async () => {
    const value = cases.sbiSecuritiesPartial;
    const { runId } = await createRun(value.sourceId, value.sessionId);
    const domestic = await unit(runId, "scope", "domestic");
    const foreign = await unit(runId, "scope", "foreign");
    const successBytes = new TextEncoder().encode(value.successBody);
    const successSha256 = await sha256Hex(successBytes);
    const manifestBody = JSON.stringify({
      schemaVersion: "sbi-worker-poc-v1",
      source: "sbi-securities",
      runId: value.sessionId,
      scope: "all",
      startedAt: value.startedAt,
      completedAt: value.completedAt,
      status: "partial",
      artifacts: [{
        dataset: "domestic-trade-records",
        key: `raw/sbi-securities/2026/08/27/${value.sessionId}/domestic-trade-records.json`,
        sha256: successSha256,
        bytes: successBytes.byteLength,
        window: value.window,
      }],
      failures: [value.failure],
    });
    const artifacts = [
      await catalogue(runId, "domestic-trade-records.json", value.successBody, {
        fetchUnitId: domestic,
        artifactRole: "collector_derived",
        payloadFidelity: "transformed",
        lineageDisposition: "source_bytes_not_available",
        dataset: "domestic-trade-records",
        formatId: "sbi-domestic-trade-records-json",
        formatVersion: "sbi-worker-poc-v1",
        declaredMediaType: "application/json",
        mediaTypeBasis: "operator",
        storage: await sbiStorageOrigin("domestic-trade-records.json"),
        ranges: [{
          rangeKey: "requested-window",
          rangeKind: "requested",
          precision: "date",
          startValue: value.window.from,
          endValue: value.window.to,
          startInclusive: true,
          endInclusive: true,
          basis: "manifest",
        }],
        transformSteps: [
          {
            stepIndex: 0,
            stepKind: "transport_decoded",
            transformerId: "sbi-securities-worker",
            transformerVersion: "sbi-worker-poc-v1",
          },
          {
            stepIndex: 1,
            stepKind: "extracted",
            transformerId: "sbi-securities-worker",
            transformerVersion: "sbi-worker-poc-v1",
          },
          {
            stepIndex: 2,
            stepKind: "reencoded",
            transformerId: "sbi-securities-worker",
            transformerVersion: "sbi-worker-poc-v1",
          },
        ],
      }),
      await catalogue(runId, "manifest.json", manifestBody, {
        artifactRole: "collector_manifest",
        payloadFidelity: "generated",
        dataset: "collector-manifest",
        formatId: "sbi-collector-manifest-json",
        formatVersion: "sbi-worker-poc-v1",
        declaredMediaType: "application/json",
        mediaTypeBasis: "operator",
        storage: await sbiStorageOrigin("manifest.json"),
      }),
    ];
    await unitTerminal(domestic, 1);
    await unitTerminal(foreign, 0, "failed", "passkey-graphql-failed");
    await terminal(runId, artifacts.length, "partial");
    await seal(runId, artifacts, "sbi-securities-partial");

    const stored = await env.DB.prepare(`
      SELECT artifact_key, artifact_role, payload_fidelity, lineage_disposition
      FROM fetch_artifacts WHERE fetch_run_id = ? ORDER BY artifact_key
    `).bind(runId).all<{
      artifact_key: string;
      artifact_role: string;
      payload_fidelity: string;
      lineage_disposition: string;
    }>();
    expect(stored.results).toEqual([
      {
        artifact_key: "domestic-trade-records.json",
        artifact_role: "collector_derived",
        payload_fidelity: "transformed",
        lineage_disposition: "source_bytes_not_available",
      },
      {
        artifact_key: "manifest.json",
        artifact_role: "collector_manifest",
        payload_fidelity: "generated",
        lineage_disposition: "not_applicable",
      },
    ]);
  });

  it("seals a complete SBI Securities eight-artifact inventory", async () => {
    const sessionId = "fixture-sbi-securities-complete";
    const { runId } = await createRun("sbi-securities", sessionId, "all");
    const domestic = await unit(runId, "scope", "domestic");
    const foreign = await unit(runId, "scope", "foreign");
    const datasets = [
      "domestic-cash-positions",
      "account-assets-current",
      "yen-detail-history",
      "domestic-trade-records",
      "foreign-cash-positions",
      "foreign-cash-balances",
      "foreign-trade-records",
    ];
    const artifacts: InventoryItem[] = [];
    for (const [sequence, dataset] of datasets.entries()) {
      artifacts.push(await catalogue(runId, `${dataset}.json`, `{"dataset":"${dataset}"}`, {
        fetchUnitId: dataset.startsWith("foreign-") ? foreign : domestic,
        artifactRole: "collector_derived",
        payloadFidelity: "transformed",
        lineageDisposition: "source_bytes_not_available",
        dataset,
        formatId: `sbi-${dataset}-json`,
        formatVersion: "sbi-worker-poc-v1",
        declaredMediaType: "application/json",
        mediaTypeBasis: "operator",
        sequence,
        storage: await sbiStorageOrigin(`${dataset}.json`),
        transformSteps: [
          { stepIndex: 0, stepKind: "transport_decoded", transformerId: "sbi-securities-worker", transformerVersion: "sbi-worker-poc-v1" },
          { stepIndex: 1, stepKind: "extracted", transformerId: "sbi-securities-worker", transformerVersion: "sbi-worker-poc-v1" },
          ...(dataset === "foreign-trade-records" ? [{ stepIndex: 2, stepKind: "bundled", transformerId: "sbi-securities-worker", transformerVersion: "sbi-worker-poc-v1" }] : []),
          { stepIndex: dataset === "foreign-trade-records" ? 3 : 2, stepKind: "reencoded", transformerId: "sbi-securities-worker", transformerVersion: "sbi-worker-poc-v1" },
        ],
      }));
    }
    artifacts.push(await catalogue(runId, "manifest.json", "{\"status\":\"success\"}", {
      artifactRole: "collector_manifest",
      payloadFidelity: "generated",
      dataset: "collector-manifest",
      formatId: "sbi-collector-manifest-json",
      formatVersion: "sbi-worker-poc-v1",
      declaredMediaType: "application/json",
      mediaTypeBasis: "operator",
      sequence: 7,
      storage: await sbiStorageOrigin("manifest.json"),
    }));
    await unitTerminal(domestic, 4);
    await unitTerminal(foreign, 3);
    await terminal(runId, artifacts.length);
    await seal(runId, artifacts, "sbi-securities-complete");
  });

  it("links an SBI Shinsei normalized artifact to its exact provider response", async () => {
    const value = cases.sbiShinseiLineage;
    const { runId } = await createRun(value.sourceId, value.sessionId);
    const raw = await catalogue(runId, "raw/history.json", value.rawBody, {
      dataset: "history-raw",
      declaredMediaType: "application/json",
      mediaTypeBasis: "manifest",
    });
    const normalized = await catalogue(runId, "normalized/history.json", value.normalizedBody, {
      artifactRole: "collector_derived",
      payloadFidelity: "transformed",
      lineageDisposition: "linked",
      dataset: "history-normalized",
      declaredMediaType: "application/json",
      mediaTypeBasis: "manifest",
      transformSteps: [{
        stepIndex: 0,
        stepKind: "extracted",
        transformerId: "sbi-shinsei-normalizer",
        transformerVersion: "fixture-v1",
      }],
      relations: [{
        parentArtifactKey: raw.artifactKey,
        relation: "input",
        transformerId: "sbi-shinsei-normalizer",
        transformerVersion: "fixture-v1",
      }],
    });
    await terminal(runId, 2);
    await seal(runId, [raw, normalized], "sbi-shinsei");
    expect(await env.DB.prepare("SELECT count(*) AS count FROM artifact_relations")
      .first<{ count: number }>()).toMatchObject({ count: 1 });
  });

  it("accepts a sanitized SBI Shinsei failure manifest as derived evidence", async () => {
    const { sourceId } = cases.sbiShinseiLineage;
    const { runId } = await createRun(
      sourceId,
      "synthetic-sbi-shinsei-sanitized-manifest",
      "sanitized-failure-manifest",
    );
    const artifact = await catalogue(
      runId,
      "manifest.json",
      JSON.stringify({
        schemaVersion: "sbi-shinsei-worker-poc-v1",
        status: "failed",
        failures: [{
          operation: "collect",
          errorType: "Error",
          message: "collector_request_failed",
        }],
      }),
      {
        artifactRole: "collector_derived",
        payloadFidelity: "transformed",
        lineageDisposition: "source_not_retained_for_security",
        dataset: "collector-manifest",
        formatId: "sbi-shinsei-collector-manifest-json",
        formatVersion: "sbi-shinsei-worker-poc-v1",
        declaredMediaType: "application/json",
        mediaTypeBasis: "operator",
        sequence: 0,
        transformSteps: [
          {
            stepIndex: 0,
            stepKind: "transport_decoded",
            transformerId: "sbi-shinsei-manifest-sanitizer",
            transformerVersion: "v1",
          },
          {
            stepIndex: 1,
            stepKind: "redacted",
            transformerId: "sbi-shinsei-manifest-sanitizer",
            transformerVersion: "v1",
          },
          {
            stepIndex: 2,
            stepKind: "reencoded",
            transformerId: "sbi-shinsei-manifest-sanitizer",
            transformerVersion: "v1",
          },
        ],
      },
    );
    await terminal(runId, 1, "failed");
    await seal(runId, [artifact], "sbi-shinsei-sanitized-failure-manifest");

    expect(await env.DB.prepare(`
      SELECT artifact_role, payload_fidelity, lineage_disposition
      FROM fetch_artifacts WHERE fetch_run_id = ? AND artifact_key = 'manifest.json'
    `).bind(runId).first()).toEqual({
      artifact_role: "collector_derived",
      payload_fidelity: "transformed",
      lineage_disposition: "source_not_retained_for_security",
    });
  });

  it("requires every declared SBI VC Trade page before sealing", async () => {
    const value = cases.sbiVcPagination;
    const { runId } = await createRun(value.sourceId, value.sessionId);
    const pageGroup = await expectPost(`/v1/runs/${runId}/page-groups`, {
      pageGroupKey: "asset-history",
      declaredPageCount: value.pageBodies.length,
    });
    const artifacts: InventoryItem[] = [];
    for (const [pageIndex, body] of value.pageBodies.entries()) {
      artifacts.push(await catalogue(runId, `asset-history/page-${pageIndex}.json`, body, {
        pageGroupId: Number(pageGroup.pageGroupId),
        pageIndex,
        dataset: "asset-history",
        declaredMediaType: "application/json",
        mediaTypeBasis: "manifest",
      }));
    }
    await terminal(runId, artifacts.length);
    await seal(runId, artifacts, "sbi-vc-pagination");
  });

  it("represents MyJCB multi-connection redaction and re-encoding", async () => {
    const value = cases.myjcbMultiConnection;
    const { runId } = await createRun(value.sourceId, value.sessionId);
    const artifacts: InventoryItem[] = [];
    for (const connectionKey of value.connectionKeys) {
      const unitId = await unit(runId, "connection", connectionKey);
      artifacts.push(await catalogue(runId, `${connectionKey}/sanitized.html`, value.sanitizedBody, {
        fetchUnitId: unitId,
        artifactRole: "sanitized_provider_capture",
        payloadFidelity: "transformed",
        lineageDisposition: "source_not_retained_for_security",
        dataset: "statement-html",
        formatId: "myjcb-sanitized-html",
        declaredMediaType: "text/html",
        mediaTypeBasis: "manifest",
        transformSteps: [
          { stepIndex: 0, stepKind: "redacted", transformerId: "myjcb-sanitizer", transformerVersion: "fixture-v1" },
          { stepIndex: 1, stepKind: "reencoded", transformerId: "myjcb-sanitizer", transformerVersion: "fixture-v1" },
        ],
      }));
      await unitTerminal(unitId, 1);
    }
    await terminal(runId, artifacts.length);
    await seal(runId, artifacts, "myjcb");
  });

  it("stores only fixed-redaction Mobile Suica CP932 bytes with explicit transformation lineage", async () => {
    const value = cases.mobileSuicaCp932;
    expect(value.redactionSentinel).toBe("__KOGANE_REDACTED_BASE_VARIABLE__");
    expect(value.sanitizedCp932Hex).toContain("626173655661726961626c65");
    expect(value.sanitizedCp932Hex).toContain("5f5f4b4f47414e455f52454441435445445f424153455f5641524941424c455f5f");
    const body = Uint8Array.from(
      value.sanitizedCp932Hex.match(/../g)!.map((pair) => Number.parseInt(pair, 16)),
    );
    const { runId } = await createRun(value.sourceId, value.sessionId);
    const artifact = await catalogue(runId, "sf-history-page-0001.sanitized.html", body, {
      artifactRole: "sanitized_provider_capture",
      payloadFidelity: "transformed",
      lineageDisposition: "source_not_retained_for_security",
      dataset: "sf-history-page",
      formatId: "mobile-suica-sf-history-html-cp932-sanitized",
      formatVersion: "v1",
      declaredMediaType: "text/html",
      mediaTypeBasis: "manifest",
      storage: await mobileSuicaStorageOrigin("sf-history-page-0001.html"),
      transformSteps: [
        {
          stepIndex: 0,
          stepKind: "redacted",
          transformerId: "mobile-suica-history-sanitizer",
          transformerVersion: "v1",
        },
        {
          stepIndex: 1,
          stepKind: "reencoded",
          transformerId: "mobile-suica-history-sanitizer",
          transformerVersion: "v1",
        },
      ],
    });
    await terminal(runId, 1);
    await seal(runId, [artifact], "mobile-suica-sanitized-cp932");
    const stored = await env.EVIDENCE.get(`objects/${artifact.sha256.slice(0, 2)}/${artifact.sha256}`);
    expect(new Uint8Array(await stored!.arrayBuffer())).toEqual(body);

    const descriptor = await env.DB.prepare(`
      SELECT artifact_role, payload_fidelity, lineage_disposition
      FROM fetch_artifacts WHERE fetch_run_id = ? AND artifact_key = ?
    `).bind(runId, artifact.artifactKey).first();
    expect(descriptor).toEqual({
      artifact_role: "sanitized_provider_capture",
      payload_fidelity: "transformed",
      lineage_disposition: "source_not_retained_for_security",
    });
    const steps = await env.DB.prepare(`
      SELECT step_index, step_kind, transformer_id, transformer_version
      FROM artifact_transform_steps
      WHERE fetch_artifact_id = (
        SELECT id FROM fetch_artifacts WHERE fetch_run_id = ? AND artifact_key = ?
      )
      ORDER BY step_index
    `).bind(runId, artifact.artifactKey).all();
    expect(steps.results).toEqual([
      { step_index: 0, step_kind: "redacted", transformer_id: "mobile-suica-history-sanitizer", transformer_version: "v1" },
      { step_index: 1, step_kind: "reencoded", transformer_id: "mobile-suica-history-sanitizer", transformer_version: "v1" },
    ]);
  });

  it("retains a V Point empty page as positive evidence", async () => {
    const value = cases.vPointEmptyPage;
    const { runId } = await createRun(value.sourceId, value.sessionId);
    const pageGroup = await expectPost(`/v1/runs/${runId}/page-groups`, {
      pageGroupKey: "point-history",
      declaredPageCount: 1,
    });
    const artifact = await catalogue(runId, "point-history/page-0.json", value.body, {
      pageGroupId: Number(pageGroup.pageGroupId),
      pageIndex: 0,
      dataset: "point-history",
      declaredMediaType: "application/json",
      mediaTypeBasis: "manifest",
    });
    await terminal(runId, 1);
    await seal(runId, [artifact], "v-point-empty");
  });

  it("maps V Point Pay mail and keeps reconciliation as a V Point generated report", async () => {
    const value = cases.vPointPayMail;
    const aliases = await env.DB.prepare(`
      SELECT external_source_id, source_id FROM source_external_ids
      WHERE external_source_id IN ('v-point-pay-email', 'v-point-pay-email-reconciliation')
      ORDER BY external_source_id
    `).all<{ external_source_id: string; source_id: string }>();
    expect(aliases.results).toEqual([
      { external_source_id: "v-point-pay-email", source_id: "v-point-pay" },
      { external_source_id: "v-point-pay-email-reconciliation", source_id: "v-point" },
    ]);

    const mailRun = await createRun(value.sourceId, value.sessionId, "mail");
    const mailArtifacts: InventoryItem[] = [];
    for (const [kind, body] of [["direct", value.directBody], ["forwarded", value.forwardedBody]] as const) {
      const fingerprint = await sha256Hex(new TextEncoder().encode(`fixture-mail:${kind}`));
      mailArtifacts.push(await catalogue(mailRun.runId, `mail/${kind}.eml`, body, {
        artifactRole: "provider_message",
        dataset: "notification-mail",
        declaredMediaType: "message/rfc822",
        mediaTypeBasis: "manifest",
        email: {
          transportShape: kind === "direct" ? "direct" : "forwarded_rfc822",
          senderDomain: kind === "direct" ? "provider.example" : "example.invalid",
          messageIdSha256: fingerprint,
          ...(kind === "forwarded" ? {
            partIndex: 0,
            mimePartPath: "1",
            innerMessageSha256: await sha256Hex(new TextEncoder().encode("fixture-inner-message")),
            innerSenderDomain: "provider.example",
          } : {}),
          filenameTemplate: "{redacted}.{extension}",
          filenameFingerprint: fingerprint,
          fingerprintKeyVersion: FINGERPRINT_VERSION,
          redactionVersion: "v1",
        },
      }));
    }
    await terminal(mailRun.runId, mailArtifacts.length);
    await seal(mailRun.runId, mailArtifacts, "v-point-pay-mail");

    const reconciliationRun = await createRun(
      value.reconciliationSourceId,
      value.sessionId,
      "email-reconciliation",
    );
    expect(reconciliationRun.sessionId).toBe(mailRun.sessionId);
    const report = await catalogue(
      reconciliationRun.runId,
      "reports/v-point-pay-email-reconciliation.json",
      value.reconciliationBody,
      {
        artifactRole: "collector_summary",
        payloadFidelity: "generated",
        dataset: "v-point-pay-email-reconciliation",
        declaredMediaType: "application/json",
        mediaTypeBasis: "manifest",
      },
    );
    await terminal(reconciliationRun.runId, 1);
    await seal(reconciliationRun.runId, [report], "v-point-reconciliation");
  });

  it("records Sony sanitized evidence without claiming retained source bytes", async () => {
    const value = cases.sonyNonRetention;
    const { runId } = await createRun(value.sourceId, value.sessionId);
    const artifact = await catalogue(runId, "sanitized/account.html", value.sanitizedBody, {
      artifactRole: "sanitized_provider_capture",
      payloadFidelity: "transformed",
      lineageDisposition: "source_not_retained_for_security",
      dataset: "account-snapshot",
      declaredMediaType: "text/html",
      mediaTypeBasis: "manifest",
      transformSteps: [{
        stepIndex: 0,
        stepKind: "redacted",
        transformerId: "sony-sanitizer",
        transformerVersion: "fixture-v1",
      }],
    });
    await terminal(runId, 1);
    await seal(runId, [artifact], "sony-non-retention");
  });

  it("preserves MoneyForward acquisition order independently of artifact keys", async () => {
    const value = cases.moneyForwardOrdering;
    const { runId } = await createRun(value.sourceId, value.sessionId);
    const artifacts: InventoryItem[] = [];
    for (const [sequence, body] of value.bodies.entries()) {
      artifacts.push(await catalogue(runId, `capture/${2 - sequence}.json`, body, {
        sequence,
        dataset: "ordered-capture",
        declaredMediaType: "application/json",
        mediaTypeBasis: "manifest",
      }));
    }
    await terminal(runId, artifacts.length);
    await seal(runId, artifacts, "moneyforward-ordering");
    const rows = await env.DB.prepare(`
      SELECT artifact_key FROM fetch_artifacts WHERE fetch_run_id = ? ORDER BY sequence
    `).bind(runId).all<{ artifact_key: string }>();
    expect(rows.results.map((row) => row.artifact_key)).toEqual([
      "capture/2.json", "capture/1.json", "capture/0.json",
    ]);
  });

  it("resumes an SMBC bounded backfill after a recorded incomplete transfer", async () => {
    const value = cases.smbcResume;
    const { runId } = await createRun(value.sourceId, value.sessionId);
    await expectPost(`/v1/runs/${runId}/ranges`, {
      rangeKey: "requested-window",
      rangeKind: "requested",
      precision: "date",
      startValue: "2026-01-01",
      endValue: "2026-01-31",
      basis: "request",
    });
    const artifacts: InventoryItem[] = [];
    const firstUnit = await unit(runId, "chunk", value.chunkKeys[0]);
    artifacts.push(await catalogue(runId, `${value.chunkKeys[0]}.json`, value.chunkBody, {
      fetchUnitId: firstUnit,
      dataset: "account-history",
      declaredMediaType: "application/json",
      mediaTypeBasis: "manifest",
    }));
    await unitTerminal(firstUnit, 1);
    await expectPost(`/v1/runs/${runId}/attempts`, {
      externalAttemptId: "fixture-smbc-interrupted",
      outcome: "incomplete",
      completedAtMs: Date.now(),
      observedArtifactCount: 2,
      acceptedArtifactCount: 1,
      reusedArtifactCount: 0,
      rejectedArtifactCount: 0,
      errorCode: "human-required",
    });
    await expectPost(`/v1/runs/${runId}/reports`, {
      reportKey: "awaiting-renewal",
      reportKind: "progress",
      normalizedOutcome: "human_required",
    });

    const secondUnit = await unit(runId, "chunk", value.chunkKeys[1]);
    await expectPost(`/v1/units/${secondUnit}/reports`, {
      reportKey: "awaiting-renewal",
      reportKind: "progress",
      normalizedOutcome: "human_required",
    });
    artifacts.push(await catalogue(runId, `${value.chunkKeys[1]}.json`, value.chunkBody, {
      fetchUnitId: secondUnit,
      dataset: "account-history",
      declaredMediaType: "application/json",
      mediaTypeBasis: "manifest",
    }));
    await unitTerminal(secondUnit, 1);
    await terminal(runId, artifacts.length);
    await seal(runId, artifacts, "smbc-resumed");
    const attempts = await env.DB.prepare(`
      SELECT outcome FROM ingestion_attempts WHERE fetch_run_id = ? ORDER BY id
    `).bind(runId).all<{ outcome: string }>();
    expect(attempts.results.map((row) => row.outcome)).toEqual(["incomplete", "complete"]);
  });

  it("uses resumable staged inventory above the direct-seal item limit", async () => {
    const value = cases.largeStagedInventory;
    const { runId } = await createRun(value.sourceId, value.sessionId);
    const object = await upload(runId, value.body);
    const artifacts: InventoryItem[] = [];
    for (let offset = 0; offset < value.itemCount; offset += 25) {
      const chunk = Array.from(
        { length: Math.min(25, value.itemCount - offset) },
        (_, index) => offset + index,
      );
      artifacts.push(...await Promise.all(chunk.map((index) => catalogueUploaded(
        runId,
        `large/item-${String(index).padStart(4, "0")}.json`,
        object,
        { dataset: "large-inventory-fixture" },
      ))));
    }
    artifacts.sort((left, right) => left.artifactKey.localeCompare(right.artifactKey));
    await terminal(runId, artifacts.length);
    const direct = await post(`/v1/runs/${runId}/seal`, {
      artifacts,
      declarationBasis: "producer_manifest",
      externalAttemptId: "fixture-large-direct",
    });
    expect(direct.status).toBe(400);

    const inventorySha256 = await sha256Hex(canonicalJson(artifacts));
    const inventory = await expectPost(`/v1/runs/${runId}/inventories`, {
      inventorySha256,
      expectedArtifactCount: artifacts.length,
      declarationBasis: "producer_manifest",
    });
    const inventoryId = Number(inventory.inventoryId);
    for (let offset = 0; offset < artifacts.length; offset += 30) {
      await expectPost(`/v1/runs/${runId}/inventories/${inventoryId}/items`, {
        items: artifacts.slice(offset, offset + 30),
      });
    }
    const sealed = await expectPost(`/v1/runs/${runId}/inventories/${inventoryId}/seal`, {
      externalAttemptId: "fixture-large-staged",
    });
    expect(sealed.sealed).toBe(true);
    expect(await env.DB.prepare(`
      SELECT count(*) AS count FROM run_inventory_items WHERE inventory_id = ?
    `).bind(inventoryId).first<{ count: number }>()).toEqual({ count: value.itemCount });
  }, 180_000);
});
