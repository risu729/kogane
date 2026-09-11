// The READ cursor: `{ snapshotId, readInstanceId, filterDigest, position }`
// (unified plan 05 §7).
//
// It is the same wire format the CORE projection uses — one base64url JSON
// shape, decoded and validated in `packages/domain/src/paging.ts` — with the
// read instance filled in. Keeping one format means one validator and one set
// of rejection rules; naming the fields here means a caller never spells `s`,
// `f`, `k` or `t` by hand.
//
// Nothing in a cursor is trusted. The snapshot id, the read instance and the
// filter digest are compared against what the server itself resolved for this
// request, so a forged or replayed cursor can only be rejected. It is not an
// authorisation: every continuation is authenticated and re-scoped like the
// first request.
import {
  checkKeysetCursor,
  decodeKeysetCursor,
  encodeKeysetCursor,
  type CursorRejection,
} from "../../../domain/src/paging.ts";

export interface ReadCursor {
  /** The snapshot the previous page was read from. */
  snapshotId: string;
  /** The physical READ database it was read from; null for the CORE projection. */
  readInstanceId: string | null;
  /** Digest of the route, the resolved scope, the page size and the read mode. */
  filterDigest: string;
  /** Opaque position inside the snapshot's contract order, and its sort key. */
  position: number;
  sortKey: string;
}

export function encodeReadCursor(cursor: ReadCursor): string {
  return encodeKeysetCursor({
    s: cursor.snapshotId,
    f: cursor.filterDigest,
    k: cursor.sortKey,
    t: cursor.position,
    ...(cursor.readInstanceId === null ? {} : { r: cursor.readInstanceId }),
  });
}

export function decodeReadCursor(text: string): ReadCursor | null {
  const cursor = decodeKeysetCursor(text);
  if (!cursor) return null;
  return {
    snapshotId: cursor.s,
    readInstanceId: cursor.r ?? null,
    filterDigest: cursor.f,
    position: cursor.t,
    sortKey: cursor.k,
  };
}

/**
 * Whether a decoded cursor may continue this request.
 *
 * `cursor_mismatch` means it belongs to another query (a changed filter or page
 * size); `context_expired` means the fixed context it names is gone — the
 * snapshot was retired or deleted, or the READ database it was built in no
 * longer exists. The two are never the same answer, and neither ever falls back
 * to the newest snapshot.
 */
export function checkReadCursor(
  cursor: ReadCursor,
  expected: {
    filterDigest: string;
    readInstanceId: string | null;
    snapshotReadable: boolean;
  },
): CursorRejection | null {
  return checkKeysetCursor(
    {
      v: "keyset-cursor-v1",
      s: cursor.snapshotId,
      f: cursor.filterDigest,
      k: cursor.sortKey,
      t: cursor.position,
      ...(cursor.readInstanceId === null ? {} : { r: cursor.readInstanceId }),
    },
    {
      filterDigest: expected.filterDigest,
      readInstanceId: expected.readInstanceId,
      snapshotReadable: expected.snapshotReadable,
    },
  );
}
