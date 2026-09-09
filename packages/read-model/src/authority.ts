// Source authority as a caller policy, not a property of a metric.
//
// `selectAdoptedSet` in packages/domain deliberately takes `authorityRank` as
// an input: which route is the more authoritative witness of the same
// measurement is a read policy, and it must be versioned and reviewable
// separately from the metric registry the ranks are applied to.
//
// Rank 0 is the most authoritative. The rank never decides that two scopes
// describe the same measurement — only which of two candidates stays adopted
// once an explicit relation says they overlap, and (under an explicit
// conflict rule the default does not enable) which of two disagreeing
// witnesses wins. Equal ranks never break a tie, so an unproven overlap
// between two direct sources stays unresolved rather than picking one.

export const AUTHORITY_POLICY_RELEASE = "source-authority-v1";

export const AUTHORITY_RANKS = {
  /** The institution's own screen or API for its own accounts. */
  direct: 0,
  /** An aggregator restating another institution's figures. */
  aggregator: 1,
  /** A source with no reviewed authority statement. */
  unreviewed: 2,
} as const;
export type AuthorityRank = (typeof AUTHORITY_RANKS)[keyof typeof AUTHORITY_RANKS];

/**
 * Sources that report other institutions' balances. MoneyForward is the only
 * one in the current inventory; a new aggregator is added here with its
 * evidence, never by lowering a direct source instead.
 */
const AGGREGATOR_SOURCES: readonly string[] = ["moneyforward"];

/** Direct sources whose reports are the institution's own statement. */
const DIRECT_SOURCES: readonly string[] = [
  "global-pass",
  "mobile-suica",
  "myjcb",
  "sbi-securities",
  "sbi-shinsei-bank",
  "sbi-vc-trade",
  "smbc-bank",
  "sony-bank",
  "v-point",
  "v-point-pay",
  "vpass",
];

export function authorityRank(sourceId: string): AuthorityRank {
  if (AGGREGATOR_SOURCES.includes(sourceId)) return AUTHORITY_RANKS.aggregator;
  if (DIRECT_SOURCES.includes(sourceId)) return AUTHORITY_RANKS.direct;
  return AUTHORITY_RANKS.unreviewed;
}

/** For docs and tests: the reviewed sources and the rank each one carries. */
export const AUTHORITY_POLICY: readonly { sourceId: string; rank: AuthorityRank }[] = [
  ...DIRECT_SOURCES.map((sourceId) => ({ sourceId, rank: AUTHORITY_RANKS.direct })),
  ...AGGREGATOR_SOURCES.map((sourceId) => ({ sourceId, rank: AUTHORITY_RANKS.aggregator })),
].sort((a, b) => (a.sourceId < b.sourceId ? -1 : 1));
