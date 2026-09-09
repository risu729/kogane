import { INGEST_CONTRACT_VERSION, importVpassRun } from "../vpass";
import { importVpassCardBinding } from "../vpass-identity";
import { httpCommand, httpTokenResume, resumeToken, type ImportAdapter } from "./contract";

export const VPASS_ADAPTER = {
  id: "vpass",
  contractVersion: INGEST_CONTRACT_VERSION,
  resumeKind: "token",
  http: {
    importRun: "/v1/vpass/import-run",
    backfillPage: { path: "/v1/vpass/backfill-page", cursorBudget: 24_000 },
  },
  validateCommand: httpCommand("vpass", { key: "recordKey", max: 500, continuation: true }),
  validateResume: httpTokenResume(16_000),
  step: async (env, command, resume) => {
    const continuation = resumeToken(resume);
    const result = await importVpassRun({
      bucket: env.VPASS_SNAPSHOTS,
      centralService: env.RAW_EVIDENCE,
      centralToken: env.RAW_EVIDENCE_TOKEN_VPASS,
      fingerprintKey: env.ORIGIN_FINGERPRINT_KEY,
      importerVersion: env.IMPORTER_VERSION,
      recordKey: command.terminalKey,
      ...(continuation ? { continuation } : {}),
    });
    // Every entry point keeps the durable sidecar current. A sidecar retry
    // reuses the sealed financial run and never appends financial observations.
    if (result.status === "sealed") await importVpassBinding(env, command.terminalKey);
    return result;
  },
  repairPolicy: { outbox: (env) => env.VPASS_SNAPSHOTS },
} as const satisfies ImportAdapter<Awaited<ReturnType<typeof importVpassRun>>>;

/** The Vpass-only identity sidecar; also served by `POST /v1/vpass/import-card-binding`. */
export function importVpassBinding(env: Env, recordKey: string) {
  return importVpassCardBinding({
    bucket: env.VPASS_SNAPSHOTS,
    centralService: env.RAW_EVIDENCE,
    centralToken: env.RAW_EVIDENCE_TOKEN_VPASS,
    fingerprintKey: env.ORIGIN_FINGERPRINT_KEY,
    recordKey,
  });
}
