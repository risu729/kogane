// Origin schema validation moved to the shared evidence-contract package
// (parseOrigins). This module keeps the parts that need the database: scope
// and template-policy authorization, and the metadata inserts.
import type { Origins } from "../../../packages/evidence-contract/src/origins";
import { ApiError, type WorkerEnv } from "./http";

export { parseOrigins, type Origins } from "../../../packages/evidence-contract/src/origins";

async function httpScopeAllowed(
  env: WorkerEnv,
  sourceId: string,
  scheme: string,
  host: string,
  port: number | null,
  path: string,
): Promise<boolean> {
  const result = await env.DB.prepare(`
    SELECT action, scheme, host, include_subdomains, port, path_prefix
    FROM http_scope_rules WHERE source_id IS NULL OR source_id = ?
  `)
    .bind(sourceId)
    .all<{
      action: "allow" | "deny";
      scheme: string | null;
      host: string;
      include_subdomains: number;
      port: number | null;
      path_prefix: string;
    }>();
  let allowed = false;
  for (const rule of result.results) {
    const hostMatches =
      host === rule.host || (rule.include_subdomains === 1 && host.endsWith(`.${rule.host}`));
    const matches =
      hostMatches &&
      (!rule.scheme || rule.scheme === scheme) &&
      (rule.port === null || rule.port === port) &&
      path.startsWith(rule.path_prefix);
    if (matches && rule.action === "deny") return false;
    if (matches && rule.action === "allow") allowed = true;
  }
  return allowed;
}

export async function validateOriginScope(
  env: WorkerEnv,
  sourceId: string,
  origins: Origins,
): Promise<void> {
  if (origins.http) {
    const value = origins.http;
    if (
      !(await httpScopeAllowed(
        env,
        sourceId,
        value.scheme,
        value.host,
        value.port,
        value.pathTemplate,
      ))
    )
      throw new ApiError(403, "http_scope_denied");
    await requireTemplatePolicy(
      env,
      sourceId,
      "http",
      value.pathTemplate,
      value.redactionVersion,
      value.fingerprintKeyVersion ?? "",
      JSON.stringify(value.queryNames),
    );
  }
  if (origins.storage) {
    const value = origins.storage;
    await requireTemplatePolicy(
      env,
      sourceId,
      "storage",
      value.objectKeyTemplate,
      value.redactionVersion,
      value.fingerprintKeyVersion,
    );
  }
  if (origins.file) {
    const value = origins.file;
    await requireTemplatePolicy(
      env,
      sourceId,
      "file",
      value.basenameTemplate,
      value.redactionVersion,
      value.fingerprintKeyVersion,
    );
  }
  const emailTemplate = origins.email?.filenameTemplate;
  if (origins.email && emailTemplate) {
    // The parser guarantees the template / fingerprint / key-version triple is
    // either all present or all absent.
    await requireTemplatePolicy(
      env,
      sourceId,
      "email",
      emailTemplate,
      origins.email.redactionVersion,
      origins.email.fingerprintKeyVersion as string,
    );
  }
}

async function requireTemplatePolicy(
  env: WorkerEnv,
  sourceId: string,
  originKind: string,
  template: string,
  redactionVersion: string,
  fingerprintKeyVersion: string,
  queryNamesJson = "[]",
): Promise<void> {
  const allowed = await env.DB.prepare(`
    SELECT 1 AS ok FROM origin_template_policies
    WHERE source_id = ? AND origin_kind = ? AND template = ?
      AND redaction_version = ? AND fingerprint_key_version = ? AND active = 1
      AND query_names_json = ?
  `)
    .bind(sourceId, originKind, template, redactionVersion, fingerprintKeyVersion, queryNamesJson)
    .first<{ ok: number }>();
  if (!allowed) throw new ApiError(403, "origin_template_denied");
}

export function originStatements(
  env: WorkerEnv,
  runId: number,
  artifactKey: string,
  origins: Origins,
): D1PreparedStatement[] {
  const statements: D1PreparedStatement[] = [];
  if (origins.http) {
    const value = origins.http;
    statements.push(
      env.DB.prepare(`
      INSERT INTO artifact_http_metadata (
        fetch_artifact_id, method, status, scheme, host, port, path_template,
        query_names_json, redaction_version, url_fingerprint, fingerprint_key_version
      ) SELECT id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM fetch_artifacts
      WHERE fetch_run_id = ? AND artifact_key = ?
    `).bind(
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
      env.DB.prepare(`
      INSERT INTO artifact_storage_metadata (
        fetch_artifact_id, storage_kind, container_name, object_key_template,
        object_key_fingerprint, fingerprint_key_version, redaction_version,
        object_version, etag, last_modified_at_ms, last_modified_at_basis
      ) SELECT id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM fetch_artifacts
      WHERE fetch_run_id = ? AND artifact_key = ?
    `).bind(
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
      env.DB.prepare(`
      INSERT INTO artifact_file_metadata (
        fetch_artifact_id, basename_template, filename_fingerprint,
        fingerprint_key_version, redaction_version, source_modified_at_ms
      ) SELECT id, ?, ?, ?, ?, ? FROM fetch_artifacts
      WHERE fetch_run_id = ? AND artifact_key = ?
    `).bind(
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
      env.DB.prepare(`
      INSERT INTO artifact_email_metadata (
        fetch_artifact_id, transport_shape, sender_domain, received_at_ms, received_at_basis,
        message_id_sha256, part_index, mime_part_path, inner_message_sha256, inner_sender_domain,
        filename_template, filename_fingerprint, fingerprint_key_version, redaction_version
      ) SELECT id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ? FROM fetch_artifacts
      WHERE fetch_run_id = ? AND artifact_key = ?
    `).bind(
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
