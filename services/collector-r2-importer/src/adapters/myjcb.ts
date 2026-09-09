import { INGEST_CONTRACT_VERSION, importMyJcbRun } from "../myjcb";
import { httpCommand, httpTokenResume, resumeToken, type ImportAdapter } from "./contract";

export const MYJCB_ADAPTER = {
  id: "myjcb",
  contractVersion: INGEST_CONTRACT_VERSION,
  resumeKind: "token",
  http: {
    importRun: "/v1/myjcb/import-run",
    backfillPage: { path: "/v1/myjcb/backfill-page", cursorBudget: 16_000 },
  },
  validateCommand: httpCommand("myjcb", { key: "manifestKey", max: 500, continuation: true }),
  validateResume: httpTokenResume(8_000),
  step: (env, command, resume) => {
    const continuation = resumeToken(resume);
    return importMyJcbRun({
      bucket: env.MYJCB_SNAPSHOTS,
      centralService: env.RAW_EVIDENCE,
      centralToken: env.RAW_EVIDENCE_TOKEN_MYJCB,
      fingerprintKey: env.ORIGIN_FINGERPRINT_KEY,
      importerVersion: env.IMPORTER_VERSION,
      manifestKey: command.terminalKey,
      ...(continuation ? { continuation } : {}),
    });
  },
  repairPolicy: { outbox: (env) => env.MYJCB_SNAPSHOTS },
} as const satisfies ImportAdapter<Awaited<ReturnType<typeof importMyJcbRun>>>;
