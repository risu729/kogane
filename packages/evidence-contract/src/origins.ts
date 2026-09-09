// Artifact origin schemas: wire (request) types, canonical (validated) types,
// and the shared runtime parser. Every field of every origin is hashed into
// the descriptor digest, so these shapes are frozen for descriptor-v1.
import { binaryCompare, type JsonObject } from "./json";
import {
  ContractError,
  SHA256,
  arrayValue,
  enumValue,
  exactKeys,
  integerValue,
  object,
  requiredEnum,
  requiredString,
  stringValue,
} from "./validate";

export type HttpScheme = "http" | "https";
export type StorageTimeBasis = "storage_metadata" | "manifest";
export type EmailReceivedAtBasis =
  | "delivery_internal_date"
  | "rfc_date"
  | "forwarded_inner_date"
  | "operator"
  | "unknown";
export type EmailTransportShape = "direct" | "forwarded_rfc822" | "unknown";

/** HTTP origin as a client may send it: optional keys may be omitted or null. */
export interface HttpOriginRequest {
  method?: string | null;
  status?: number | null;
  scheme: HttpScheme;
  host: string;
  port?: number | null;
  pathTemplate: string;
  queryNames?: string[];
  redactionVersion: string;
  urlFingerprint?: string | null;
  fingerprintKeyVersion?: string | null;
}

/** HTTP origin after server validation: every key present, host lower-cased, queryNames unique and sorted. */
export interface HttpOrigin {
  method: string | null;
  status: number | null;
  scheme: HttpScheme;
  host: string;
  port: number | null;
  pathTemplate: string;
  queryNames: string[];
  redactionVersion: string;
  urlFingerprint: string | null;
  fingerprintKeyVersion: string | null;
}

export interface StorageOriginRequest {
  storageKind: string;
  containerName: string;
  objectKeyTemplate: string;
  objectKeyFingerprint: string;
  fingerprintKeyVersion: string;
  redactionVersion: string;
  objectVersion?: string | null;
  etag?: string | null;
  lastModifiedAtMs?: number | null;
  lastModifiedAtBasis?: StorageTimeBasis | null;
}

export interface StorageOrigin {
  storageKind: string;
  containerName: string;
  objectKeyTemplate: string;
  objectKeyFingerprint: string;
  fingerprintKeyVersion: string;
  redactionVersion: string;
  objectVersion: string | null;
  etag: string | null;
  lastModifiedAtMs: number | null;
  lastModifiedAtBasis: StorageTimeBasis | null;
}

export interface FileOriginRequest {
  basenameTemplate: string;
  filenameFingerprint: string;
  fingerprintKeyVersion: string;
  redactionVersion: string;
  sourceModifiedAtMs?: number | null;
}

export interface FileOrigin {
  basenameTemplate: string;
  filenameFingerprint: string;
  fingerprintKeyVersion: string;
  redactionVersion: string;
  sourceModifiedAtMs: number | null;
}

export interface EmailOriginRequest {
  transportShape: EmailTransportShape;
  senderDomain?: string | null;
  receivedAtMs?: number | null;
  receivedAtBasis?: EmailReceivedAtBasis | null;
  messageIdSha256?: string | null;
  partIndex?: number | null;
  mimePartPath?: string | null;
  innerMessageSha256?: string | null;
  innerSenderDomain?: string | null;
  filenameTemplate?: string | null;
  filenameFingerprint?: string | null;
  fingerprintKeyVersion?: string | null;
  redactionVersion: string;
}

export interface EmailOrigin {
  transportShape: EmailTransportShape;
  senderDomain: string | null;
  receivedAtMs: number | null;
  receivedAtBasis: EmailReceivedAtBasis | null;
  messageIdSha256: string | null;
  partIndex: number | null;
  mimePartPath: string | null;
  innerMessageSha256: string | null;
  innerSenderDomain: string | null;
  filenameTemplate: string | null;
  filenameFingerprint: string | null;
  fingerprintKeyVersion: string | null;
  redactionVersion: string;
}

/** The four origin slots of a validated artifact; absent origins are null. */
export interface Origins {
  http: HttpOrigin | null;
  storage: StorageOrigin | null;
  file: FileOrigin | null;
  email: EmailOrigin | null;
}

export const HTTP_ORIGIN_KEYS = [
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
] as const;

export const STORAGE_ORIGIN_KEYS = [
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
] as const;

export const FILE_ORIGIN_KEYS = [
  "basenameTemplate",
  "filenameFingerprint",
  "fingerprintKeyVersion",
  "redactionVersion",
  "sourceModifiedAtMs",
] as const;

export const EMAIL_ORIGIN_KEYS = [
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
] as const;

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
    throw new ContractError(`invalid_${field}`);
  }
  return normalized;
}

function safeTemplate(value: unknown, field: string, max: number, basename = false): string {
  const template = requiredString(value, field, { max });
  if (
    /[\r\n]/.test(template) ||
    template.includes("?") ||
    template.includes("#") ||
    (basename && /[\\/]/.test(template))
  ) {
    throw new ContractError(`invalid_${field}`);
  }
  return template;
}

function optionalObject(value: unknown, field: string): JsonObject | null {
  if (value === undefined || value === null) return null;
  try {
    return object(value);
  } catch {
    throw new ContractError(`invalid_${field}`);
  }
}

/** Validate the four origin slots of an artifact request body. */
export function parseOrigins(input: JsonObject): Origins {
  return {
    http: parseHttp(optionalObject(input.http, "http")),
    storage: parseStorage(optionalObject(input.storage, "storage")),
    file: parseFile(optionalObject(input.file, "file")),
    email: parseEmail(optionalObject(input.email, "email")),
  };
}

function parseHttp(value: JsonObject | null): HttpOrigin | null {
  if (!value) return null;
  exactKeys(value, HTTP_ORIGIN_KEYS);
  const queryNames = arrayValue(value.queryNames, "query_names").map((entry) =>
    requiredString(entry, "query_name", { max: 100 }),
  );
  if (queryNames.some((name) => !/^[A-Za-z][A-Za-z0-9_.-]{0,99}$/.test(name))) {
    throw new ContractError("invalid_query_name");
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
    throw new ContractError("http_fingerprint_pair_mismatch");
  }
  const method = stringValue(value.method, "http_method", { optional: true, max: 20 });
  if (method !== null && !/^[A-Z]+$/.test(method)) {
    throw new ContractError("invalid_http_method");
  }
  const status = integerValue(value.status, "http_status", true);
  if (status !== null && (status < 100 || status > 599)) {
    throw new ContractError("invalid_http_status");
  }
  const port = integerValue(value.port, "http_port", true);
  if (port !== null && (port < 1 || port > 65535)) throw new ContractError("invalid_http_port");
  const pathTemplate = safeTemplate(value.pathTemplate, "path_template", 1000);
  if (!pathTemplate.startsWith("/")) throw new ContractError("invalid_path_template");
  return {
    method,
    status,
    scheme: requiredEnum(value.scheme, "http_scheme", ["http", "https"] as const),
    host: safeDomain(value.host, "http_host") as string,
    port,
    pathTemplate,
    queryNames: [...new Set(queryNames)].sort(binaryCompare),
    redactionVersion: requiredString(value.redactionVersion, "redaction_version", { max: 100 }),
    urlFingerprint,
    fingerprintKeyVersion,
  };
}

function parseStorage(value: JsonObject | null): StorageOrigin | null {
  if (!value) return null;
  exactKeys(value, STORAGE_ORIGIN_KEYS);
  const lastModifiedAtMs = integerValue(value.lastModifiedAtMs, "last_modified_at_ms", true);
  const lastModifiedAtBasis = enumValue(
    value.lastModifiedAtBasis,
    "last_modified_at_basis",
    ["storage_metadata", "manifest"] as const,
    true,
  );
  if ((lastModifiedAtMs === null) !== (lastModifiedAtBasis === null)) {
    throw new ContractError("storage_time_pair_mismatch");
  }
  return {
    storageKind: requiredString(value.storageKind, "storage_kind", { max: 40 }),
    containerName: requiredString(value.containerName, "container_name", { max: 200 }),
    objectKeyTemplate: (() => {
      const template = requiredString(value.objectKeyTemplate, "object_key_template", {
        max: 1000,
      });
      if (template.includes("://") || /[\r\n]/.test(template)) {
        throw new ContractError("invalid_object_key_template");
      }
      return template;
    })(),
    objectKeyFingerprint: requiredString(value.objectKeyFingerprint, "object_key_fingerprint", {
      pattern: SHA256,
    }),
    fingerprintKeyVersion: requiredString(value.fingerprintKeyVersion, "fingerprint_key_version", {
      max: 100,
    }),
    redactionVersion: requiredString(value.redactionVersion, "redaction_version", { max: 100 }),
    objectVersion: stringValue(value.objectVersion, "object_version", { optional: true, max: 500 }),
    etag: stringValue(value.etag, "etag", { optional: true, max: 500 }),
    lastModifiedAtMs,
    lastModifiedAtBasis,
  };
}

function parseFile(value: JsonObject | null): FileOrigin | null {
  if (!value) return null;
  exactKeys(value, FILE_ORIGIN_KEYS);
  return {
    basenameTemplate: safeTemplate(value.basenameTemplate, "basename_template", 500, true),
    filenameFingerprint: requiredString(value.filenameFingerprint, "filename_fingerprint", {
      pattern: SHA256,
    }),
    fingerprintKeyVersion: requiredString(value.fingerprintKeyVersion, "fingerprint_key_version", {
      max: 100,
    }),
    redactionVersion: requiredString(value.redactionVersion, "redaction_version", { max: 100 }),
    sourceModifiedAtMs: integerValue(value.sourceModifiedAtMs, "source_modified_at_ms", true),
  };
}

function parseEmail(value: JsonObject | null): EmailOrigin | null {
  if (!value) return null;
  exactKeys(value, EMAIL_ORIGIN_KEYS);
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
    throw new ContractError("email_field_pair_mismatch");
  }
  return {
    transportShape: requiredEnum(value.transportShape, "transport_shape", [
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
        throw new ContractError("invalid_mime_part_path");
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
    redactionVersion: requiredString(value.redactionVersion, "redaction_version", { max: 100 }),
  };
}
