import {
  ApiError,
  SHA256,
  arrayValue,
  enumValue,
  exactKeys,
  integerValue,
  object,
  stringValue,
  type RecordValue,
  type WorkerEnv,
} from "./http";
import { binaryCompare } from "./canonical";

export interface Origins {
  http: RecordValue | null;
  storage: RecordValue | null;
  file: RecordValue | null;
  email: RecordValue | null;
}

function safeDomain(value: unknown, field: string, optional = false): string | null {
  const domain = stringValue(value, field, { optional, max: 253 });
  if (domain === null) return null;
  const normalized = domain.toLowerCase();
  if (
    !/^[a-z0-9.-]+$/.test(normalized) ||
    normalized.startsWith(".") ||
    normalized.endsWith(".") ||
    normalized.includes("..")
  ) {
    throw new ApiError(400, `invalid_${field}`);
  }
  return normalized;
}

function safeTemplate(value: unknown, field: string, max: number, basename = false): string {
  const template = stringValue(value, field, { max })!;
  if (
    /[\r\n]/.test(template) ||
    template.includes("?") ||
    template.includes("#") ||
    (basename && /[\\/]/.test(template))
  ) {
    throw new ApiError(400, `invalid_${field}`);
  }
  return template;
}

function optionalObject(value: unknown, field: string): RecordValue | null {
  if (value === undefined || value === null) return null;
  try {
    return object(value);
  } catch {
    throw new ApiError(400, `invalid_${field}`);
  }
}

export function parseOrigins(input: RecordValue): Origins {
  return {
    http: parseHttp(optionalObject(input.http, "http")),
    storage: parseStorage(optionalObject(input.storage, "storage")),
    file: parseFile(optionalObject(input.file, "file")),
    email: parseEmail(optionalObject(input.email, "email")),
  };
}

function parseHttp(value: RecordValue | null): RecordValue | null {
  if (!value) return null;
  exactKeys(value, [
    "method",
    "status",
    "scheme",
    "host",
    "port",
    "pathTemplate",
    "queryNames",
    "redactionVersion",
    "urlFingerprint",
    "fingerprintKeyVersion",
  ]);
  const queryNames = arrayValue(value.queryNames, "query_names").map((entry) =>
    stringValue(entry, "query_name", { max: 100 })!,
  );
  if (queryNames.some((name) => !/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(name))) {
    throw new ApiError(400, "invalid_query_name");
  }
  const urlFingerprint = stringValue(value.urlFingerprint, "url_fingerprint", {
    optional: true,
    pattern: SHA256,
  });
  const fingerprintKeyVersion = stringValue(
    value.fingerprintKeyVersion,
    "fingerprint_key_version",
    { optional: true, max: 100 },
  );
  if ((urlFingerprint === null) !== (fingerprintKeyVersion === null)) {
    throw new ApiError(400, "http_fingerprint_pair_mismatch");
  }
  const method = stringValue(value.method, "http_method", { optional: true, max: 20 });
  if (method !== null && !/^[A-Z]+$/.test(method)) throw new ApiError(400, "invalid_http_method");
  const status = integerValue(value.status, "http_status", true);
  if (status !== null && (status < 100 || status > 599))
    throw new ApiError(400, "invalid_http_status");
  const port = integerValue(value.port, "http_port", true);
  if (port !== null && (port < 1 || port > 65535)) throw new ApiError(400, "invalid_http_port");
  const pathTemplate = safeTemplate(value.pathTemplate, "path_template", 1000);
  if (!pathTemplate.startsWith("/")) throw new ApiError(400, "invalid_path_template");
  return {
    method,
    status,
    scheme: enumValue(value.scheme, "http_scheme", ["http", "https"] as const),
    host: safeDomain(value.host, "http_host"),
    port,
    pathTemplate,
    queryNames: [...new Set(queryNames)].sort(binaryCompare),
    redactionVersion: stringValue(value.redactionVersion, "redaction_version", { max: 100 }),
    urlFingerprint,
    fingerprintKeyVersion,
  };
}

function parseStorage(value: RecordValue | null): RecordValue | null {
  if (!value) return null;
  exactKeys(value, [
    "storageKind",
    "containerName",
    "objectKeyTemplate",
    "objectKeyFingerprint",
    "fingerprintKeyVersion",
    "redactionVersion",
    "objectVersion",
    "etag",
    "lastModifiedAtMs",
    "lastModifiedAtBasis",
  ]);
  const lastModifiedAtMs = integerValue(value.lastModifiedAtMs, "last_modified_at_ms", true);
  const lastModifiedAtBasis = enumValue(
    value.lastModifiedAtBasis,
    "last_modified_at_basis",
    ["storage_metadata", "manifest"] as const,
    true,
  );
  if ((lastModifiedAtMs === null) !== (lastModifiedAtBasis === null)) {
    throw new ApiError(400, "storage_time_pair_mismatch");
  }
  return {
    storageKind: stringValue(value.storageKind, "storage_kind", { max: 40 }),
    containerName: stringValue(value.containerName, "container_name", { max: 200 }),
    objectKeyTemplate: (() => {
      const template = stringValue(value.objectKeyTemplate, "object_key_template", { max: 1000 })!;
      if (template.includes("://") || /[\r\n]/.test(template)) {
        throw new ApiError(400, "invalid_object_key_template");
      }
      return template;
    })(),
    objectKeyFingerprint: stringValue(value.objectKeyFingerprint, "object_key_fingerprint", {
      pattern: SHA256,
    }),
    fingerprintKeyVersion: stringValue(value.fingerprintKeyVersion, "fingerprint_key_version", {
      max: 100,
    }),
    redactionVersion: stringValue(value.redactionVersion, "redaction_version", { max: 100 }),
    objectVersion: stringValue(value.objectVersion, "object_version", { optional: true, max: 500 }),
    etag: stringValue(value.etag, "etag", { optional: true, max: 500 }),
    lastModifiedAtMs,
    lastModifiedAtBasis,
  };
}

function parseFile(value: RecordValue | null): RecordValue | null {
  if (!value) return null;
  exactKeys(value, [
    "basenameTemplate",
    "filenameFingerprint",
    "fingerprintKeyVersion",
    "redactionVersion",
    "sourceModifiedAtMs",
  ]);
  return {
    basenameTemplate: safeTemplate(value.basenameTemplate, "basename_template", 500, true),
    filenameFingerprint: stringValue(value.filenameFingerprint, "filename_fingerprint", {
      pattern: SHA256,
    }),
    fingerprintKeyVersion: stringValue(value.fingerprintKeyVersion, "fingerprint_key_version", {
      max: 100,
    }),
    redactionVersion: stringValue(value.redactionVersion, "redaction_version", { max: 100 }),
    sourceModifiedAtMs: integerValue(value.sourceModifiedAtMs, "source_modified_at_ms", true),
  };
}

function parseEmail(value: RecordValue | null): RecordValue | null {
  if (!value) return null;
  exactKeys(value, [
    "transportShape",
    "senderDomain",
    "receivedAtMs",
    "receivedAtBasis",
    "messageIdSha256",
    "partIndex",
    "mimePartPath",
    "innerMessageSha256",
    "innerSenderDomain",
    "filenameTemplate",
    "filenameFingerprint",
    "fingerprintKeyVersion",
    "redactionVersion",
  ]);
  const receivedAtMs = integerValue(value.receivedAtMs, "received_at_ms", true);
  const receivedAtBasis = enumValue(
    value.receivedAtBasis,
    "received_at_basis",
    ["delivery_internal_date", "rfc_date", "forwarded_inner_date", "operator", "unknown"] as const,
    true,
  );
  const filenameTemplate =
    value.filenameTemplate === undefined || value.filenameTemplate === null
      ? null
      : safeTemplate(value.filenameTemplate, "filename_template", 500, true);
  const filenameFingerprint = stringValue(value.filenameFingerprint, "filename_fingerprint", {
    optional: true,
    pattern: SHA256,
  });
  const fingerprintKeyVersion = stringValue(
    value.fingerprintKeyVersion,
    "fingerprint_key_version",
    { optional: true, max: 100 },
  );
  if (
    (receivedAtMs === null) !== (receivedAtBasis === null) ||
    (filenameTemplate === null) !== (filenameFingerprint === null) ||
    (filenameFingerprint === null) !== (fingerprintKeyVersion === null)
  ) {
    throw new ApiError(400, "email_field_pair_mismatch");
  }
  return {
    transportShape: enumValue(value.transportShape, "transport_shape", [
      "direct",
      "forwarded_rfc822",
      "unknown",
    ] as const),
    senderDomain: safeDomain(value.senderDomain, "sender_domain", true),
    receivedAtMs,
    receivedAtBasis,
    messageIdSha256: stringValue(value.messageIdSha256, "message_id_sha256", {
      optional: true,
      pattern: SHA256,
    }),
    partIndex: integerValue(value.partIndex, "part_index", true),
    mimePartPath: (() => {
      const path = stringValue(value.mimePartPath, "mime_part_path", { optional: true, max: 200 });
      if (path !== null && !/^\d+(\.\d+)*$/.test(path)) {
        throw new ApiError(400, "invalid_mime_part_path");
      }
      return path;
    })(),
    innerMessageSha256: stringValue(value.innerMessageSha256, "inner_message_sha256", {
      optional: true,
      pattern: SHA256,
    }),
    innerSenderDomain: safeDomain(value.innerSenderDomain, "inner_sender_domain", true),
    filenameTemplate,
    filenameFingerprint,
    fingerprintKeyVersion,
    redactionVersion: stringValue(value.redactionVersion, "redaction_version", { max: 100 }),
  };
}

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
        value.scheme as string,
        value.host as string,
        value.port as number | null,
        value.pathTemplate as string,
      ))
    )
      throw new ApiError(403, "http_scope_denied");
    await requireTemplatePolicy(
      env,
      sourceId,
      "http",
      value.pathTemplate as string,
      value.redactionVersion as string,
      (value.fingerprintKeyVersion as string | null) ?? "",
      JSON.stringify(value.queryNames),
    );
  }
  if (origins.storage) {
    const value = origins.storage;
    await requireTemplatePolicy(
      env,
      sourceId,
      "storage",
      value.objectKeyTemplate as string,
      value.redactionVersion as string,
      value.fingerprintKeyVersion as string,
    );
  }
  if (origins.file) {
    const value = origins.file;
    await requireTemplatePolicy(
      env,
      sourceId,
      "file",
      value.basenameTemplate as string,
      value.redactionVersion as string,
      value.fingerprintKeyVersion as string,
    );
  }
  if (origins.email?.filenameTemplate) {
    const value = origins.email;
    await requireTemplatePolicy(
      env,
      sourceId,
      "email",
      value.filenameTemplate as string,
      value.redactionVersion as string,
      value.fingerprintKeyVersion as string,
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
