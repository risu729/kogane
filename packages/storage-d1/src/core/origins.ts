// Where an artifact came from: the per-kind metadata rows (migration 0001)
// and the two authorization tables a catalogue write is checked against —
// `http_scope_rules` and `origin_template_policies` (migration 0002).
//
// This module holds only the database half. Deciding whether a scope rule set
// allows a URL, and which policy a given origin needs, is
// `packages/application/src/ingest/origins.ts`: the decision is the same
// wherever the origin arrives from, the rows are what CORE owns.
//
// Extracted from `services/raw-evidence/src/origins.ts` by U05; SQL unchanged.
import type { Origins } from "../../../evidence-contract/src/origins.ts";
import type { D1Like, D1StatementLike } from "../d1.ts";

export interface HttpScopeRule {
  action: "allow" | "deny";
  scheme: string | null;
  host: string;
  include_subdomains: number;
  port: number | null;
  path_prefix: string;
}

/** Every rule that can bear on this source: the global ones and its own. */
export async function readHttpScopeRules(
  db: D1Like,
  sourceId: string,
): Promise<HttpScopeRule[]> {
  const result = await db
    .prepare(
      `
    SELECT action, scheme, host, include_subdomains, port, path_prefix
    FROM http_scope_rules WHERE source_id IS NULL OR source_id = ?
  `,
    )
    .bind(sourceId)
    .all<HttpScopeRule>();
  return result.results;
}

/**
 * Whether an active policy authorizes exactly this template with exactly this
 * redaction and fingerprint key version. Every field is part of the key: a
 * template approved under one redaction version is not approved under another.
 */
export async function templatePolicyActive(
  db: D1Like,
  sourceId: string,
  originKind: string,
  template: string,
  redactionVersion: string,
  fingerprintKeyVersion: string,
  queryNamesJson = "[]",
): Promise<boolean> {
  const allowed = await db
    .prepare(
      `
    SELECT 1 AS ok FROM origin_template_policies
    WHERE source_id = ? AND origin_kind = ? AND template = ?
      AND redaction_version = ? AND fingerprint_key_version = ? AND active = 1
      AND query_names_json = ?
  `,
    )
    .bind(sourceId, originKind, template, redactionVersion, fingerprintKeyVersion, queryNamesJson)
    .first<{ ok: number }>();
  return allowed !== null;
}

/**
 * The metadata inserts for one artifact's origins, as statements of the
 * catalogue batch. Each selects the artifact row by (run, key), so it writes
 * only if the artifact insert in the same batch did.
 */
export function originStatements(
  db: D1Like,
  runId: number,
  artifactKey: string,
  origins: Origins,
): D1StatementLike[] {
  const statements: D1StatementLike[] = [];
  if (origins.http) {
    const value = origins.http;
    statements.push(
      db
        .prepare(
          `
      INSERT INTO artifact_http_metadata (
        fetch_artifact_id, method, status, scheme, host, port, path_template,
        query_names_json, redaction_version, url_fingerprint, fingerprint_key_version
      ) SELECT id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM fetch_artifacts
      WHERE fetch_run_id = ? AND artifact_key = ?
    `,
        )
        .bind(
          value.method,
          value.status,
          value.scheme,
          value.host,
          value.port,
          value.pathTemplate,
          JSON.stringify(value.queryNames),
          value.redactionVersion,
          value.urlFingerprint,
          value.fingerprintKeyVersion,
          runId,
          artifactKey,
        ),
    );
  }
  if (origins.storage) {
    const value = origins.storage;
    statements.push(
      db
        .prepare(
          `
      INSERT INTO artifact_storage_metadata (
        fetch_artifact_id, storage_kind, container_name, object_key_template,
        object_key_fingerprint, fingerprint_key_version, redaction_version,
        object_version, etag, last_modified_at_ms, last_modified_at_basis
      ) SELECT id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM fetch_artifacts
      WHERE fetch_run_id = ? AND artifact_key = ?
    `,
        )
        .bind(
          value.storageKind,
          value.containerName,
          value.objectKeyTemplate,
          value.objectKeyFingerprint,
          value.fingerprintKeyVersion,
          value.redactionVersion,
          value.objectVersion,
          value.etag,
          value.lastModifiedAtMs,
          value.lastModifiedAtBasis,
          runId,
          artifactKey,
        ),
    );
  }
  if (origins.file) {
    const value = origins.file;
    statements.push(
      db
        .prepare(
          `
      INSERT INTO artifact_file_metadata (
        fetch_artifact_id, basename_template, filename_fingerprint,
        fingerprint_key_version, redaction_version, source_modified_at_ms
      ) SELECT id, ?, ?, ?, ?, ? FROM fetch_artifacts
      WHERE fetch_run_id = ? AND artifact_key = ?
    `,
        )
        .bind(
          value.basenameTemplate,
          value.filenameFingerprint,
          value.fingerprintKeyVersion,
          value.redactionVersion,
          value.sourceModifiedAtMs,
          runId,
          artifactKey,
        ),
    );
  }
  if (origins.email) {
    const value = origins.email;
    statements.push(
      db
        .prepare(
          `
      INSERT INTO artifact_email_metadata (
        fetch_artifact_id, transport_shape, sender_domain, received_at_ms, received_at_basis,
        message_id_sha256, part_index, mime_part_path, inner_message_sha256, inner_sender_domain,
        filename_template, filename_fingerprint, fingerprint_key_version, redaction_version
      ) SELECT id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM fetch_artifacts
      WHERE fetch_run_id = ? AND artifact_key = ?
    `,
        )
        .bind(
          value.transportShape,
          value.senderDomain,
          value.receivedAtMs,
          value.receivedAtBasis,
          value.messageIdSha256,
          value.partIndex,
          value.mimePartPath,
          value.innerMessageSha256,
          value.innerSenderDomain,
          value.filenameTemplate,
          value.filenameFingerprint,
          value.fingerprintKeyVersion,
          value.redactionVersion,
          runId,
          artifactKey,
        ),
    );
  }
  return statements;
}
