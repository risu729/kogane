import { createHmac } from "node:crypto";
import { basename, extname, resolve } from "node:path";
import { stat } from "node:fs/promises";

interface Options {
  sourceId: string;
  filePath: string;
  mediaType?: string;
}

const BASE_URL = "https://kogane-ingest.takuanimal.workers.dev";

function parseArgs(args: string[]): Options {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (!name?.startsWith("--") || !value) throw new Error("invalid arguments");
    values.set(name.slice(2), value);
  }
  const sourceId = values.get("source");
  const filePath = values.get("file");
  if (!sourceId || !filePath) {
    throw new Error(
      "usage: ingest-file.sh --source <source-id> --file <path> [--media-type <type>]",
    );
  }
  return {
    sourceId,
    filePath: resolve(filePath),
    mediaType: values.get("media-type"),
  };
}

async function sha256(file: Blob): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of file.stream()) hasher.update(chunk);
  return hasher.digest("hex");
}

async function requestJson(
  url: string,
  token: string,
  method: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  const result = (await response.json()) as Record<string, unknown>;
  if (!response.ok)
    throw new Error(`${response.status}: ${String(result.error ?? "request_failed")}`);
  return result;
}

const options = parseArgs(Bun.argv.slice(2));
const token = (await Bun.file("/dev/fd/3").text()).trim();
if (!/^local-backfill\.[^\s]{20,}$/.test(token)) throw new Error("invalid credential on fd 3");
const fingerprintKey = (await Bun.file("/dev/fd/4").text()).trim();
if (!/^[0-9a-f]{64}$/.test(fingerprintKey)) throw new Error("invalid fingerprint key on fd 4");
const file = Bun.file(options.filePath);
if (!(await file.exists())) throw new Error("file not found");
const fileStat = await stat(options.filePath);
if (!fileStat.isFile()) throw new Error("path is not a regular file");
const digest = await sha256(file);
const byteSize = file.size;

const modifiedAtMs = Math.trunc(fileStat.mtimeMs);
const filenameFingerprint = createHmac("sha256", Buffer.from(fingerprintKey, "hex"))
  .update(options.filePath)
  .digest("hex");
const sessionId = `file-${modifiedAtMs}-${filenameFingerprint.slice(0, 24)}-${digest.slice(0, 24)}`;
const attemptStartedAtMs = Date.now();
const run = await requestJson(`${BASE_URL}/v1/runs`, token, "POST", {
  producerId: "local-file-importer",
  sourceId: options.sourceId,
  externalIdNamespace: "local-file",
  externalSessionId: sessionId,
});
const runId = Number(run.runId);
const extension = extname(basename(options.filePath)).slice(1).toLowerCase();
const artifactKey = `file-${filenameFingerprint.slice(0, 24)}-${digest.slice(0, 24)}${extension ? `.${extension}` : ""}`;
const declaredMediaType = (options.mediaType ?? file.type) || undefined;
let phase = "object_upload";
let acceptedArtifactCount = 0;
let reusedArtifactCount = 0;
try {
  const put = await fetch(`${BASE_URL}/v1/runs/${runId}/objects/${digest}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-length": String(byteSize),
      "x-kogane-byte-size": String(byteSize),
    },
    body: file,
    redirect: "error",
    signal: AbortSignal.timeout(300_000),
  });
  if (!put.ok) {
    const result = (await put.json()) as Record<string, unknown>;
    throw new Error(`${put.status}: ${String(result.error ?? "object_upload_failed")}`);
  }
  if (put.status === 201) acceptedArtifactCount = 1;
  else reusedArtifactCount = 1;

  phase = "artifact_catalogue";
  const artifact = await requestJson(`${BASE_URL}/v1/runs/${runId}/artifacts`, token, "POST", {
    artifactKey,
    artifactRole: "user_capture",
    payloadFidelity: "unknown",
    containerKind: "single",
    lineageDisposition: "not_applicable",
    ...(declaredMediaType
      ? {
          declaredMediaType,
          mediaTypeBasis: options.mediaType ? "operator" : "file_metadata",
        }
      : {}),
    fetchedAtMs: modifiedAtMs,
    fetchedAtBasis: "file_metadata",
    file: {
      basenameTemplate: extension ? "{redacted}.{extension}" : "{redacted}",
      filenameFingerprint,
      fingerprintKeyVersion: "local-file-v1",
      redactionVersion: "v1",
      sourceModifiedAtMs: modifiedAtMs,
    },
    sha256: digest,
    byteSize,
  });
  const descriptorSha256 = String(artifact.descriptorSha256);

  phase = "terminal_report";
  await requestJson(`${BASE_URL}/v1/runs/${runId}/reports`, token, "POST", {
    reportKey: "terminal",
    reportKind: "terminal",
    normalizedOutcome: "success",
    completedAtMs: modifiedAtMs,
    completedAtBasis: "file_metadata",
    declaredArtifactCount: 1,
    artifactCountScope: "all_catalogued",
  });

  phase = "seal";
  const seal = await requestJson(`${BASE_URL}/v1/runs/${runId}/seal`, token, "POST", {
    artifacts: [{ artifactKey, sha256: digest, descriptorSha256 }],
    declarationBasis: "file_receipt",
    // A rerun is a new transfer attempt against the same deterministic run.
    // Keeping the invocation timestamp in both fields makes a committed seal
    // safely replayable after its HTTP response is lost without conflicting
    // with the prior immutable attempt row.
    externalAttemptId: `attempt-${sessionId}-${attemptStartedAtMs}`,
    startedAtMs: attemptStartedAtMs,
  });
  console.log(
    JSON.stringify({
      sourceId: options.sourceId,
      runId,
      artifactId: artifact.artifactId,
      inventoryId: seal.inventoryId,
      sealed: seal.sealed,
    }),
  );
} catch (error) {
  const transferred = acceptedArtifactCount + reusedArtifactCount;
  try {
    await requestJson(`${BASE_URL}/v1/runs/${runId}/attempts`, token, "POST", {
      externalAttemptId: `attempt-${attemptStartedAtMs}-${phase}`,
      outcome: transferred > 0 ? "incomplete" : "failed",
      startedAtMs: attemptStartedAtMs,
      completedAtMs: Date.now(),
      expectedArtifactCount: 1,
      observedArtifactCount: 1,
      acceptedArtifactCount,
      reusedArtifactCount,
      rejectedArtifactCount: transferred > 0 ? 0 : 1,
      errorCode: `${phase}_failed`,
      ingestClientVersion: "local-file-v1",
    });
  } catch {
    // Preserve the original transfer failure; attempt recording is best effort.
  }
  throw error;
}
