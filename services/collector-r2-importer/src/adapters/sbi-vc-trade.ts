import { INGEST_CONTRACT_VERSION, importSbiVcRun } from "../sbi-vc";
import { httpCommand, httpTokenResume, resumeToken, type ImportAdapter } from "./contract";

export const SBI_VC_TRADE_ADAPTER = {
  id: "sbi-vc-trade",
  contractVersion: INGEST_CONTRACT_VERSION,
  resumeKind: "token",
  http: {
    importRun: "/v1/sbi-vc-trade/import-run",
    backfillPage: { path: "/v1/sbi-vc-trade/backfill-page", cursorBudget: 4_096 },
  },
  validateCommand: httpCommand("sbi-vc-trade", {
    key: "manifestKey",
    max: 500,
    continuation: true,
  }),
  validateResume: httpTokenResume(8_000),
  step: (env, command, resume) => {
    const continuation = resumeToken(resume);
    return importSbiVcRun({
      bucket: env.SBI_VC_SNAPSHOTS,
      centralService: env.RAW_EVIDENCE,
      centralToken: env.RAW_EVIDENCE_TOKEN_SBI_VC,
      fingerprintKey: env.ORIGIN_FINGERPRINT_KEY,
      importerVersion: env.IMPORTER_VERSION,
      manifestKey: command.terminalKey,
      ...(continuation ? { continuation } : {}),
    });
  },
  repairPolicy: { outbox: (env) => env.SBI_VC_SNAPSHOTS },
} as const satisfies ImportAdapter<Awaited<ReturnType<typeof importSbiVcRun>>>;
