// Transformation identity: manifests, release ids and input fingerprints
// (design review D03, A04; docs/release-adoption.md).
//
// `parser.version` stays the human-readable change note. What identifies the
// transformation is the `TransformManifest` of packages/domain: the parser's
// build digest, the contract versions, the metadata extractor release and the
// digests of the shared modules it depends on. Two runs of the same manifest
// over the same evidence must produce the same result, and that is exactly
// what `input_fingerprint` states.
//
// The digest range is deliberately narrower than a repository commit: the
// parser module and the local modules it imports (poc/observation-pipeline
// scripts/parser-digests.ts computes it). A UI change must not invalidate
// every historical parse; a change to a shared parsing helper must.
import { PARSER_DIGESTS, PARSERS } from "../../../poc/observation-pipeline/src/parsers/registry.ts";
import type { ArtifactMeta, Parser } from "../../../poc/observation-pipeline/src/types.ts";
import {
  canonicalDigest,
  validTransformManifest,
  type TransformManifest,
} from "../../../packages/domain/src/context.ts";
import {
  LEGACY_METADATA_RELEASE,
  type MetadataExtractorRelease,
} from "./metadata-extractors/index.ts";

/** The metadata a parser may read besides the raw bytes (`ArtifactMeta`). */
export const PARSER_INPUT_CONTRACT_VERSION = "artifact-meta-v1";
/** Observations plus typed issues and coverage claims (contract v2, A03). */
export const PARSER_OUTPUT_CONTRACT_VERSION = "parse-result-v2";

/** Release ids are used as `observation_parse_jobs.target_release`, so they
 * must satisfy that route's pattern: letters, digits, dot, underscore, dash. */
export const RELEASE_ID_PATTERN = /^[A-Za-z0-9._-]{1,100}$/u;

export interface ReleaseRow {
  release_id: string;
  parser_name: string;
  semantic_version: string;
  code_digest: string;
  input_contract_version: string;
  output_contract_version: string;
  metadata_extractor_release: string;
  dependency_digests_json: string;
  registered_at: string;
}

export function transformManifest(
  parser: Pick<Parser, "name" | "version">,
  metadataExtractorRelease: MetadataExtractorRelease = LEGACY_METADATA_RELEASE,
): TransformManifest {
  // The digest is a property of the parser module, so a build that deploys a
  // second version of the same parser (the candidate lane) reuses it and is
  // told apart by the semantic version inside the manifest. That the recorded
  // version matches the deployed one is checked in CI
  // (poc/observation-pipeline/test/parser-digests.test.ts), not here, so a
  // registry carrying two versions of one parser still resolves.
  const recorded = PARSER_DIGESTS.releases[parser.name];
  if (!recorded) throw new Error("parser_release_unknown");
  return {
    transformerId: parser.name,
    semanticVersion: parser.version,
    codeDigest: recorded.codeDigest,
    inputContractVersion: PARSER_INPUT_CONTRACT_VERSION,
    outputContractVersion: PARSER_OUTPUT_CONTRACT_VERSION,
    metadataExtractorRelease,
    dependencyDigests: Object.fromEntries(
      recorded.sources.map((path) => [path, PARSER_DIGESTS.sourceDigests[path]!]),
    ),
  };
}

export interface ParserReleaseIdentity {
  releaseId: string;
  manifest: TransformManifest;
  manifestDigest: string;
}

/** A release id names the manifest, not the deployment: the same parser code
 * with a different metadata extractor release is a different release. */
export async function releaseIdentity(
  parser: Pick<Parser, "name" | "version">,
  metadataExtractorRelease: MetadataExtractorRelease = LEGACY_METADATA_RELEASE,
): Promise<ParserReleaseIdentity> {
  const manifest = transformManifest(parser, metadataExtractorRelease);
  if (!validTransformManifest(manifest)) throw new Error("parser_manifest_invalid");
  const manifestDigest = await canonicalDigest(manifest);
  const releaseId = `${parser.name}-${parser.version}-${manifestDigest.slice(0, 16)}`;
  if (!RELEASE_ID_PATTERN.test(releaseId)) throw new Error("parser_release_id_invalid");
  return { releaseId, manifest, manifestDigest };
}

/**
 * The parser-visible part of an artifact's metadata, canonicalised. Ids and
 * the raw digest are not here: the digest is a separate fingerprint input and
 * the row id is not an input at all.
 */
export function parserVisibleMetadata(meta: ArtifactMeta): Record<string, unknown> {
  return {
    artifactKey: meta.artifactKey ?? null,
    dataset: meta.dataset,
    fetchUnitKey: meta.fetchUnitKey ?? null,
    fetchedAt: meta.fetchedAt,
    mime: meta.mime,
    period: meta.period ?? null,
    runFailureCount: meta.runFailureCount,
    runStatus: meta.runStatus,
    runWindow: meta.runWindow ?? null,
    sourceId: meta.sourceId,
    statementState: meta.statementState ?? null,
    url: meta.url,
  };
}

/**
 * `H(raw digest, parser-visible metadata, transform manifest digest)`. Same
 * manifest and same evidence give the same fingerprint; a different metadata
 * extractor changes the metadata (or the manifest) and therefore the
 * fingerprint, which is how a re-extraction becomes a distinguishable input.
 */
export async function inputFingerprint(input: {
  rawSha256: string;
  meta: ArtifactMeta;
  manifestDigest: string;
}): Promise<string> {
  return canonicalDigest({
    manifestDigest: input.manifestDigest,
    parserVisibleMetadata: parserVisibleMetadata(input.meta),
    rawSha256: input.rawSha256,
    scheme: "parse-input-fingerprint-v1",
  });
}

export interface RegisteredRelease extends ParserReleaseIdentity {
  parser: Pick<Parser, "name" | "version">;
  metadataExtractorRelease: MetadataExtractorRelease;
}

/** Release identities of the deployed registry under one extractor release. */
export async function deployedReleases(
  metadataExtractorRelease: MetadataExtractorRelease = LEGACY_METADATA_RELEASE,
  parsers: readonly Pick<Parser, "name" | "version">[] = PARSERS,
): Promise<RegisteredRelease[]> {
  return Promise.all(
    parsers.map(async (parser) => ({
      parser: { name: parser.name, version: parser.version },
      metadataExtractorRelease,
      ...(await releaseIdentity(parser, metadataExtractorRelease)),
    })),
  );
}

export function releaseInsert(
  db: D1Database,
  release: RegisteredRelease,
  now: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT OR IGNORE INTO parser_releases(release_id,parser_name,semantic_version,code_digest,
        input_contract_version,output_contract_version,metadata_extractor_release,
        dependency_digests_json,registered_at) VALUES(?,?,?,?,?,?,?,?,?)`,
    )
    .bind(
      release.releaseId,
      release.manifest.transformerId,
      release.manifest.semanticVersion,
      release.manifest.codeDigest,
      release.manifest.inputContractVersion,
      release.manifest.outputContractVersion,
      release.manifest.metadataExtractorRelease,
      JSON.stringify(release.manifest.dependencyDigests),
      now,
    );
}

// One registration per isolate: the statements are idempotent, so this is a
// cheap guard against repeating a 30-row batch on every sweep, not a
// correctness condition.
let registered = false;

/**
 * Registers the deployed registry's releases. The `parser_releases` trigger of
 * migration 0028 refuses a second registration of the same name and version
 * with a different code digest, which is the review's short-term
 * compatibility rule enforced at deployment time.
 */
export async function registerDeployedReleases(
  db: D1Database,
  parsers: readonly Pick<Parser, "name" | "version">[] = PARSERS,
  force = false,
): Promise<number> {
  if (registered && !force) return 0;
  const now = new Date().toISOString();
  const releases = await deployedReleases(LEGACY_METADATA_RELEASE, parsers);
  const results = await db.batch(releases.map((release) => releaseInsert(db, release, now)));
  registered = true;
  return results.reduce((total, result) => total + result.meta.changes, 0);
}

/** Test seam: forget that this isolate already registered its releases. */
export function resetReleaseRegistration(): void {
  registered = false;
}

export async function lookupRelease(db: D1Database, releaseId: string): Promise<ReleaseRow | null> {
  if (!RELEASE_ID_PATTERN.test(releaseId)) return null;
  return db
    .prepare("SELECT * FROM parser_releases WHERE release_id=?")
    .bind(releaseId)
    .first<ReleaseRow>();
}

/**
 * The release normal job creation and normal parses use for one dataset, or
 * null when the dataset has no pointer and the deployed registry decides -
 * which is the behaviour of every Worker that predates migration 0028.
 */
export async function activeRelease(
  db: D1Database,
  scope: { sourceId: string; dataset: string | null; parserName: string },
): Promise<{ release_id: string; metadata_extractor_release: string } | null> {
  if (scope.dataset === null) return null;
  return db
    .prepare(
      "SELECT release_id,metadata_extractor_release FROM active_releases WHERE source_id=? AND dataset=? AND parser_name=?",
    )
    .bind(scope.sourceId, scope.dataset, scope.parserName)
    .first<{ release_id: string; metadata_extractor_release: string }>();
}
