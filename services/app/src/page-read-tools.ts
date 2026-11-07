// MCP reads of the web UI's read pages (ADR 0081 point 1): each tool here
// answers what one UI read route answers, by calling the same reader that
// route calls with the same request. The route and the tool are two adapters
// over one function, so they cannot disagree on a row, a page bound or a
// refusal code; this file only translates a closed tool argument into that
// reader's request and the reader's answer into a tool result.
//
// Authority: the UI serves these pages to a signed-in reader over the whole
// store (`readerGrant`). An agent reads them only with the matching agent
// capability over the whole store, so no grant reads more here than its
// capability already reaches elsewhere. A source- or account-scoped grant is
// refused, never served a filtered page: these readers have no grant scope.
//
// Provider-derived strings (labels, descriptions, names) are part of the
// route's answer, so the whole answer travels under `data`
// (docs/agent-api.md, "Untrusted content and leakage").
import { z } from "zod";
import {
  type AgentCapability,
  ERROR_STATUS,
  financialError,
  type Grant,
  grantAllows,
} from "../../../packages/application/src/index";
import {
  COLLECTION_QUALITY_MAX_OFFSET,
  COLLECTION_QUALITY_SOURCE,
} from "../../../packages/application/src/query/collection-quality.ts";
import type { ToolResult } from "./agent-service";
import { readCollectionQuality } from "./collection-quality-api";
import { HttpError } from "./http";
import { IDENTITY_COLLECTIONS } from "../../../packages/application/src/query/identity-pages.ts";
import { readIdentityCollection } from "./identity-api";
import { parseRequest } from "./ops-api";
import { catalogue } from "./read";

/** The result envelope of every page read: the route's answer, under `data`. */
const PAGE_READ_SCHEMA_VERSION = "kogane-page-read-v1";

/** An identity-page `source` or any other bounded free string the route accepts. */
const ROUTE_TEXT = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[^\u0000-\u001f]+$/u);
const OFFSET = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
/** A collection quality route's source segment, in the service's own grammar. */
const QUALITY_SOURCE = z.string().regex(COLLECTION_QUALITY_SOURCE);

interface PageReadTool<Schema extends z.ZodType> {
  title: string;
  description: string;
  schema: Schema;
  /** The agent capability that reaches this page, always over the whole store. */
  capability: AgentCapability;
  /** The UI route paths this tool answers, for the parity inventory. */
  routes: readonly string[];
  /**
   * The shared reader, called with the request the route would build, for the
   * caller's grant (already graded here: the capability over the whole store).
   */
  read(env: Env, input: z.infer<Schema>, grant: Grant): Promise<unknown>;
}

/** Query parameters from a tool argument: absent values stay absent, numbers are decimal text. */
function query(input: Record<string, string | number | undefined>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input))
    if (value !== undefined) params.set(key, String(value));
  return params;
}

function tool<Schema extends z.ZodType>(definition: PageReadTool<Schema>) {
  return definition;
}

const TOOLS = {
  "kogane.identity.read": tool({
    title: "Identity pages: connections, account and instrument mappings, coverage",
    description:
      "One page of the owner UI's identity read: `connections` (aggregator connections and the source accounts they hold), `accounts` or `instruments` (each source reference with its current mapping, label, status, reason, revision and first observation), or `coverage` (per source, how many eligible observations are organized and how they resolved). The same answer as GET /api/identity/<collection>, under records.read and a whole-store read grant. `identityRead` is `latest` (default) or `as-recorded`; `connections` takes no other argument. Read-only.",
    schema: z.strictObject({
      collection: z.enum(IDENTITY_COLLECTIONS),
      source: ROUTE_TEXT.optional(),
      offset: OFFSET.optional(),
      identityRead: z.enum(["latest", "as-recorded"]).optional(),
    }),
    capability: "records.read",
    routes: IDENTITY_COLLECTIONS.map((collection) => `/api/identity/${collection}`),
    read: (env, { collection, ...params }) =>
      readIdentityCollection(env, collection, query(params)),
  }),
  // Collection quality (ADR 0045; the account view ADR 0088): each tool is one
  // route, and calls its service with the request the route builds.
  "kogane.collection-quality.summary": tool({
    title: "Collection quality: jobs and sources",
    description:
      "Collection quality across the store (ADR 0045): every configured collection job with its enabled and supported settings, held lease, newest receipt and the runs it names as CORE has them, and the actual Alarm reservation where the relay answers; and every visible CORE source with its collectors, newest fetch run, never-registered terminals and closed reasons. The same answer as GET /api/collection-quality, under evidence.read and a whole-store read grant. Identifiers, times, counts and closed codes only; no amount. A missing stage is a reason, never a zero or a success. Takes no argument. Read-only.",
    schema: z.strictObject({}),
    capability: "evidence.read",
    routes: ["/api/collection-quality"],
    read: (env, input, grant) => readCollectionQuality(env, grant, "summary", input),
  }),
  "kogane.collection-quality.cells": tool({
    title: "Collection quality: one source's cells",
    description:
      "One page (500) of one source's collection quality cells (ADR 0045): per dataset, parser, fetch unit and period, the newest capture's run, unit, artifact, raw, parse and coverage facts, the current capture, the state (current, older-current, no-current) and closed reasons; `offset` pages on (coverage.nextOffset). The same answer as GET /api/collection-quality/<source>?offset=N, under evidence.read and a whole-store read grant. A fetch unit key is not an account; no amount; a period no capture has is not listed. Read-only.",
    schema: z.strictObject({
      source: QUALITY_SOURCE,
      offset: z.number().int().min(0).max(COLLECTION_QUALITY_MAX_OFFSET).optional(),
    }),
    capability: "evidence.read",
    routes: ["/api/collection-quality/:source"],
    read: (env, input, grant) => readCollectionQuality(env, grant, "cells", input),
  }),
  "kogane.collection-quality.accounts": tool({
    title: "Collection quality: one source's cells per account",
    description:
      "One source's collection quality cells regrouped by the accounts their newest or current capture's observations name (ADR 0088): per account its label, mapping statuses and data types (dataset, parser, observation kind), each with its periods, closed standing and reasons, and apart the cells no observation attributes to an account. The same answer as GET /api/collection-quality/<source>/accounts, under evidence.read and a whole-store read grant. A period no capture has is not listed and not claimed missing; nothing is inferred from a fetch unit key. Read-only.",
    schema: z.strictObject({ source: QUALITY_SOURCE }),
    capability: "evidence.read",
    routes: ["/api/collection-quality/:source/accounts"],
    read: (env, input, grant) => readCollectionQuality(env, grant, "accounts", input),
  }),
} as const;

export type PageReadToolName = keyof typeof TOOLS;

export function isPageReadToolName(name: string): name is PageReadToolName {
  return Object.hasOwn(TOOLS, name);
}

/** The UI routes each page read answers (ADR 0081 point 4). */
export const PAGE_READ_ROUTES: Record<PageReadToolName, readonly string[]> = Object.fromEntries(
  Object.entries(TOOLS).map(([name, definition]) => [name, definition.routes]),
) as Record<PageReadToolName, readonly string[]>;

const PAGE_READ_MCP_TOOLS = Object.entries(TOOLS).map(([name, definition]) => {
  const inputSchema = z.toJSONSchema(definition.schema) as Record<string, unknown>;
  delete inputSchema["$schema"];
  return {
    name,
    title: definition.title,
    description: definition.description,
    inputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  };
});

/** Why this grant may not read a whole-store page, as refs; empty when it may. */
function refusedRefs(grant: Grant, capability: AgentCapability): string[] {
  if (!grantAllows(grant, capability)) return [`capability:${capability}`];
  return [
    ...(grant.scopes.sources === "*" ? [] : ["scope:source"]),
    ...(grant.scopes.accounts === "*" ? [] : ["scope:account"]),
  ];
}

/** The page reads listed to this grant: exactly those it may call. */
export function pageReadMcpTools(grant: Grant) {
  return PAGE_READ_MCP_TOOLS.filter(
    (definition) =>
      refusedRefs(grant, TOOLS[definition.name as PageReadToolName].capability).length === 0,
  );
}

/**
 * Call one page read for `grant`. The grant is graded before the argument is
 * read; then the argument is validated against the closed schema; then the
 * route's reader answers, with the route's own status and closed code on a
 * refusal (`{ error, refs? }`, as the Worker answers an `HttpError`).
 */
export async function callPageReadTool(
  name: PageReadToolName,
  body: unknown,
  env: Env,
  grant: Grant,
): Promise<ToolResult> {
  const definition = TOOLS[name] as PageReadTool<z.ZodType>;
  const operation = name.slice("kogane.".length);
  const refused = refusedRefs(grant, definition.capability);
  if (refused.length > 0) {
    const code = refused[0]!.startsWith("capability:") ? "unauthorized" : "evidence_restricted";
    return { status: ERROR_STATUS[code], body: financialError(code, operation, refused) };
  }
  try {
    const input = parseRequest(definition.schema, body ?? {});
    const data = await catalogue(() => definition.read(env, input, grant));
    return { status: 200, body: { schemaVersion: PAGE_READ_SCHEMA_VERSION, data } };
  } catch (error) {
    if (error instanceof HttpError)
      return {
        status: error.status,
        body: { error: error.code, ...(error.refs.length > 0 ? { refs: error.refs } : {}) },
      };
    throw error;
  }
}
