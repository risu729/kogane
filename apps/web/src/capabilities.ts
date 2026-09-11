// What the UI does with the capabilities the API advertises. Pure: no React,
// no DOM, so unit tests can prove behaviour depends on capabilities alone.
//
// `source.kind` never appears here. It is a label (see app.tsx); renaming a
// connection must leave every feature decision below unchanged.
import type { ApiCapabilities, ApiMetadata } from "../../../packages/observation-shared/src/api-contract.ts";

/**
 * "Capabilities loading" and "capabilities known" are distinct states. While
 * unknown, dependent requests are not sent with guessed defaults; hooks stay
 * disabled and pages show their loading state.
 */
export type CapabilityState =
  | { readonly known: false; readonly capabilities?: undefined }
  | { readonly known: true; readonly capabilities: ApiCapabilities };

export function capabilityState(metadata: ApiMetadata | undefined): CapabilityState {
  return metadata === undefined
    ? { known: false }
    : { known: true, capabilities: metadata.capabilities };
}

export interface ClientFeatures {
  /** Server filters over all stored records replace client-side record controls. */
  readonly serverFilters: boolean;
  /** Lists are server pages; client-side sorting of a page window is misleading. */
  readonly serverPaging: boolean;
  /** Identity pages read the current mapping revision. */
  readonly identities: boolean;
  /** The sealed raw-run history route is available. */
  readonly evidenceHistory: boolean;
  /**
   * Latest balances and balance history are separate keyset-paged routes over
   * a fixed snapshot, with adoption states and reason codes.
   */
  readonly balanceReadModel: boolean;
  /** Summary figures come from the shared query service, not a page-local sum. */
  readonly sharedQuery: boolean;
  /** The reward programme pages are available. */
  readonly rewards: boolean;
  /** The change lifecycle is served, so confirmation screens may act. */
  readonly commands: boolean;
}

/** Every feature is off until capabilities are known. */
export const NO_FEATURES: ClientFeatures = {
  serverFilters: false,
  serverPaging: false,
  identities: false,
  evidenceHistory: false,
  balanceReadModel: false,
  sharedQuery: false,
  rewards: false,
  commands: false,
};

export function clientFeatures(capabilities: ApiCapabilities): ClientFeatures {
  return {
    serverFilters: capabilities.collectionFilters,
    serverPaging: capabilities.paginationVersion !== "none",
    identities: capabilities.identityReadModes.includes("latest"),
    evidenceHistory: capabilities.evidenceHistory,
    balanceReadModel: capabilities.balancesV2 && capabilities.balancesV2Pagination === "keyset-v2",
    sharedQuery: capabilities.sharedQuery,
    rewards: capabilities.rewardsV2,
    commands: capabilities.commands,
  };
}
