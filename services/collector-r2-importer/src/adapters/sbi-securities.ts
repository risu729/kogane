import { INGEST_CONTRACT_VERSION, importSbiRun } from "../sbi";
import { assertNoResume, httpCommand, httpNoResume, type ImportAdapter } from "./contract";

export const SBI_SECURITIES_ADAPTER = {
  id: "sbi-securities",
  contractVersion: INGEST_CONTRACT_VERSION,
  resumeKind: "none",
  http: {
    importRun: "/v1/sbi-securities/import-run",
    backfillPage: { path: "/v1/sbi-securities/backfill-page", cursorBudget: 4_096 },
  },
  validateCommand: httpCommand("sbi-securities", {
    key: "manifestKey",
    max: 500,
    continuation: false,
  }),
  validateResume: httpNoResume,
  step: (env, command, resume) => {
    assertNoResume(resume);
    return importSbiRun({
      bucket: env.SBI_SNAPSHOTS,
      centralService: env.RAW_EVIDENCE,
      centralToken: env.RAW_EVIDENCE_TOKEN,
      fingerprintKey: env.ORIGIN_FINGERPRINT_KEY,
      importerVersion: env.IMPORTER_VERSION,
      manifestKey: command.terminalKey,
    });
  },
  repairPolicy: { outbox: (env) => env.SBI_SNAPSHOTS },
} as const satisfies ImportAdapter<Awaited<ReturnType<typeof importSbiRun>>>;
