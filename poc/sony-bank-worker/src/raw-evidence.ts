import type {
  RawEvidenceBackfillPageResult,
  RawEvidenceImportResult,
} from "./types";

const MAX_RESPONSE_BYTES = 8 * 1024;

export async function importStoredRun(
  importer: Fetcher,
  manifestKey: string,
): Promise<RawEvidenceImportResult> {
  return importerRequest<RawEvidenceImportResult>(
    importer,
    "/v1/sony-bank/import-run",
    { manifestKey },
  );
}

export async function backfillStoredRuns(
  importer: Fetcher,
  options: { cursor?: string; limit?: number },
): Promise<RawEvidenceBackfillPageResult> {
  return importerRequest<RawEvidenceBackfillPageResult>(
    importer,
    "/v1/sony-bank/backfill-page",
    options,
  );
}

async function importerRequest<T>(importer: Fetcher, path: string, body: unknown): Promise<T> {
  const response = await importer.fetch(new Request(`https://collector-r2-importer.internal${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }));
  const responseText = await boundedText(response, MAX_RESPONSE_BYTES);
  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new Error(`Raw evidence importer returned HTTP ${response.status}`);
  }
  if (!response.ok) {
    const code = isRecord(parsed) && typeof parsed.error === "string" ? parsed.error : "request_failed";
    throw new Error(`Raw evidence importer failed with HTTP ${response.status}: ${code}`);
  }
  return parsed as T;
}

async function boundedText(response: Response, limit: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel("response_too_large");
      throw new Error("Raw evidence importer response exceeded limit");
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
