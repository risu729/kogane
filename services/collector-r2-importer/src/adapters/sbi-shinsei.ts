import { INGEST_CONTRACT_VERSION, importSbiShinseiRun } from "../sbi-shinsei";
import { assertNoResume, httpCommand, httpNoResume, type ImportAdapter } from "./contract";

export const SBI_SHINSEI_ADAPTER = {
  id: "sbi-shinsei",
  contractVersion: INGEST_CONTRACT_VERSION,
  resumeKind: "none",
  http: {
    importRun: "/v1/sbi-shinsei/import-run",
    backfillPage: { path: "/v1/sbi-shinsei/backfill-page", cursorBudget: 4_096 },
  },
  validateCommand: httpCommand("sbi-shinsei", {
    key: "manifestKey",
    max: 500,
    continuation: false,
  }),
  validateResume: httpNoResume,
  step: (env, command, resume) => {
    assertNoResume(resume);
    return importSbiShinseiRun({
      bucket: env.SBI_SHINSEI_SNAPSHOTS,
      centralService: env.RAW_EVIDENCE,
      centralToken: env.RAW_EVIDENCE_TOKEN_SBI_SHINSEI,
      fingerprintKey: env.ORIGIN_FINGERPRINT_KEY,
      importerVersion: env.IMPORTER_VERSION,
      manifestKey: command.terminalKey,
    });
  },
  repairPolicy: { outbox: (env) => env.SBI_SHINSEI_SNAPSHOTS },
} as const satisfies ImportAdapter<Awaited<ReturnType<typeof importSbiShinseiRun>>>;
