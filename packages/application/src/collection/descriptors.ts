// `terminal-v1` → the ingest registration contract.
//
// The terminal manifest is not a second copy of the descriptor contract
// (unified plan 03 §3): it names the run, the stored objects and the provider
// outcome, and the Processor derives descriptors from it. This module is that
// derivation, and it is pure — given a validated manifest it returns the
// request objects, and nothing here reads a bucket or a database.
//
// Two rules shape every mapping below.
//
//  * Nothing is widened. A `partial` acquisition stays partial, a unit that
//    reported an error keeps its safe code, and a coverage claim is never
//    turned into "complete" on the way through.
//  * Nothing is invented. A value the manifest does not state is left null
//    rather than guessed; a value the manifest states in a shape the ingest
//    contract does not accept is a refusal with a safe code, not a silent
//    normalization into something that addresses different evidence.
import type {
  TerminalArtifact,
  TerminalManifest,
  TerminalUnit,
} from "../../../collection/src/manifest.ts";
import type {
  ArtifactRequest,
  ArtifactRole,
  LineageDisposition,
  PayloadFidelity,
  RelationClaimRequest,
  TransformStepRequest,
} from "../../../evidence-contract/src/descriptor.ts";
import type {
  AddRunRangeRequest,
  AddRunReportRequest,
  AddUnitReportRequest,
  AddUnitRequest,
  CreateRunRequest,
  NormalizedOutcome,
} from "../../../evidence-contract/src/requests.ts";
import { ID } from "../../../evidence-contract/src/validate.ts";

/**
 * The version of *this* derivation. It is part of the registration identity
 * (03 §4): when the mapping below changes what a terminal means in CORE, the
 * same run registers again as a new revision instead of reusing the old one.
 *
 * - `terminal-registration-v1`: no artifact dataset but St George's snapshot.
 * - `terminal-registration-v2` (ADR 0022): the dataset table
 *   `ARTIFACT_DATASETS`.
 *
 * A terminal already registered under an earlier version whose descriptors
 * the current version does not change is not registered again: the new
 * version's row is linked to the run it already is (`carryOver` in
 * `register-terminal.ts`, ADR 0022). Registering it again would parse the same
 * capture twice, and a Mizuho capture's transactions would be listed twice.
 */
export const REGISTRATION_CONTRACT_VERSION = "terminal-registration-v2";

/** Every version this code can derive, oldest first; each derivation is kept reproducible. */
export const REGISTRATION_CONTRACT_VERSIONS = [
  "terminal-registration-v1",
  REGISTRATION_CONTRACT_VERSION,
] as const;
export type RegistrationContractVersion = (typeof REGISTRATION_CONTRACT_VERSIONS)[number];

export function isRegistrationContractVersion(value: string): value is RegistrationContractVersion {
  return (REGISTRATION_CONTRACT_VERSIONS as readonly string[]).includes(value);
}

/** The external id namespace every shared-R2 acquisition session is recorded under. */
export const EXTERNAL_ID_NAMESPACE = "shared-r2";

/**
 * Terminal `source` → CORE `sources.id`.
 *
 * A collector names itself in its terminal and in its `runs/<source>/` prefix
 * by its own id, which for three of them predates the registry and differs
 * from the CORE source id (U09). The mapping is explicit and closed: a
 * terminal whose source is not a key here is refused as `unknown_source`
 * before anything is registered, and `scripts/config-bootstrap.test.ts`
 * checks that every value is a declared CORE source and that the Processor's
 * ingest route for it is declared in `config/ingest-clients.json`.
 */
export const COLLECTOR_SOURCE_IDS: Readonly<Record<string, string>> = {
  "kogane-synthetic": "kogane-synthetic",
  "mizuho-bank": "mizuho-bank",
  "mobile-suica": "mobile-suica",
  "moneyforward-me": "moneyforward-me",
  myjcb: "myjcb",
  "prestia-globalpass": "global-pass",
  "sbi-securities": "sbi-securities",
  "sbi-shinsei": "sbi-shinsei-bank",
  "sbi-vc-trade": "sbi-vc-trade",
  "smbc-direct": "smbc-bank",
  "sony-bank": "sony-bank",
  "st-george": "st-george",
  "v-point": "v-point",
  "v-point-pay": "v-point-pay",
  "v-point-pay-email": "v-point-pay",
  vpass: "vpass",
};

/** The CORE source id a terminal's source registers under, or null when unknown. */
export function coreSourceId(collectorSource: string): string | null {
  return Object.hasOwn(COLLECTOR_SOURCE_IDS, collectorSource)
    ? COLLECTOR_SOURCE_IDS[collectorSource]!
    : null;
}

/**
 * One closed rule of `ARTIFACT_DATASETS`: an artifact whose key, role and
 * declared media type all match is the named parser dataset.
 */
export interface ArtifactDatasetRule {
  /** The exact artifact key, or a pattern the whole key must match. */
  readonly key: string | RegExp;
  readonly role: ArtifactRole;
  /** The media types the collector declares for these bytes (`terminal-v1` carries no parameters). */
  readonly mediaTypes: readonly string[];
  /** The dataset, or the dataset built from the key pattern's captures. */
  readonly dataset: string | ((match: RegExpExecArray) => string);
}

const JSON_TYPE = ["application/json"] as const;
const HTML_TYPE = ["text/html"] as const;
/**
 * The Sony CSV exports carry the provider's own `content-type` header, cut to
 * its base type; these are the base types `sony-bank-history-csv` decodes.
 */
const SONY_CSV_TYPES = [
  "text/csv",
  "application/csv",
  "application/x-csv",
  "text/plain",
  "application/octet-stream",
] as const;

/** A dataset named by the artifact key itself: `<dataset>.json`. */
function jsonByName(
  datasets: readonly string[],
  role: ArtifactRole,
  prefix = "",
): ArtifactDatasetRule[] {
  return datasets.map((dataset) => ({
    key: `${prefix}${dataset}.json`,
    role,
    mediaTypes: JSON_TYPE,
    dataset,
  }));
}

/**
 * Terminal `source` → the artifacts that carry a parser dataset (ADR 0022).
 *
 * `terminal-v1` has no dataset field, and every parser except Mizuho's
 * selects its artifacts by dataset, so without this table a registered
 * artifact has `dataset = NULL` and nothing parses it. The table is closed and
 * derived from two sides only:
 *
 *  * what each collector writes: the artifact key, role and media type of
 *    every persist path under `services/collector-*` (`docs/collection.md`
 *    lists them per collector). These are the artifacts the retired importer
 *    registered under the same datasets;
 *  * what each parser accepts (`packages/parsers/src/parsers/*.ts`).
 *
 * Only datasets a registered parser reads are listed. Evidence that no parser
 * reads (a manifest, a summary, the raw page beside its normalized rows)
 * stays NULL and out of every parse, as before. An artifact that matches no
 * rule, or whose role or media type is not the one its collector declares,
 * also stays NULL: it is never guessed into a dataset.
 * `scripts/artifact-datasets.test.ts` checks both directions: every mapped
 * dataset is accepted by a registered parser, and every dataset a parser
 * requires from a shared-R2 source is either mapped or named there as
 * unreachable, with the reason.
 *
 * Mizuho is absent on purpose: its parsers accept `dataset = NULL` and select
 * by key and unit, so its registration does not change. `kogane-synthetic`
 * and `v-point-pay` write nothing a parser reads. `vpass` is known but
 * withheld (`WITHHELD_ARTIFACT_DATASETS`).
 */
export const ARTIFACT_DATASETS: Readonly<Record<string, readonly ArtifactDatasetRule[]>> = {
  "mobile-suica": [
    // The normalized rows only. The CP932 page and the summary stay evidence:
    // registering the page as well would produce every row twice.
    {
      key: "sf-history.json",
      role: "collector_derived",
      mediaTypes: JSON_TYPE,
      dataset: "sf-history",
    },
  ],
  "moneyforward-me": [
    {
      key: "accounts.html",
      role: "provider_response",
      mediaTypes: HTML_TYPE,
      dataset: "accounts-index",
    },
    {
      key: /^account-detail-\d{2}\.html$/u,
      role: "provider_response",
      mediaTypes: HTML_TYPE,
      dataset: "account-detail",
    },
    {
      key: /^account-\d{2}-month-\d{4}-\d{2}\.html$/u,
      role: "provider_response",
      mediaTypes: HTML_TYPE,
      dataset: "monthly-transactions",
    },
  ],
  // MyJCB keys are `<connectionId>/<filename>`: the unit is the connection.
  // `credit-menu.html` is not listed: its parser accepts only the media type
  // `text/html; charset=utf-8`, which no terminal can declare.
  myjcb: [
    {
      key: /^[^/]+\/discovery\.json$/u,
      role: "collector_derived",
      mediaTypes: JSON_TYPE,
      dataset: "discovery",
    },
    {
      key: /^[^/]+\/credit-past-months\.json$/u,
      role: "provider_response",
      mediaTypes: JSON_TYPE,
      dataset: "credit-past-months",
    },
    {
      key: /^[^/]+\/credit-detail-\d{2}\.html$/u,
      role: "sanitized_provider_capture",
      mediaTypes: HTML_TYPE,
      dataset: "credit-detail",
    },
    {
      key: /^[^/]+\/credit-ledger-\d{2}\.json$/u,
      role: "collector_derived",
      mediaTypes: JSON_TYPE,
      dataset: "credit-ledger",
    },
  ],
  "prestia-globalpass": [
    {
      key: /^activity-\d{4}-\d{2}\.html$/u,
      role: "sanitized_provider_capture",
      mediaTypes: HTML_TYPE,
      dataset: "globalpass-activity",
    },
  ],
  "sbi-securities": jsonByName(
    [
      "domestic-cash-positions",
      "account-assets-current",
      "yen-detail-history",
      "domestic-trade-records",
      "foreign-cash-positions",
      "foreign-cash-balances",
      "foreign-trade-records",
    ],
    "collector_derived",
  ),
  "sbi-shinsei": jsonByName(
    ["top-accounts-balance-and-activity", "yen-deposit-account"],
    "sanitized_provider_capture",
    "raw-",
  ),
  "sbi-vc-trade": [
    ...jsonByName(
      ["cash-balances", "account-margin", "position-summary", "executions-recent-page-0001"],
      "collector_derived",
    ),
    {
      key: /^((?:executions|cashflows)-historical-page-\d{4})\.json$/u,
      role: "collector_derived",
      mediaTypes: JSON_TYPE,
      dataset: (match) => match[1]!,
    },
  ],
  "smbc-direct": [
    {
      key: "balance.normalized.json",
      role: "collector_derived",
      mediaTypes: JSON_TYPE,
      dataset: "balance-normalized",
    },
    {
      key: /^transactions\/\d{8}-\d{8}\.normalized\.json$/u,
      role: "collector_derived",
      mediaTypes: JSON_TYPE,
      dataset: "transactions-normalized",
    },
  ],
  "sony-bank": [
    {
      key: "gross-balance.json",
      role: "provider_response",
      mediaTypes: JSON_TYPE,
      dataset: "gross-balance",
    },
    {
      key: /^((?:yen-history|foreign-history-[a-z]{3})-page-\d{4})\.json$/u,
      role: "provider_response",
      mediaTypes: JSON_TYPE,
      dataset: (match) => match[1]!,
    },
    {
      key: /^(yen-history|foreign-history-[a-z]{3})\.csv$/u,
      role: "provider_export",
      mediaTypes: SONY_CSV_TYPES,
      dataset: (match) => `${match[1]!}-csv`,
    },
    {
      // The file name carries `YYYY-MM`; the dataset carries `YYYYMM`, as the
      // collector manifest entry the media-type extractor matches does.
      key: /^wallet-history-(\d{4})-(\d{2})\.html$/u,
      role: "sanitized_provider_capture",
      mediaTypes: HTML_TYPE,
      dataset: (match) => `wallet-history-${match[1]!}${match[2]!}`,
    },
  ],
  // This source's minimized capture contract names exactly one dataset.
  "st-george": [
    {
      key: "account-snapshot.json",
      role: "sanitized_provider_capture",
      mediaTypes: JSON_TYPE,
      dataset: "account-snapshot",
    },
  ],
  "v-point": [
    ...jsonByName(["balance-info", "smfg-point"], "collector_derived"),
    {
      key: /^(history-page-\d{4})\.json$/u,
      role: "collector_derived",
      mediaTypes: JSON_TYPE,
      dataset: (match) => match[1]!,
    },
  ],
  "v-point-pay-email": [
    {
      key: "normalized-event.json",
      role: "collector_derived",
      mediaTypes: JSON_TYPE,
      dataset: "notification-event",
    },
  ],
  // `vpass` is withheld: see `WITHHELD_ARTIFACT_DATASETS`.
};

/**
 * Rules that are known and deliberately not applied: the artifact stays at
 * `dataset = NULL`, so no parser runs on it, until the stated condition holds.
 * Moving a source from here into `ARTIFACT_DATASETS` is a decision, recorded
 * in an ADR; `scripts/artifact-datasets.test.ts` pins this list.
 *
 * `vpass` (ADR 0022, ADR 0023): a collector-vpass capture cannot yet be bound
 * to the trusted card identity (the card binding views accept only the
 * importer's producer, and the collector does not derive the binding). A
 * parsed collector capture would become the current statement snapshot of its
 * card-month and retire the importer-era Vpass purchases with nothing to
 * replace them. Unparsed, it is never eligible as a snapshot, so the
 * importer-era snapshots stay current. The rule becomes live when the
 * collector derives the binding (ADR 0023, option 3).
 */
export const WITHHELD_ARTIFACT_DATASETS: Readonly<
  Record<string, { readonly until: string; readonly rules: readonly ArtifactDatasetRule[] }>
> = {
  vpass: {
    until: "the collector derives the trusted card binding (ADR 0023)",
    rules: [
      {
        key: /^months\/\d{6}\/(?:top|answer)-\d{3}\.json$/u,
        role: "provider_response",
        mediaTypes: JSON_TYPE,
        dataset: "statement-page",
      },
    ],
  },
};

/**
 * The parser dataset of one terminal artifact, or null when the closed table
 * names none. Null is not a default standing in for a guess: it is what every
 * shared-R2 artifact carried before ADR 0022, and only Mizuho's parsers read
 * an artifact without a dataset.
 */
export function artifactDataset(
  collectorSource: string,
  artifact: Pick<TerminalArtifact, "artifactKey" | "role" | "mediaType">,
  contractVersion: string = REGISTRATION_CONTRACT_VERSION,
): string | null {
  if (!isRegistrationContractVersion(contractVersion)) fail("registration_contract_unknown");
  const table = DATASETS_BY_VERSION[contractVersion];
  if (!Object.hasOwn(table, collectorSource)) return null;
  return datasetByRules(table[collectorSource]!, artifact);
}

/**
 * The dataset table of each registration contract version. `v1` is kept so
 * that what a registration under it meant stays reproducible: it named one
 * dataset, St George's snapshot, and left every other artifact without one.
 */
const DATASETS_BY_VERSION: Readonly<
  Record<RegistrationContractVersion, Readonly<Record<string, readonly ArtifactDatasetRule[]>>>
> = {
  "terminal-registration-v1": { "st-george": ARTIFACT_DATASETS["st-george"]! },
  "terminal-registration-v2": ARTIFACT_DATASETS,
};

/** The dataset the first matching rule names, or null. */
export function datasetByRules(
  rules: readonly ArtifactDatasetRule[],
  artifact: Pick<TerminalArtifact, "artifactKey" | "role" | "mediaType">,
): string | null {
  for (const rule of rules) {
    if (rule.role !== artifact.role || !rule.mediaTypes.includes(artifact.mediaType)) continue;
    if (typeof rule.key === "string") {
      if (rule.key === artifact.artifactKey && typeof rule.dataset === "string") {
        return rule.dataset;
      }
      continue;
    }
    const match = rule.key.exec(artifact.artifactKey);
    if (match === null) continue;
    return typeof rule.dataset === "string" ? rule.dataset : rule.dataset(match);
  }
  return null;
}

export class TerminalRegistrationError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "TerminalRegistrationError";
  }
}

function fail(code: string): never {
  throw new TerminalRegistrationError(code);
}

/**
 * Every role the descriptor contract accepts, and whether it carries bytes
 * the *provider* produced. A `Record` of the union rather than a list, so a
 * role added to the contract fails to compile here instead of quietly
 * becoming "unknown" for terminals.
 */
const ARTIFACT_ROLES: Readonly<Record<ArtifactRole, { provider: boolean }>> = {
  provider_response: { provider: true },
  provider_export: { provider: true },
  provider_document: { provider: true },
  provider_message: { provider: true },
  collector_manifest: { provider: false },
  collector_error: { provider: false },
  collector_summary: { provider: false },
  collector_derived: { provider: false },
  sanitized_provider_capture: { provider: true },
  user_capture: { provider: true },
};

/**
 * True when the manifest names at least one artifact whose bytes came from
 * the provider. A failed run that persisted only its own manifest, error
 * capture or summary has nothing an observation could be made from, and is
 * recorded without being sealed (U08): an empty sealed run would present a
 * failure as a registered acquisition with no observations.
 */
export function hasProviderArtifact(manifest: TerminalManifest): boolean {
  return manifest.artifacts.some(
    (artifact) =>
      Object.hasOwn(ARTIFACT_ROLES, artifact.role) &&
      ARTIFACT_ROLES[artifact.role as ArtifactRole].provider,
  );
}

function identifier(value: string, code: string): string {
  if (!ID.test(value)) fail(code);
  return value;
}

/** ISO instant → epoch milliseconds. The manifest validator already proved the shape. */
export function instantMs(value: string): number {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) fail("invalid_manifest_instant");
  return parsed;
}

export function createRunRequest(
  manifest: TerminalManifest,
  contractVersion: string = REGISTRATION_CONTRACT_VERSION,
): CreateRunRequest {
  const sourceId = coreSourceId(manifest.source);
  if (sourceId === null) fail("unknown_source");
  return {
    producerId: identifier(manifest.producer, "producer_id_invalid"),
    sourceId: identifier(sourceId, "source_id_invalid"),
    externalIdNamespace: EXTERNAL_ID_NAMESPACE,
    // One acquisition session that visited several sources keeps one ref, and
    // each source stays its own run under it (03 §3). A run with no session
    // ref is its own session, which is the honest reading of "this collector
    // went once".
    externalSessionId: manifest.acquisitionSessionRef ?? manifest.runId,
    // The contract version is part of the run key, so a changed derivation
    // registers a second run rather than reusing rows that meant something
    // else.
    sourceRunKey: `${manifest.runId}:${contractVersion}`,
  };
}

export function unitRequest(unit: TerminalUnit): AddUnitRequest {
  return {
    unitKind: unit.unitKind,
    unitKey: unit.unitKey,
    // The manifest states a per-unit coverage and possibly a failure, so the
    // unit's terminal report is required rather than optional.
    terminalReportRequired: true,
  };
}

/**
 * The per-unit outcome. A unit that named a safe error code failed, a unit
 * that claims complete coverage succeeded, and anything in between is
 * `partial` — never `success`.
 */
export function unitReportRequest(
  unit: TerminalUnit,
  manifest: TerminalManifest,
): AddUnitReportRequest {
  const outcome: NormalizedOutcome =
    unit.safeErrorCode !== undefined
      ? "failed"
      : unit.coverageStatus === "complete"
        ? "success"
        : unit.coverageStatus === "partial"
          ? "partial"
          : "unknown";
  return {
    reportKey: `unit:${unit.unitKey}`,
    reportKind: "terminal",
    normalizedOutcome: outcome,
    startedAtMs: instantMs(manifest.startedAt),
    startedAtBasis: "manifest",
    completedAtMs: instantMs(manifest.completedAt),
    completedAtBasis: "manifest",
    declaredArtifactCount: unit.artifactCount,
    artifactCountScope: "direct",
    ...(unit.safeErrorCode === undefined ? {} : { safeFailureCode: unit.safeErrorCode }),
  };
}

/** The run's own terminal report: what the collector said it did, unwidened. */
export function runReportRequest(manifest: TerminalManifest): AddRunReportRequest {
  return {
    reportKey: "terminal",
    reportKind: "terminal",
    producerVersion: manifest.producerVersion,
    manifestSchemaVersion: manifest.manifestVersion,
    producerStatus: manifest.providerOutcome,
    normalizedOutcome: manifest.providerOutcome,
    startedAtMs: instantMs(manifest.startedAt),
    startedAtBasis: "manifest",
    completedAtMs: instantMs(manifest.completedAt),
    completedAtBasis: "manifest",
    declaredArtifactCount: manifest.artifacts.length,
    // Everything the manifest lists is catalogued; it is not a claim about
    // what the provider holds.
    artifactCountScope: "all_catalogued",
  };
}

export function runRangeRequests(manifest: TerminalManifest): AddRunRangeRequest[] {
  return manifest.ranges.map((range) => ({
    rangeKey: range.rangeKey,
    rangeKind: range.rangeKind,
    precision: range.precision,
    basis: range.basis,
    startValue: range.startValue,
    endValue: range.endValue,
  }));
}

function artifactRole(value: string): ArtifactRole {
  if (!Object.hasOwn(ARTIFACT_ROLES, value)) fail("artifact_role_unknown");
  return value as ArtifactRole;
}

/**
 * The transformations whose output is this artifact, in a stable order. The
 * manifest already sorted them by id, so two readings of one terminal produce
 * the same step indices and therefore the same descriptor digest.
 */
function transformSteps(
  manifest: TerminalManifest,
  artifact: TerminalArtifact,
): TransformStepRequest[] {
  return manifest.transformations
    .filter((step) => step.outputArtifactKey === artifact.artifactKey)
    .map((step, index) => ({
      stepIndex: index,
      stepKind: step.stepKind,
      transformerId: identifier(step.transformerId, "transformer_id_invalid"),
      transformerVersion: step.transformerVersion,
    }));
}

/**
 * Lineage: an input that is itself an artifact of this run is linked; an input
 * that is not — the provider response a sanitizer consumed and nobody kept —
 * is recorded as unavailable rather than as a link to nothing.
 */
function lineage(
  manifest: TerminalManifest,
  artifact: TerminalArtifact,
): { disposition: LineageDisposition; relations: RelationClaimRequest[] } {
  const keys = new Set(manifest.artifacts.map((entry) => entry.artifactKey));
  const steps = manifest.transformations.filter(
    (step) => step.outputArtifactKey === artifact.artifactKey,
  );
  if (steps.length === 0) return { disposition: "not_applicable", relations: [] };
  const relations: RelationClaimRequest[] = [];
  let missing = false;
  for (const step of steps) {
    for (const input of step.inputArtifactKeys) {
      if (!keys.has(input)) {
        missing = true;
        continue;
      }
      relations.push({
        parentArtifactKey: input,
        relation: "input",
        transformerId: identifier(step.transformerId, "transformer_id_invalid"),
        transformerVersion: step.transformerVersion,
      });
    }
  }
  if (relations.length === 0) return { disposition: "source_bytes_not_available", relations: [] };
  return { disposition: missing ? "source_bytes_not_available" : "linked", relations };
}

/** What the transformation steps alone say about the bytes. */
function stepFidelity(steps: readonly TransformStepRequest[]): PayloadFidelity {
  const last = steps.at(-1);
  if (!last) return "exact";
  if (last.stepKind === "transport_decoded") return "transport_decoded";
  if (last.stepKind === "generated") return "generated";
  return "transformed";
}

/**
 * Fidelity and lineage, by role — the pairs CORE's `fetch_artifacts` CHECKKs
 * accept, derived from what the manifest states and never beyond it.
 *
 *  * provider roles carry the provider's bytes as they were (`exact`),
 *    decoded, or transformed with their inputs linked or not retained;
 *  * the collector's own outputs (`collector_manifest`, `collector_error`,
 *    `collector_summary`) are `generated`, whether or not the collector wrote
 *    a `generated` step for them; they have no lineage;
 *  * a sanitizer's output (`sanitized_provider_capture`) is always
 *    `transformed` and must state a `redacted` step; its input is linked
 *    when the manifest names a kept artifact, and otherwise recorded as not
 *    retained for security, which is what a redaction whose input nobody
 *    kept is;
 *  * `collector_derived` is `transformed` and must say what it was derived
 *    from; a derived artifact with no transformation is refused rather than
 *    given an invented lineage;
 *  * `user_capture` is `transformed` when a step says so, else `unknown`.
 */
function fidelityAndLineage(
  role: ArtifactRole,
  steps: readonly TransformStepRequest[],
  stated: { disposition: LineageDisposition; relations: RelationClaimRequest[] },
): {
  payloadFidelity: PayloadFidelity;
  lineageDisposition: LineageDisposition;
  relations: RelationClaimRequest[];
} {
  const fromSteps = stepFidelity(steps);
  switch (role) {
    case "collector_manifest":
    case "collector_error":
    case "collector_summary":
      return { payloadFidelity: "generated", lineageDisposition: "not_applicable", relations: [] };
    case "sanitized_provider_capture":
      // CORE refuses to seal a sanitized capture with no `redacted` step;
      // say so here, with a safe code, instead of at the seal.
      if (!steps.some((step) => step.stepKind === "redacted")) {
        fail("sanitized_capture_without_redaction");
      }
      return stated.disposition === "linked"
        ? {
            payloadFidelity: "transformed",
            lineageDisposition: "linked",
            relations: stated.relations,
          }
        : {
            payloadFidelity: "transformed",
            lineageDisposition: "source_not_retained_for_security",
            relations: [],
          };
    case "collector_derived":
      if (stated.disposition === "not_applicable") fail("artifact_lineage_unstated");
      return { payloadFidelity: "transformed", ...stated, lineageDisposition: stated.disposition };
    case "user_capture":
      return {
        payloadFidelity: steps.length === 0 ? "unknown" : "transformed",
        lineageDisposition: stated.disposition,
        relations: stated.relations,
      };
    default:
      // A provider role: the bytes are the provider's. A `generated` step on
      // them is a contradiction the manifest must not make.
      if (fromSteps === "generated") fail("artifact_fidelity_invalid");
      return {
        payloadFidelity: fromSteps,
        lineageDisposition: stated.disposition,
        relations: stated.relations,
      };
  }
}

/**
 * One artifact descriptor.
 *
 * No origin block is recorded. The manifest states the object's key in the
 * shared DATA bucket, and that key is `objects/<2 hex>/<sha256>`: it is
 * derived from the content and says nothing about where the bytes came from,
 * so there is no origin to sanitize and nothing to authorize against an
 * origin template policy. Provenance that *is* stated — the transformations —
 * is recorded above as steps and relations.
 */
export function artifactRequest(
  manifest: TerminalManifest,
  artifact: TerminalArtifact,
  unitIds: ReadonlyMap<string, number>,
  contractVersion: string = REGISTRATION_CONTRACT_VERSION,
): ArtifactRequest {
  const role = artifactRole(artifact.role);
  const steps = transformSteps(manifest, artifact);
  const { payloadFidelity, lineageDisposition, relations } = fidelityAndLineage(
    role,
    steps,
    lineage(manifest, artifact),
  );
  const fetchUnitId =
    artifact.unitKey === undefined ? null : (unitIds.get(artifact.unitKey) ?? null);
  if (artifact.unitKey !== undefined && fetchUnitId === null) fail("artifact_unit_unknown");
  // The closed per-source table (ADR 0022). An artifact it does not name
  // keeps no dataset and so does not inherit financial eligibility.
  const dataset = artifactDataset(manifest.source, artifact, contractVersion);
  return {
    artifactKey: artifact.artifactKey,
    ...(dataset === null ? {} : { dataset }),
    artifactRole: role,
    payloadFidelity,
    containerKind: "single",
    lineageDisposition,
    declaredMediaType: artifact.mediaType,
    mediaTypeBasis: "manifest",
    fetchedAtMs: instantMs(manifest.completedAt),
    fetchedAtBasis: "manifest",
    fetchUnitId,
    sha256: artifact.sha256,
    byteSize: artifact.byteSize,
    ...(steps.length === 0 ? {} : { transformSteps: steps }),
    ...(relations.length === 0 ? {} : { relations }),
  };
}
