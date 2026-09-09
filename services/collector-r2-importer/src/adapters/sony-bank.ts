import { INGEST_CONTRACT_VERSION, importSonyRun } from "../sony";
import { httpCommand, httpNoResume, resumeOffset, type ImportAdapter } from "./contract";

export const SONY_BANK_ADAPTER = {
  id: "sony-bank",
  contractVersion: INGEST_CONTRACT_VERSION,
  resumeKind: "offset",
  http: {
    importRun: "/v1/sony-bank/import-run",
    backfillPage: { path: "/v1/sony-bank/backfill-page", cursorBudget: 12_000 },
  },
  validateCommand: httpCommand("sony-bank", { key: "manifestKey", max: 500, continuation: false }),
  validateResume: httpNoResume,
  step: (env, command, resume) =>
    importSonyRun({
      bucket: env.SONY_SNAPSHOTS,
      centralService: env.RAW_EVIDENCE,
      centralToken: env.RAW_EVIDENCE_TOKEN_SONY,
      fingerprintKey: env.ORIGIN_FINGERPRINT_KEY,
      importerVersion: env.IMPORTER_VERSION,
      manifestKey: command.terminalKey,
      offset: resumeOffset(resume),
      immediate: command.mode === "immediate",
    }),
  repairPolicy: { outbox: (env) => env.SONY_SNAPSHOTS },
} as const satisfies ImportAdapter<Awaited<ReturnType<typeof importSonyRun>>>;
