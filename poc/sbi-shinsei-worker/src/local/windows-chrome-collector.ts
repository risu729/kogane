import { browserDiagnostics } from "../diagnostics";
import { fileURLToPath } from "node:url";
import { JscAcquisitionError, UnknownResponseShapeError } from "../errors";
import { normalizeCoreResponses } from "../normalized";
import { validateKnownResponse } from "../response-schemas";
import type {
  JsonObject,
  CollectionFailure,
  NormalizedSnapshot,
  RawArtifact,
  SbiShinseiCredential,
} from "../types";
import type { BrowserCollectionHandoff } from "../browser-page";

const MAX_HELPER_OUTPUT_BYTES = 10 * 1024 * 1024;

export interface ChromeContextCollectorResult {
  artifacts: RawArtifact[];
  normalized?: NormalizedSnapshot;
  failures: CollectionFailure[];
}

const RESPONSE_PLAN = [
  {
    key: "topBalances",
    dataset: "top-accounts-balance-and-activity",
    filename: "raw-top-accounts-balance-and-activity.json",
    schema: "sbi-shinsei-top-balances-v1",
  },
  {
    key: "balanceSummary",
    dataset: "balance-summary-and-stage",
    filename: "raw-balance-summary-and-stage.json",
    schema: "sbi-shinsei-balance-summary-v1",
  },
  {
    key: "exchangeRate",
    dataset: "exchange-rate",
    filename: "raw-exchange-rate.json",
    schema: "sbi-shinsei-exchange-rate-v1",
  },
  {
    key: "yenDeposit",
    dataset: "yen-deposit-account",
    filename: "raw-yen-deposit-account.json",
    schema: "sbi-shinsei-yen-deposit-account-v1",
  },
] as const;

export class WindowsChromeContextCollector {
  async collect(
    credential: SbiShinseiCredential,
    now = new Date(),
  ): Promise<ChromeContextCollectorResult> {
    if (process.platform !== "linux" || !process.env.WSL_DISTRO_NAME) {
      throw new JscAcquisitionError("Chrome-context collection requires WSL");
    }
    const scriptPath = fileURLToPath(
      new URL("../../scripts/windows-cdp-collect.ps1", import.meta.url),
    );
    const converted = Bun.spawnSync(["wslpath", "-w", scriptPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (converted.exitCode !== 0) {
      throw new JscAcquisitionError("Could not resolve the collection helper path");
    }
    const child = Bun.spawn([
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      converted.stdout.toString().trim(),
    ], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    child.stdin.write(JSON.stringify(credential));
    child.stdin.end();
    const timeout = setTimeout(() => child.kill(), 90_000);
    try {
      const stdoutPromise = readLimited(child.stdout, MAX_HELPER_OUTPUT_BYTES);
      const stderrPromise = readLimited(child.stderr, 64 * 1024);
      const [exitCode, stdout] = await Promise.all([
        child.exited,
        stdoutPromise,
        stderrPromise,
      ]).then(([code, output]) => [code, output] as const);
      if (exitCode !== 0) {
        throw new JscAcquisitionError(
          `Chrome-context collection failed with exit code ${exitCode}`,
        );
      }
      return parseCollectionResult(new TextDecoder().decode(stdout), now);
    } finally {
      clearTimeout(timeout);
    }
  }
}

export function parseCollectionResult(
  value: string,
  capturedAt: Date,
): ChromeContextCollectorResult {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
    throw new UnknownResponseShapeError(
      "Chrome-context collector returned non-object output",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new UnknownResponseShapeError(
      "Chrome-context collector returned invalid JSON",
    );
  }
  return parseCollectionHandoff(parsed as BrowserCollectionHandoff, capturedAt);
}

export function parseCollectionHandoff(
  parsed: unknown,
  capturedAt: Date,
): ChromeContextCollectorResult {
  const input = object(parsed, "collector");
  const partial = Object.hasOwn(input, "failure");
  const root = exactObject(
    input,
    partial ? ["ok", "responses", "failure"] : ["ok", "responses"],
    "collector",
  );
  if (root.ok !== true) {
    throw new UnknownResponseShapeError("Chrome-context collector did not succeed");
  }
  const responses = object(root.responses, "collector.responses");
  const responseKeys = Object.keys(responses).sort();
  const expectedKeys = RESPONSE_PLAN.slice(0, responseKeys.length)
    .map((entry) => entry.key)
    .sort();
  if (responseKeys.length < 1 || responseKeys.length > RESPONSE_PLAN.length ||
      responseKeys.some((key, index) => key !== expectedKeys[index])) {
    throw new UnknownResponseShapeError("collector.responses was not an ordered prefix");
  }
  if (!partial && responseKeys.length !== RESPONSE_PLAN.length) {
    throw new UnknownResponseShapeError("collector.responses was incomplete");
  }
  if (partial) {
    if (responseKeys.length === RESPONSE_PLAN.length) {
      throw new UnknownResponseShapeError("collector failure followed a complete response");
    }
    const failure = exactObject(root.failure, ["dataset", "stage"], "collector.failure");
    const next = RESPONSE_PLAN[responseKeys.length]!;
    if (failure.dataset !== next.dataset || typeof failure.stage !== "string" ||
        !/^[a-z0-9-]{1,80}$/u.test(failure.stage)) {
      throw new UnknownResponseShapeError("collector failure did not match the next dataset");
    }
  }
  const validated: Array<{
    plan: (typeof RESPONSE_PLAN)[number];
    response: { raw: string; data: JsonObject };
  }> = [];
  const failures: CollectionFailure[] = [];
  for (const plan of RESPONSE_PLAN.slice(0, responseKeys.length)) {
    try {
      validated.push({
        plan,
        response: validateRaw(responses[plan.key], plan.schema, plan.key),
      });
    } catch {
      failures.push({
        operation: `read:${plan.dataset}`,
        errorType: "ResponseSchemaError",
        message: "provider_response_invalid",
      });
    }
  }
  const topBalances = validated.find(({ plan }) => plan.key === "topBalances")
    ?.response;
  let normalized: NormalizedSnapshot | undefined;
  if (topBalances) {
    try {
      normalized = normalizeCoreResponses({
        capturedAt: capturedAt.toISOString(),
        topBalances: topBalances.data,
      });
    } catch {
      failures.push({
        operation: "derive:normalized",
        errorType: "DerivationError",
        message: "normalized_derivation_failed",
      });
    }
  } else {
    failures.push({
      operation: "derive:normalized",
      errorType: "DependencyInvalid",
      message: "normalized_source_invalid",
    });
  }
  if (partial) {
    const stage = (root.failure as { stage: string }).stage;
    for (const [index, plan] of RESPONSE_PLAN.slice(responseKeys.length).entries()) {
      failures.push({
        operation: `read:${plan.dataset}`,
        errorType: index === 0 ? "ProviderReadError" : "NotAttempted",
        message: index === 0
          ? "provider_read_failed"
          : "provider_read_not_attempted",
        ...(index === 0 ? { diagnostics: browserDiagnostics(stage) } : {}),
      });
    }
  }
  return {
    ...(normalized ? { normalized } : {}),
    artifacts: [
      ...validated.map(({ plan, response }) =>
        artifact(plan.dataset, plan.filename, response.raw)),
      ...(normalized
        ? [artifact("normalized", "normalized.json", `${JSON.stringify(normalized, null, 2)}\n`)]
        : []),
    ],
    failures,
  };
}

function validateRaw(
  value: unknown,
  schema: Parameters<typeof validateKnownResponse>[0],
  label: string,
): { raw: string; data: JsonObject } {
  if (typeof value !== "string" || value.length === 0) {
    throw new UnknownResponseShapeError(`${label} response was missing`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new UnknownResponseShapeError(`${label} response was invalid JSON`);
  }
  return { raw: value, data: validateKnownResponse(schema, parsed) };
}

function exactObject(
  value: unknown,
  keys: readonly string[],
  label: string,
): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UnknownResponseShapeError(`${label} must be an object`);
  }
  const result = value as JsonObject;
  const actual = Object.keys(result).sort();
  const expected = [...keys].sort();
  if (
    actual.length !== expected.length ||
    !actual.every((key, index) => key === expected[index])
  ) {
    throw new UnknownResponseShapeError(`${label} has an unknown shape`);
  }
  return result;
}

function object(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new UnknownResponseShapeError(`${label} was not an object`);
  }
  return value as JsonObject;
}

function artifact(dataset: string, filename: string, body: string): RawArtifact {
  return { dataset, filename, mediaType: "application/json", body };
}

async function readLimited(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        throw new UnknownResponseShapeError("Helper output exceeded its size limit");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
