import { INGEST_CONTRACT_VERSION, importSmbcDirectRun } from "../smbc-direct";
import { httpCommand, httpNoResume, resumeOffset, type ImportAdapter } from "./contract";

export const SMBC_DIRECT_ADAPTER = {
  id: "smbc-direct",
  contractVersion: INGEST_CONTRACT_VERSION,
  resumeKind: "offset",
  http: {
    importRun: "/v1/smbc-direct/import-run",
    backfillPage: { path: "/v1/smbc-direct/backfill-page", cursorBudget: 12_000 },
  },
  validateCommand: httpCommand("smbc-direct", {
    key: "manifestKey",
    max: 500,
    continuation: false,
  }),
  validateResume: httpNoResume,
  step: (env, command, resume) =>
    importSmbcDirectRun({
      bucket: env.SMBC_DIRECT_SNAPSHOTS,
      centralService: env.RAW_EVIDENCE,
      centralToken: env.RAW_EVIDENCE_TOKEN_SMBC_DIRECT,
      fingerprintKey: env.ORIGIN_FINGERPRINT_KEY,
      importerVersion: env.IMPORTER_VERSION,
      manifestKey: command.terminalKey,
      offset: resumeOffset(resume),
      immediate: command.mode === "immediate",
    }),
  repairPolicy: { outbox: (env) => env.SMBC_DIRECT_SNAPSHOTS },
} as const satisfies ImportAdapter<Awaited<ReturnType<typeof importSmbcDirectRun>>>;
