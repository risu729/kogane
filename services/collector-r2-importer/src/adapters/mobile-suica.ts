import { INGEST_CONTRACT_VERSION, importMobileSuicaRun } from "../mobile-suica";
import { assertNoResume, httpCommand, httpNoResume, type ImportAdapter } from "./contract";

export const MOBILE_SUICA_ADAPTER = {
  id: "mobile-suica",
  contractVersion: INGEST_CONTRACT_VERSION,
  resumeKind: "none",
  http: {
    importRun: "/v1/mobile-suica/import-run",
    backfillPage: { path: "/v1/mobile-suica/backfill-page", cursorBudget: 4_096 },
  },
  validateCommand: httpCommand("mobile-suica", {
    key: "manifestKey",
    max: 500,
    continuation: false,
  }),
  validateResume: httpNoResume,
  step: (env, command, resume) => {
    assertNoResume(resume);
    return importMobileSuicaRun({
      bucket: env.MOBILE_SUICA_SNAPSHOTS,
      centralService: env.RAW_EVIDENCE,
      centralToken: env.RAW_EVIDENCE_TOKEN_MOBILE_SUICA,
      fingerprintKey: env.ORIGIN_FINGERPRINT_KEY,
      importerVersion: env.IMPORTER_VERSION,
      manifestKey: command.terminalKey,
    });
  },
  repairPolicy: { outbox: (env) => env.MOBILE_SUICA_SNAPSHOTS },
} as const satisfies ImportAdapter<Awaited<ReturnType<typeof importMobileSuicaRun>>>;
