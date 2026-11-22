// The two details a summary-first read answers (ADR 0123): `summary`, a
// bounded short form, and `full`, the answer as it is. Each read names its own
// default and its own constant for them; the list is defined once, here.

/** `summary`, then `full`: the order every read but the reward expiry window publishes. */
export const READ_DETAILS = ["summary", "full"] as const;
