import { ImportError } from "../error";
import { INGEST_CONTRACT_VERSION, importGlobalPassRun } from "../global-pass";
import { httpCommand, httpNoResume, resumeOffset, type ImportAdapter } from "./contract";

export function parseGlobalPassLegacyEmptyAllowlist(value: string): ReadonlySet<string> {
  const hashes = value.split(",");
  if (
    hashes.length === 0 ||
    hashes.length > 15 ||
    hashes.some((hash) => !/^[0-9a-f]{64}$/u.test(hash)) ||
    new Set(hashes).size !== hashes.length
  ) {
    throw new ImportError(500, "global_pass_legacy_empty_allowlist_invalid");
  }
  return new Set(hashes);
}

export const GLOBAL_PASS_ADAPTER = {
  id: "global-pass",
  contractVersion: INGEST_CONTRACT_VERSION,
  resumeKind: "offset",
  http: {
    importRun: "/v1/prestia-globalpass/import-run",
    backfillPage: { path: "/v1/prestia-globalpass/backfill-page", cursorBudget: 12_000 },
  },
  validateCommand: httpCommand("global-pass", {
    key: "manifestKey",
    max: 500,
    continuation: false,
  }),
  validateResume: httpNoResume,
  step: (env, command, resume) =>
    importGlobalPassRun({
      bucket: env.GLOBAL_PASS_SNAPSHOTS,
      centralService: env.RAW_EVIDENCE,
      centralToken: env.RAW_EVIDENCE_TOKEN_GLOBAL_PASS,
      fingerprintKey: env.ORIGIN_FINGERPRINT_KEY,
      importerVersion: env.IMPORTER_VERSION,
      manifestKey: command.terminalKey,
      legacyEmptyArtifactSha256: parseGlobalPassLegacyEmptyAllowlist(
        env.GLOBAL_PASS_LEGACY_EMPTY_SHA256_ALLOWLIST,
      ),
      offset: resumeOffset(resume),
      immediate: command.mode === "immediate",
    }),
  repairPolicy: { outbox: (env) => env.GLOBAL_PASS_SNAPSHOTS },
} as const satisfies ImportAdapter<Awaited<ReturnType<typeof importGlobalPassRun>>>;
