// The observation API's capability and request schema. This is the single
// definition that (a) servers validate query parameters against, (b) the
// response validator checks `/api/meta` with, and (c) the client derives its
// request arguments from. Browser-safe: no runtime, database, or UI imports.
//
// Capabilities describe what an endpoint implements. They are never an
// authorization decision: authentication, closed responses on auth failure,
// and no-store caching stay in each server's auth layer regardless of what
// this object advertises. `source.kind` is informational only; UI behaviour
// must branch on capabilities, not on the name of the connection.

export const OBSERVATION_API_CONTRACT_VERSION = "observation-api-v1" as const;

/** Balance measure views the server can select on `/api/balances`. */
export const MEASURE_VIEWS = ["balances", "summaries"] as const;
export type MeasureView = (typeof MEASURE_VIEWS)[number];

/** Identity read modes; a later contract adds `as-recorded` / `snapshot`. */
export const IDENTITY_READ_MODES = ["latest"] as const;
export type IdentityReadMode = (typeof IDENTITY_READ_MODES)[number];

/**
 * `none`: every list returns its complete stored result with no coverage
 * record. `offset-v1`: derived lists page by deterministic offset, artifact
 * lists by descending id cursor, and every list carries a coverage record.
 */
export const PAGINATION_VERSIONS = ["none", "offset-v1"] as const;
export type PaginationVersion = (typeof PAGINATION_VERSIONS)[number];

export interface ApiCapabilities {
  readonly contractVersion: typeof OBSERVATION_API_CONTRACT_VERSION;
  readonly readOnly: true;
  readonly rawEvidence: true;
  readonly liveCollectors: false;
  /** Empty when `/api/balances?view=` is not implemented. */
  readonly measureViews: readonly MeasureView[];
  /** Empty when `/api/identity/*` is not implemented. */
  readonly identityReadModes: readonly IdentityReadMode[];
  readonly paginationVersion: PaginationVersion;
  /** Server-side source/account/date/text filters and `/api/filter-options`. */
  readonly collectionFilters: boolean;
  /** Rows carry an `organization` record (accounts, instruments, lineage). */
  readonly organizedDisplay: boolean;
  /** Organized rows may carry a financial product claim. */
  readonly financialProducts: boolean;
  /** The sealed raw-run history under `/api/evidence/v1` is served. */
  readonly evidenceHistory: boolean;
}

/** The local PoC store and the hosted synthetic demo, which snapshots it. */
export const LOCAL_STORE_CAPABILITIES = {
  contractVersion: OBSERVATION_API_CONTRACT_VERSION,
  readOnly: true,
  rawEvidence: true,
  liveCollectors: false,
  measureViews: [],
  identityReadModes: [],
  paginationVersion: "none",
  collectionFilters: false,
  organizedDisplay: false,
  financialProducts: false,
  evidenceHistory: false,
} as const satisfies ApiCapabilities;

/** The production evidence-browser Worker over the central store. */
export const CENTRAL_STORE_CAPABILITIES = {
  contractVersion: OBSERVATION_API_CONTRACT_VERSION,
  readOnly: true,
  rawEvidence: true,
  liveCollectors: false,
  measureViews: ["balances", "summaries"],
  identityReadModes: ["latest"],
  paginationVersion: "offset-v1",
  collectionFilters: true,
  organizedDisplay: true,
  financialProducts: true,
  evidenceHistory: true,
} as const satisfies ApiCapabilities;

/**
 * What a query parameter needs before a server accepts it or a client sends
 * it. Written as data, not functions, so tests can pin the whole schema.
 */
export type CapabilityRequirement =
  | "collectionFilters"
  | "paginationVersion:offset-v1"
  | "measureViews";

/**
 * Every query parameter a list endpoint understands, keyed by path. Paths
 * absent here (metadata, overview, details, raw bytes) accept no parameters.
 */
export const LIST_REQUEST_SCHEMA = {
  "/api/transactions": {
    source: "collectionFilters",
    account: "collectionFilters",
    from: "collectionFilters",
    to: "collectionFilters",
    q: "collectionFilters",
    offset: "paginationVersion:offset-v1",
  },
  "/api/balances": {
    source: "collectionFilters",
    account: "collectionFilters",
    instrument: "collectionFilters",
    metric: "collectionFilters",
    view: "measureViews",
    offset: "paginationVersion:offset-v1",
    latestOffset: "paginationVersion:offset-v1",
  },
  "/api/positions": {
    source: "collectionFilters",
    account: "collectionFilters",
    offset: "paginationVersion:offset-v1",
  },
  "/api/artifacts": {
    source: "collectionFilters",
    cursor: "paginationVersion:offset-v1",
  },
  "/api/filter-options": {
    kind: "collectionFilters",
    view: "measureViews",
  },
} as const satisfies Record<string, Record<string, CapabilityRequirement>>;
export type ListPath = keyof typeof LIST_REQUEST_SCHEMA;

export function isListPath(path: string): path is ListPath {
  return Object.hasOwn(LIST_REQUEST_SCHEMA, path);
}

export function capabilityGrants(
  requirement: CapabilityRequirement,
  capabilities: ApiCapabilities,
): boolean {
  switch (requirement) {
    case "collectionFilters":
      return capabilities.collectionFilters;
    case "paginationVersion:offset-v1":
      return capabilities.paginationVersion === "offset-v1";
    case "measureViews":
      return capabilities.measureViews.length > 0;
  }
}

/** Query parameter names a server with these capabilities accepts on a path. */
export function allowedQueryParameters(
  path: string,
  capabilities: ApiCapabilities,
): readonly string[] {
  if (!isListPath(path)) return [];
  const schema: Record<string, CapabilityRequirement> = LIST_REQUEST_SCHEMA[path];
  return Object.keys(schema).filter((name) => capabilityGrants(schema[name]!, capabilities));
}

export function validMeasureView(
  value: string,
  capabilities: ApiCapabilities,
): value is MeasureView {
  return (capabilities.measureViews as readonly string[]).includes(value);
}

/**
 * The client's argument builder: keeps only the parameters the advertised
 * capabilities allow, in schema order, dropping empty and repeated values.
 * A feature the server does not advertise therefore sends no parameter at all.
 */
export function listRequestSearch(
  path: string,
  capabilities: ApiCapabilities,
  params: URLSearchParams,
): string {
  const next = new URLSearchParams();
  for (const name of allowedQueryParameters(path, capabilities)) {
    const value = params.get(name);
    if (!value) continue;
    if (name === "view" && !validMeasureView(value, capabilities)) continue;
    next.set(name, value);
  }
  return next.size ? `?${next}` : "";
}
