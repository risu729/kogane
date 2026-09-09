import { INGEST_CONTRACT_VERSION, importMoneyForwardRun } from "../moneyforward";
import { httpCommand, httpTokenResume, resumeToken, type ImportAdapter } from "./contract";

export const MONEYFORWARD_ADAPTER = {
  id: "moneyforward",
  contractVersion: INGEST_CONTRACT_VERSION,
  resumeKind: "token",
  http: {
    importRun: "/v1/moneyforward/import-run",
    backfillPage: { path: "/v1/moneyforward/backfill-page", cursorBudget: 12_000 },
  },
  validateCommand: httpCommand("moneyforward", {
    key: "manifestKey",
    max: 500,
    continuation: true,
  }),
  validateResume: httpTokenResume(8_000),
  step: (env, command, resume) => {
    const continuation = resumeToken(resume);
    return importMoneyForwardRun({
      bucket: env.MONEYFORWARD_SNAPSHOTS,
      centralService: env.RAW_EVIDENCE,
      centralToken: env.RAW_EVIDENCE_TOKEN_MONEYFORWARD,
      fingerprintKey: env.ORIGIN_FINGERPRINT_KEY,
      importerVersion: env.IMPORTER_VERSION,
      manifestKey: command.terminalKey,
      ...(continuation ? { continuation } : {}),
    });
  },
  repairPolicy: { outbox: (env) => env.MONEYFORWARD_SNAPSHOTS },
} as const satisfies ImportAdapter<Awaited<ReturnType<typeof importMoneyForwardRun>>>;
