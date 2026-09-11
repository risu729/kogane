// The Drizzle handle over a D1 binding (unified plan 09, decision D11).
//
// One factory, one schema, one place where the ORM meets the database. The
// pilot's reads take a `D1Like` exactly as the native ones do, so a call site
// switches by changing which function it imports and nothing else — no new
// binding, no new parameter, no ORM type in anybody's signature.
//
// Scope, stated once because it is the decision and not an implementation
// detail: this handle is for single-table reads with filters, ordering and
// paging, and for simple appends. Guarded batches — the seal, the publication
// pointer, a decision commit, a lease fence — stay native SQL in
// `../atomic/`, because each of them is one command whose preconditions are
// conditions of its *writing* statements. Decomposing one into ORM CRUD calls
// would reintroduce the read-then-write race those statements exist to close
// (09 §2).
import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import type { D1Like } from "../d1.ts";
import * as schema from "./schema/core.ts";

/** The typed handle. The schema is the mirror in `./schema/core.ts`. */
export type CoreDrizzle = DrizzleD1Database<typeof schema>;

/**
 * Wraps a D1 binding. The cast is the seam between this package's structural
 * `D1Like` and the driver's nominal `D1Database`: a real binding satisfies
 * both, and the bun:sqlite adapter in `test/sqlite.ts` implements every
 * method the driver calls (`prepare`, `bind`, `all`, `raw`, `run`, `batch`).
 */
export function coreDrizzle(db: D1Like): CoreDrizzle {
  return drizzle(db as never, { schema });
}
