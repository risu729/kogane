import type {
  RawEvidenceBackfillPageResult,
  RawEvidenceImportResult,
} from "./types";

export async function importStoredRun(
  importer: Fetcher,
  manifestKey: string,
): Promise<RawEvidenceImportResult> {
  return await importerRequest<RawEvidenceImportResult>(
    importer,
    "/v1/sbi-vc-trade/import-run",
    { manifestKey },
  );
}

export async function backfillStoredRuns(
  importer: Fetcher,
  options: { cursor?: string; limit?: number },
): Promise<RawEvidenceBackfillPageResult> {
  return await importerRequest<RawEvidenceBackfillPageResult>(
    importer,
    "/v1/sbi-vc-trade/backfill-page",
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
    throw new Error(`Raw evidence importer failed with HTTP ${response.status}: ${code}`);
  }
  return parsed as T;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
