import { INGEST_CONTRACT_VERSION, importVPointPayEmailPair } from "../v-point-pay-email";
import { assertNoResume, httpCommand, httpNoResume, type ImportAdapter } from "./contract";

export const V_POINT_PAY_EMAIL_ADAPTER = {
  id: "v-point-pay-email",
  contractVersion: INGEST_CONTRACT_VERSION,
  resumeKind: "none",
  http: {
    importRun: "/v1/v-point-pay-email/import-run",
    backfillPage: { path: "/v1/v-point-pay-email/backfill-page", cursorBudget: 4_096 },
  },
  validateCommand: httpCommand("v-point-pay-email", {
    key: "normalizedKey",
    max: 500,
    continuation: false,
  }),
  validateResume: httpNoResume,
  step: (env, command, resume) => {
    assertNoResume(resume);
    return importVPointPayEmailPair({
      bucket: env.VPOINT_PAY_SNAPSHOTS,
      centralService: env.RAW_EVIDENCE,
      centralToken: env.RAW_EVIDENCE_TOKEN_VPOINT_PAY_EMAIL,
      fingerprintKey: env.ORIGIN_FINGERPRINT_KEY,
      importerVersion: env.IMPORTER_VERSION,
      normalizedKey: command.terminalKey,
    });
  },
  repairPolicy: { outbox: (env) => env.VPOINT_PAY_SNAPSHOTS },
} as const satisfies ImportAdapter<Awaited<ReturnType<typeof importVPointPayEmailPair>>>;
