import { describe, expect, test } from "bun:test";
import { snapshotIsBehind } from "../src/snapshot-freshness";

describe("snapshot freshness over every pointer state", () => {
  test("no pointer is behind, regardless of the snapshot's own capture", () => {
    expect(
      snapshotIsBehind(null, "snapshot-a", {
        source_revision: 7,
        core_epoch: "epoch-a",
      }),
    ).toBe(true);
  });

  // Match/nonmatch is the complete finite quotient of each equality check:
  // all 2^3 pointer combinations are represented, with one current case.
  for (const namesSnapshot of [false, true]) {
    for (const sameRevision of [false, true]) {
      for (const sameEpoch of [false, true]) {
        test(`snapshot=${namesSnapshot}, revision=${sameRevision}, epoch=${sameEpoch}`, () => {
          const pointer = {
            snapshot_id: namesSnapshot ? "snapshot-a" : "snapshot-b",
            source_revision: sameRevision ? 7 : 6,
            core_epoch: sameEpoch ? "epoch-a" : "epoch-b",
          };
          const expected = !(namesSnapshot && sameRevision && sameEpoch);
          expect(
            snapshotIsBehind(pointer, "snapshot-a", {
              source_revision: 7,
              core_epoch: "epoch-a",
            }),
          ).toBe(expected);
        });
      }
    }
  }

  test("a revision ahead of CORE is also behind after a restore", () => {
    expect(
      snapshotIsBehind(
        {
          snapshot_id: "snapshot-a",
          source_revision: 8,
          core_epoch: "epoch-a",
        },
        "snapshot-a",
        { source_revision: 7, core_epoch: "epoch-a" },
      ),
    ).toBe(true);
  });
});
