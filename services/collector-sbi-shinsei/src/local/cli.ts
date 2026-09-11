import { resolve } from "node:path";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { parseCredential } from "../credential";
import {
  createPrivateRunDirectory,
  storePrivateArtifacts,
  storePrivateManifest,
} from "./file-store";
import { WindowsChromeContextCollector } from "./windows-chrome-collector";
import { liveReadsEnabled } from "../read-allowlist";

interface CliOptions {
  dryRun: boolean;
  outputDirectory: string;
  credentialFile: string;
  credentialStdin: boolean;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  if (options.dryRun) {
    log({
      event: "sbi-shinsei-local-ready",
      networkAttempted: false,
      authenticationAttempted: false,
      browserRunRoutesEnabled: liveReadsEnabled(),
    });
    return;
  }

  const credentialJson = await loadCredentialJson(options.credentialFile, options.credentialStdin);
  const startedAt = new Date().toISOString();
  const credential = parseCredential(credentialJson);
  const result = await new WindowsChromeContextCollector().collect(credential);
  if (!result.normalized) {
    throw new Error(
      "SBI Shinsei local collection was partial; use the Worker outbox to preserve it",
    );
  }
  const runDirectory = await createPrivateRunDirectory(options.outputDirectory);
  const artifacts = await storePrivateArtifacts({
    runDirectory,
    artifacts: result.artifacts,
  });
  const completedAt = new Date().toISOString();
  await storePrivateManifest({
    runDirectory,
    startedAt,
    completedAt,
    artifacts,
    balanceCount: result.normalized.balances.length,
    transactionCount: result.normalized.transactions.length,
  });
  log({
    event: "sbi-shinsei-local-complete",
    status: "success",
    runDirectory,
    artifactCount: artifacts.length + 1,
    balanceCount: result.normalized.balances.length,
    transactionCount: result.normalized.transactions.length,
  });
}

function parseArguments(values: string[]): CliOptions {
  let dryRun = false;
  let outputDirectory = "/tmp/kogane-sbi-shinsei";
  let credentialFile = "/home/risu/.local/share/kogane/secrets/sbi-shinsei.json";
  let credentialStdin = false;
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--dry-run") {
      dryRun = true;
      continue;
    }
    if (value === "--output-dir") {
      const next = values[index + 1];
      if (!next) throw new Error("--output-dir requires a value");
      outputDirectory = resolve(next);
      index += 1;
      continue;
    }
    if (value === "--credential-file") {
      const next = values[index + 1];
      if (!next) throw new Error("--credential-file requires a value");
      credentialFile = resolve(next);
      index += 1;
      continue;
    }
    if (value === "--credential-stdin") {
      credentialStdin = true;
      continue;
    }
    throw new Error("Unknown local collector argument");
  }
  return { dryRun, outputDirectory, credentialFile, credentialStdin };
}

async function loadCredentialJson(
  credentialFile: string,
  credentialStdin: boolean,
): Promise<string> {
  if (credentialStdin) {
    const value = await new Response(Bun.stdin.stream()).arrayBuffer();
    if (value.byteLength === 0 || value.byteLength > 4_096) {
      throw new Error("SBI Shinsei credential stdin has an invalid size");
    }
    return new TextDecoder().decode(value);
  }
  const environmentValue = process.env.SBI_SHINSEI_CREDENTIAL_JSON;
  if (environmentValue) return environmentValue;
  const handle = await open(credentialFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error("SBI Shinsei credential path must be a regular file");
    }
    if ((metadata.mode & 0o777) !== 0o600) {
      throw new Error("SBI Shinsei credential file must have mode 0600");
    }
    if (metadata.size === 0 || metadata.size > 4_096) {
      throw new Error("SBI Shinsei credential file has an invalid size");
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function log(value: Record<string, unknown>): void {
  console.log(JSON.stringify(value));
}

function publicError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown error";
  return message
    .replace(/Bearer\s+[^\s,;]+/giu, "Bearer [redacted]")
    .replace(
      /(password|accountNumber|branchNumber|nationalId|authorization|cookie|csrf|jsc|token)=?[^\s,;]*/giu,
      "$1=[redacted]",
    )
    .slice(0, 300);
}

main().catch((error: unknown) => {
  console.error(
    JSON.stringify({
      event: "sbi-shinsei-local-failed",
      errorType: error instanceof Error ? error.name : "UnknownError",
      message: publicError(error),
    }),
  );
  process.exitCode = 1;
});
