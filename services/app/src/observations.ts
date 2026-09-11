// Read access for the evidence browser: the explicit read repository from
// packages/read-model, bound to this Worker's D1 database.
//
// Nothing here writes, and nothing here composes SQL. Every read the API can
// run is a named reader method with a typed input, and the SQL behind it
// names the sealed `observation_*` view it reads. A new read is added to the
// reader (docs/read-model.md); it is never SQL text in a route, and no code
// rewrites SQL strings to change what they read.

import {
  createD1ObservationReader,
  type ObservationReader,
} from "../../../packages/read-model/src/index";
import { HttpError } from "./http";

export { isObservationKind } from "../../../packages/read-model/src/index";
export type { FilterOptionsKind, ObservationReader } from "../../../packages/read-model/src/index";
export type {
  ArtifactDetail,
  ArtifactRow,
  BalanceHistoryRow,
  BalanceRow,
  ObservationDetail,
  ObservationKind,
  Overview,
  ParseRunDetail,
  PositionRow,
  PositionWithValuations,
  Provenance,
  TransactionRow,
  ValuationRow,
  Warnings,
} from "../../../packages/observation-shared/src/api-contract.ts";

/**
 * The reader refuses any list past 5,000 rows. The API reports that as 413
 * rather than serving a silently partial result.
 */
export function evidenceReader(db: D1Database): ObservationReader {
  return createD1ObservationReader(db, {
    limitExceeded: () => new HttpError(413, "result_limit_exceeded"),
  });
}
