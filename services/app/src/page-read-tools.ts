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
import type { ToolResult } from "./agent-service";
import { HttpError } from "./http";
import { IDENTITY_COLLECTIONS, readIdentityCollection } from "./identity-api";
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

interface PageReadTool<Schema extends z.ZodType> {
  title: string;
  description: string;
  schema: Schema;
  /** The agent capability that reaches this page, always over the whole store. */
  capability: AgentCapability;
  /** The UI route paths this tool answers, for the parity inventory. */
  routes: readonly string[];
  /** The shared reader, called with the request the route would build. */
  read(env: Env, input: z.infer<Schema>): Promise<unknown>;
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
    const data = await catalogue(() => definition.read(env, input));
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
