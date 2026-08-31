import { fileURLToPath } from "node:url";
import { JscAcquisitionError, UnknownResponseShapeError } from "../errors";
import { normalizeCoreResponses } from "../normalized";
import { validateKnownResponse } from "../response-schemas";
import type {
  JsonObject,
  NormalizedSnapshot,
  RawArtifact,
  SbiShinseiCredential,
} from "../types";
import type { BrowserCollectionHandoff } from "../browser-page";

const MAX_HELPER_OUTPUT_BYTES = 10 * 1024 * 1024;

export interface ChromeContextCollectorResult {
  artifacts: RawArtifact[];
  normalized: NormalizedSnapshot;
}

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
  const root = exactObject(parsed, ["ok", "responses"], "collector");
  if (root.ok !== true) {
    throw new UnknownResponseShapeError("Chrome-context collector did not succeed");
  }
  const responses = exactObject(
    root.responses,
    ["topBalances", "balanceSummary", "exchangeRate", "yenDeposit"],
    "collector.responses",
  );
  const topBalances = validateRaw(
    responses.topBalances,
    "sbi-shinsei-top-balances-v1",
    "topBalances",
  );
  const balanceSummary = validateRaw(
    responses.balanceSummary,
    "sbi-shinsei-balance-summary-v1",
    "balanceSummary",
  );
  const exchangeRate = validateRaw(
    responses.exchangeRate,
    "sbi-shinsei-exchange-rate-v1",
    "exchangeRate",
  );
  const yenDeposit = validateRaw(
    responses.yenDeposit,
    "sbi-shinsei-yen-deposit-account-v1",
    "yenDeposit",
  );
  const normalized = normalizeCoreResponses({
    capturedAt: capturedAt.toISOString(),
    topBalances: topBalances.data,
  });
  return {
    normalized,
    artifacts: [
      artifact("top-accounts-balance-and-activity", "raw-top-accounts-balance-and-activity.json", topBalances.raw),
      artifact("balance-summary-and-stage", "raw-balance-summary-and-stage.json", balanceSummary.raw),
      artifact("exchange-rate", "raw-exchange-rate.json", exchangeRate.raw),
      artifact("yen-deposit-account", "raw-yen-deposit-account.json", yenDeposit.raw),
      artifact("normalized", "normalized.json", `${JSON.stringify(normalized, null, 2)}\n`),
    ],
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
