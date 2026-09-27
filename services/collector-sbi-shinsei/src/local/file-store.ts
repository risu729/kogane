import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { RawArtifact } from "../types";

export interface LocalStoredArtifact {
  dataset: string;
  filename: string;
  bytes: number;
  sha256: string;
}

export async function createPrivateRunDirectory(
  outputRoot: string,
  now = new Date(),
): Promise<string> {
  if (!isAbsolute(outputRoot)) {
    throw new Error("Local output directory must be an absolute path");
  }
  const root = resolve(outputRoot);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const canonicalRoot = await realpath(root);
  const runName = `${now.toISOString().replaceAll(":", "-")}-${randomUUID()}`;
  const runDirectory = join(canonicalRoot, runName);
  await mkdir(runDirectory, { mode: 0o700 });
  return runDirectory;
}

export async function storePrivateArtifacts(options: {
  runDirectory: string;
  artifacts: RawArtifact[];
}): Promise<LocalStoredArtifact[]> {
  const stored: LocalStoredArtifact[] = [];
  for (const artifact of options.artifacts) {
    if (!/^[a-z0-9-]+$/u.test(artifact.dataset)) {
      throw new Error("Local artifact dataset is unsafe");
    }
    if (!/^[a-z0-9.-]+$/u.test(artifact.filename)) {
      throw new Error("Local artifact filename is unsafe");
    }
    if (artifact.mediaType !== "application/json") {
      throw new Error("Local artifact media type is not allowlisted");
    }
    const bytes =
      typeof artifact.body === "string"
        ? new TextEncoder().encode(artifact.body)
        : new Uint8Array(artifact.body);
    const handle = await open(join(options.runDirectory, artifact.filename), "wx", 0o600);
    try {
      await handle.writeFile(bytes);
    } finally {
      await handle.close();
    }
    stored.push({
      dataset: artifact.dataset,
      filename: artifact.filename,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
  }
  return stored;
}

export async function storePrivateManifest(options: {
  runDirectory: string;
  startedAt: string;
  completedAt: string;
  artifacts: LocalStoredArtifact[];
  balanceCount: number;
  transactionCount: number;
}): Promise<void> {
  const body = `${JSON.stringify(
    {
      schemaVersion: "sbi-shinsei-local-run-v1",
      source: "sbi-shinsei",
      startedAt: options.startedAt,
      completedAt: options.completedAt,
      status: "success",
      balanceCount: options.balanceCount,
      transactionCount: options.transactionCount,
      artifacts: options.artifacts,
    },
    null,
    2,
  )}\n`;
  const handle = await open(join(options.runDirectory, "manifest.json"), "wx", 0o600);
  try {
    await handle.writeFile(body, { encoding: "utf8" });
  } finally {
    await handle.close();
  }
}
