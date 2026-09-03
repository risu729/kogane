export interface ImportRunResult {
  source: "sbi-securities";
  manifestKey: string;
  centralRunId: number;
  artifactCount: number;
  sealed: boolean;
  allObjectsReused: boolean;
}

export interface BackfillPageResult {
  source: "sbi-securities";
  scannedObjectCount: number;
  importedManifestCount: number;
  skippedManifestCount: number;
  failedManifestCount: number;
  nextCursor: string | null;
  truncated: boolean;
  failureCode?: string;
  result?: ImportRunResult;
}

export async function importStoredRun(
  importer: Fetcher,
  manifestKey: string,
): Promise<ImportRunResult> {
  return await importerRequest<ImportRunResult>(
    importer,
    "/v1/sbi-securities/import-run",
    { manifestKey },
  );
}

export async function backfillStoredRuns(
  importer: Fetcher,
  options: { cursor?: string; limit?: number },
): Promise<BackfillPageResult> {
  return await importerRequest<BackfillPageResult>(
    importer,
    "/v1/sbi-securities/backfill-page",
    options,
  );
}

async function importerRequest<T>(
  importer: Fetcher,
  path: string,
  body: unknown,
): Promise<T> {
  const response = await importer.fetch(
    new Request(`https://collector-r2-importer.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const responseText = (await response.text()).slice(0, 8_192);
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new Error(`Raw evidence importer returned HTTP ${response.status}`);
  }
  if (!response.ok) {
    const code = isRecord(parsed) && typeof parsed.error === "string"
      ? parsed.error
      : "request_failed";
    throw new Error(
      `Raw evidence importer failed with HTTP ${response.status}: ${code}`,
    );
  }
  return parsed as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
