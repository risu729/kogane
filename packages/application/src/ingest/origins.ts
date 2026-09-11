// Origin authorization: may this source record an artifact that came from
// this URL, object key, filename or mailbox, under this redaction policy?
//
// The rows are CORE (`packages/storage-d1/src/core/origins.ts`); the decision
// is here, because it is the same decision wherever the artifact arrives from.
// Both halves are deny-by-default: an origin with no matching allow rule, or
// with no active template policy for its exact template and versions, is
// refused rather than recorded unauthorized.
//
// Extracted from `services/raw-evidence/src/origins.ts` by U05.
import type { Origins } from "../../../evidence-contract/src/origins.ts";
import {
  readHttpScopeRules,
  templatePolicyActive,
  type HttpScopeRule,
} from "../../../storage-d1/src/core/origins.ts";
import { IngestError, type IngestEnv } from "./contract.ts";

export { parseOrigins, type Origins } from "../../../evidence-contract/src/origins.ts";

/**
 * Deny wins over allow, and nothing is allowed by default. A rule matches on
 * host (optionally including subdomains), scheme, port and path prefix.
 */
export function httpScopeAllowed(
  rules: readonly HttpScopeRule[],
  scheme: string,
  host: string,
  port: number | null,
  path: string,
): boolean {
  let allowed = false;
  for (const rule of rules) {
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
  env: IngestEnv,
  sourceId: string,
  origins: Origins,
): Promise<void> {
  if (origins.http) {
    const value = origins.http;
    const rules = await readHttpScopeRules(env.DB, sourceId);
    if (!httpScopeAllowed(rules, value.scheme, value.host, value.port, value.pathTemplate))
      throw new IngestError(403, "http_scope_denied");
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
  env: IngestEnv,
  sourceId: string,
  originKind: string,
  template: string,
  redactionVersion: string,
  fingerprintKeyVersion: string,
  queryNamesJson = "[]",
): Promise<void> {
  if (
    !(await templatePolicyActive(
      env.DB,
      sourceId,
      originKind,
      template,
      redactionVersion,
      fingerprintKeyVersion,
      queryNamesJson,
    ))
  )
    throw new IngestError(403, "origin_template_denied");
}
