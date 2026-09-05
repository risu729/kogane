const IMPORT_PATH = "/v1/sbi-shinsei/import-run";
const BACKFILL_PATH = "/v1/sbi-shinsei/backfill-page";
const MAX_RESPONSE_BYTES = 16 * 1024;

export async function importRawEvidence(options: {
  importer: Fetcher;
  manifestKey: string;
}): Promise<void> {
  const parsed = await requestImporter(options.importer, IMPORT_PATH, {
    manifestKey: options.manifestKey,
  });
  const result = parsed as Record<string, unknown>;
  if (
    result.source !== "sbi-shinsei" ||
    result.manifestKey !== options.manifestKey ||
    result.sealed !== true
  ) {
    throw new RawEvidenceImportError();
  }
}

export async function backfillRawEvidence(options: {
  importer: Fetcher;
  cursor?: string;
  limit?: number;
}): Promise<unknown> {
  return requestImporter(options.importer, BACKFILL_PATH, {
    ...(options.cursor ? { cursor: options.cursor } : {}),
    ...(options.limit ? { limit: options.limit } : {}),
  });
}

async function requestImporter(importer: Fetcher, path: string, body: unknown): Promise<unknown> {
  const response = await importer.fetch(
    new Request(`https://kogane-collector-r2-importer.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  const bytes = await boundedBytes(response);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new RawEvidenceImportError();
  }
  if (!response.ok || !parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new RawEvidenceImportError();
  }
  return parsed;
}

async function boundedBytes(response: Response): Promise<Uint8Array> {
  const declaredHeader = response.headers.get("content-length");
  if (
    declaredHeader !== null &&
    (!/^\d+$/u.test(declaredHeader) || Number(declaredHeader) > MAX_RESPONSE_BYTES)
  ) {
    throw new RawEvidenceImportError();
  }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) {
        await reader.cancel("response_too_large");
        throw new RawEvidenceImportError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export class RawEvidenceImportError extends Error {
  constructor() {
    super("SBI Shinsei raw evidence import failed");
    this.name = "RawEvidenceImportError";
  }
}
