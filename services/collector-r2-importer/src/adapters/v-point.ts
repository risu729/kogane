import { INGEST_CONTRACT_VERSION, importVPointRun } from "../v-point";
import { httpCommand, httpNoResume, resumeOffset, type ImportAdapter } from "./contract";

export const V_POINT_ADAPTER = {
  id: "v-point",
  contractVersion: INGEST_CONTRACT_VERSION,
  resumeKind: "offset",
  http: {
    importRun: "/v1/v-point/import-run",
    backfillPage: { path: "/v1/v-point/backfill-page", cursorBudget: 12_000 },
  },
  validateCommand: httpCommand("v-point", { key: "manifestKey", max: 500, continuation: false }),
  validateResume: httpNoResume,
  step: (env, command, resume) =>
    importVPointRun({
      bucket: env.VPOINT_SNAPSHOTS,
      reconciliationBucket: env.VPOINT_PAY_SNAPSHOTS,
      centralService: env.RAW_EVIDENCE,
      centralToken: env.RAW_EVIDENCE_TOKEN_VPOINT,
      fingerprintKey: env.ORIGIN_FINGERPRINT_KEY,
      importerVersion: env.IMPORTER_VERSION,
      manifestKey: command.terminalKey,
      offset: resumeOffset(resume),
      immediate: command.mode === "immediate",
    }),
  repairPolicy: { outbox: (env) => env.VPOINT_SNAPSHOTS },
} as const satisfies ImportAdapter<Awaited<ReturnType<typeof importVPointRun>>>;
