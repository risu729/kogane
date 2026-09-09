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

/**
 * Identity read modes (review D06). `latest` decorates observations with the
 * current mapping revisions; `as-recorded` with the mapping revisions the
 * sealed identity run pinned when it was made. `snapshot` (a fixed release
 * and revision set) is a later contract and is refused as unsupported.
 */
export const IDENTITY_READ_MODES = ["latest", "as-recorded"] as const;
export type IdentityReadMode = (typeof IDENTITY_READ_MODES)[number];

/**
 * Which interpretation a response was computed under: the read mode and the
 * release of every rule set that shaped it. Same shape as
 * `InterpretationContext` in `packages/domain`, restricted to the modes this
 * contract serves; `snapshotId` is null until snapshots exist.
 */
export interface InterpretationContext {
  readonly mode: IdentityReadMode;
  readonly snapshotId: null;
  readonly identityRelease: string;
  readonly productCatalogueRelease: string;
  readonly productResolverRelease: string;
  readonly measurePolicyRelease: string;
  readonly decimalPolicyRelease: string;
}

const RELEASE = /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u;
export function validInterpretationContext(value: unknown): value is InterpretationContext {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const context = value as Record<string, unknown>;
  return (
    (IDENTITY_READ_MODES as readonly string[]).includes(String(context.mode)) &&
    context.snapshotId === null &&
    (
      [
        "identityRelease",
        "productCatalogueRelease",
        "productResolverRelease",
        "measurePolicyRelease",
        "decimalPolicyRelease",
      ] as const
    ).every((key) => typeof context[key] === "string" && RELEASE.test(context[key]))
  );
}

/**
 * `none`: every list returns its complete stored result with no coverage
 * record. `offset-v1`: derived lists page by deterministic offset, artifact
 * lists by descending id cursor, and every list carries a coverage record.
 * `keyset-v2`: pages are an opaque keyset cursor over one fixed snapshot, and
 * the envelope separates "this page is not the last" from "the data behind it
 * is incomplete" (review 06, D10).
 */
export const PAGINATION_VERSIONS = ["none", "offset-v1", "keyset-v2"] as const;
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
  /** Pagination of the v1 list routes. */
  readonly paginationVersion: PaginationVersion;
  /** `/api/v2/balances/latest` and `/api/v2/balances/history` are served. */
  readonly balancesV2: boolean;
  /** Pagination of the v2 balance routes; `none` when they are not served. */
  readonly balancesV2Pagination: PaginationVersion;
  /** Server-side source/account/date/text filters and `/api/filter-options`. */
  readonly collectionFilters: boolean;
  /** Rows carry an `organization` record (accounts, instruments, lineage). */
  readonly organizedDisplay: boolean;
  /** Organized rows may carry a financial product claim. */
  readonly financialProducts: boolean;
  /** The sealed raw-run history under `/api/evidence/v1` is served. */
  readonly evidenceHistory: boolean;
  /**
   * `/api/v2/rewards/*` is served: programme holdings with buckets, expiry
   * estimates with their state, and a pure conversion simulation. Off by
   * default; a deployment turns it on and then advertises it here, so a client
   * never guesses whether the routes exist (docs/rewards.md).
   */
  readonly rewardsV2: boolean;
  /**
   * `GET /api/v2/query` runs the shared query service (`@kogane/application`)
   * that the agent API also calls, so one page and one agent compute a figure
   * the same way. Never an authorization decision: the route keeps the same
   * authentication gate as every other route.
   */
  readonly sharedQuery: boolean;
  /**
   * The authenticated change lifecycle (`POST /api/command/v1/*`) is served
   * (A09). False everywhere the `COMMANDS_ENABLED` flag is off, so a client
   * shows the confirmation screen read-only rather than offering buttons that
   * would be refused. It is not an authorization decision: the server still
   * authenticates, checks the grant and refuses an agent's approval.
   */
  readonly commands: boolean;
  /**
   * `/api/v2/activity` and `/api/v2/obligations` are served. False unless the
   * A10 projection exists in the store the server reads and the reader flag is
   * on, so this is a server-computed fact, not a static claim.
   */
  readonly eventsV2: boolean;
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
  balancesV2: false,
  balancesV2Pagination: "none",
  collectionFilters: false,
  organizedDisplay: false,
  financialProducts: false,
  evidenceHistory: false,
  sharedQuery: false,
  rewardsV2: false,
  commands: false,
  eventsV2: false,
} as const satisfies ApiCapabilities;

/** The production evidence-browser Worker over the central store. */
export const CENTRAL_STORE_CAPABILITIES = {
  contractVersion: OBSERVATION_API_CONTRACT_VERSION,
  readOnly: true,
  rawEvidence: true,
  liveCollectors: false,
  measureViews: ["balances", "summaries"],
  identityReadModes: ["latest", "as-recorded"],
  paginationVersion: "offset-v1",
  // Off until the balance projection is built and the reader flag is on; the
  // Worker advertises the enabled variant through `withBalancesV2`.
  balancesV2: false,
  balancesV2Pagination: "none",
  collectionFilters: true,
  organizedDisplay: true,
  financialProducts: true,
  evidenceHistory: true,
  sharedQuery: true,
  // `rewardsV2`, `commands` and `eventsV2` are off in the shared constant:
  // each deployment's own flag decides, and `/api/meta` overrides these
  // fields with what the running Worker actually serves.
  rewardsV2: false,
  commands: false,
  eventsV2: false,
} as const satisfies ApiCapabilities;

/**
 * What a query parameter needs before a server accepts it or a client sends
 * it. Written as data, not functions, so tests can pin the whole schema.
 */
export type CapabilityRequirement =
  | "collectionFilters"
  | "paginationVersion:offset-v1"
  | "measureViews"
  | "identityReadModes"
  | "balancesV2"
  | "rewardsV2";

/** The v2 balance routes as this Worker advertises them when the flag is on. */
export function withBalancesV2(capabilities: ApiCapabilities, enabled: boolean): ApiCapabilities {
  return {
    ...capabilities,
    balancesV2: enabled,
    balancesV2Pagination: enabled ? "keyset-v2" : "none",
  };
}

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
    identityRead: "identityReadModes",
  },
  "/api/balances": {
    source: "collectionFilters",
    account: "collectionFilters",
    instrument: "collectionFilters",
    metric: "collectionFilters",
    view: "measureViews",
    offset: "paginationVersion:offset-v1",
    latestOffset: "paginationVersion:offset-v1",
    identityRead: "identityReadModes",
  },
  "/api/positions": {
    source: "collectionFilters",
    account: "collectionFilters",
    offset: "paginationVersion:offset-v1",
    identityRead: "identityReadModes",
  },
  "/api/artifacts": {
    source: "collectionFilters",
    cursor: "paginationVersion:offset-v1",
  },
  "/api/filter-options": {
    kind: "collectionFilters",
    view: "measureViews",
  },
  "/api/v2/balances/latest": {
    source: "collectionFilters",
    account: "collectionFilters",
    instrument: "collectionFilters",
    metric: "collectionFilters",
    view: "measureViews",
    identityRead: "identityReadModes",
    cursor: "balancesV2",
    limit: "balancesV2",
  },
  "/api/v2/balances/history": {
    source: "collectionFilters",
    account: "collectionFilters",
    instrument: "collectionFilters",
    metric: "collectionFilters",
    view: "measureViews",
    identityRead: "identityReadModes",
    cursor: "balancesV2",
    limit: "balancesV2",
  },
} as const satisfies Record<string, Record<string, CapabilityRequirement>>;
export type ListPath = keyof typeof LIST_REQUEST_SCHEMA;

/**
 * Capability a whole path needs before it exists at all. A path whose
 * capability is missing is not served: it answers 404, not 400, because there
 * is no route to reject a parameter for.
 */
export const LIST_PATH_CAPABILITY: Partial<Record<ListPath, CapabilityRequirement>> = {
  "/api/v2/balances/latest": "balancesV2",
  "/api/v2/balances/history": "balancesV2",
};

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
    case "identityReadModes":
      return capabilities.identityReadModes.length > 0;
    case "balancesV2":
      return capabilities.balancesV2;
    case "rewardsV2":
      return capabilities.rewardsV2;
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

/**
 * Reward routes (A11). They are a separate table because the whole route
 * group exists or does not: with `rewardsV2` off the paths are 404, not a 400
 * on an unknown parameter, exactly like `/api/identity/*` without a read mode.
 * `/offers/simulate` is a pure GET — same parameters, same answer, no side
 * effect and no exchange (docs/rewards.md).
 */
export const REWARD_REQUEST_SCHEMA = {
  "/api/v2/rewards/holdings": ["program", "offset"],
  "/api/v2/rewards/expiry": ["program", "offset"],
  "/api/v2/rewards/offers/simulate": ["offer", "quantity", "unit", "goal", "depth"],
} as const satisfies Record<string, readonly string[]>;
export type RewardPath = keyof typeof REWARD_REQUEST_SCHEMA;

export function isRewardPath(path: string): path is RewardPath {
  return Object.hasOwn(REWARD_REQUEST_SCHEMA, path);
}

/** Parameter names a reward route accepts; empty when the capability is off. */
export function rewardQueryParameters(
  path: string,
  capabilities: ApiCapabilities,
): readonly string[] {
  if (!capabilities.rewardsV2 || !isRewardPath(path)) return [];
  return REWARD_REQUEST_SCHEMA[path];
}

export function validMeasureView(
  value: string,
  capabilities: ApiCapabilities,
): value is MeasureView {
  return (capabilities.measureViews as readonly string[]).includes(value);
}

export function validIdentityReadMode(
  value: string,
  capabilities: ApiCapabilities,
): value is IdentityReadMode {
  return (capabilities.identityReadModes as readonly string[]).includes(value);
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
    if (name === "identityRead" && !validIdentityReadMode(value, capabilities)) continue;
    next.set(name, value);
  }
  return next.size ? `?${next}` : "";
}
