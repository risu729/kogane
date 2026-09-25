// Vpass external ids across the page artifacts of one card-month snapshot
// (vpass-statement-page 1.2.0). The provider issues no row id, so a row's id
// is its fingerprint plus a per-page occurrence counter; every page after the
// first adds its page name so that byte-identical rows on two pages stay two
// rows. Built from the shared synthetic fixtures; every value is synthetic.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { vpassStatementPage } from "../src/parsers/vpass.ts";
import type { ArtifactMeta, TransactionObservation } from "../src/types.ts";
import { FIXTURES_ROOT } from "./fixture-root.ts";

type Family = "web" | "customized";
const BEAN = {
  web: "WebMeisaiTopDisplayServiceBean",
  customized: "CustomizedMeisaiAnsDisplayServiceBean",
} as const;

function payload(family: Family): Record<string, any> {
  return JSON.parse(
    readFileSync(join(FIXTURES_ROOT, `vpass-parser-boundaries/${family}.json`), "utf8"),
  );
}

/** The fixture's first usage row, repeated `count` times on one page. */
function page(family: Family, count: number): Uint8Array {
  const root = payload(family);
  const bean = root.body.content[BEAN[family]];
  bean.meisaiList = Array.from({ length: count }, () => structuredClone(bean.meisaiList[0]));
  if (family === "customized") {
    bean.responseCnt = String(count);
    bean.total = count;
  }
  return new TextEncoder().encode(JSON.stringify(root));
}

function meta(name: string): ArtifactMeta {
  return {
    id: 1,
    sourceId: "vpass",
    runStatus: "success",
    runFailureCount: 0,
    dataset: "statement-page",
    url: null,
    mime: "application/json",
    artifactKey: `cards/card-001/months/202608/${name}.json`,
    fetchUnitKey: "card-001",
    fetchedAt: "2026-08-30T00:00:00.000Z",
    sha256: "0".repeat(64),
  };
}

function transactions(bytes: Uint8Array, name: string): TransactionObservation[] {
  return vpassStatementPage
    .parse(bytes, meta(name))
    .observations.filter((row): row is TransactionObservation => row.kind === "transaction");
}

const kogane = (row: TransactionObservation) => row.extra["_kogane"] as Record<string, unknown>;

// The later pages of each family: web pages are `top-NNN`, customized pages
// after `top-000` are `answer-NNN` (the parser refuses any other pairing).
const LATER: Record<Family, [string, string]> = {
  web: ["top-001", "top-002"],
  customized: ["answer-001", "answer-002"],
};

describe("Vpass external ids across the pages of one card-month", () => {
  for (const family of ["web", "customized"] as const) {
    test(`${family}: an identical row on the first and a later page gets two ids`, () => {
      const [first] = transactions(page(family, 1), "top-000");
      const [later] = transactions(page(family, 1), LATER[family][0]);
      expect(first!.externalId).not.toBe(later!.externalId);
      // Same row content, so the same fingerprint; only the page segment differs.
      const fingerprint = first!.externalId!.split(":")[4]!;
      expect(fingerprint).toMatch(/^[0-9a-f]{32}$/u);
      expect(first!.externalId).toBe(`vpass:card-001:202608:${family}:${fingerprint}:0`);
      expect(later!.externalId).toBe(
        `vpass:card-001:202608:${family}:${fingerprint}:${LATER[family][0]}:0`,
      );
      expect(kogane(first!)["identityOrigin"]).toBe("sanitized-row+card+month+family+occurrence");
      expect(kogane(later!)["identityOrigin"]).toBe(
        "sanitized-row+card+month+family+page+occurrence",
      );
    });

    test(`${family}: every row of a multi-page snapshot with repeated rows has its own id`, () => {
      const snapshot = [
        ...transactions(page(family, 2), "top-000"),
        ...transactions(page(family, 1), LATER[family][0]),
        ...transactions(page(family, 2), LATER[family][1]),
      ];
      expect(snapshot).toHaveLength(5);
      expect(new Set(snapshot.map((row) => row.externalId)).size).toBe(5);
      // The occurrence counter still separates identical rows inside one page.
      expect(snapshot.map((row) => row.externalId!.split(":").slice(5).join(":"))).toEqual([
        "0",
        "1",
        `${LATER[family][0]}:0`,
        `${LATER[family][1]}:0`,
        `${LATER[family][1]}:1`,
      ]);
    });

    test(`${family}: a later page differs from the first only in its page and id fields`, () => {
      const [first] = transactions(page(family, 1), "top-000");
      const [later] = transactions(page(family, 1), LATER[family][0]);
      const strip = (row: TransactionObservation) => {
        const { externalId: _id, extra, ...rest } = row;
        const {
          pageKind: _kind,
          pageIndex: _index,
          identityOrigin: _origin,
          ...stamp
        } = extra["_kogane"] as Record<string, unknown>;
        return { ...rest, extra: { ...extra, _kogane: stamp } };
      };
      expect(strip(later!)).toEqual(strip(first!));
      expect([kogane(later!)["pageKind"], kogane(later!)["pageIndex"]]).toEqual([
        family === "web" ? "top" : "answer",
        1,
      ]);
    });
  }

  test("a first page keeps its 1.1.0 external ids, so a single-page month is unchanged", () => {
    // Pinned from vpass-statement-page@1.1.0 (the parser of 1b8cb84~1) on the
    // unmodified fixtures, re-pinned the same way when the fixtures took the
    // production payment-type codes (`１` in the web page's data[6], `0` in
    // the customized page's bunkatsuYaku). The first page emits exactly what
    // 1.1.0 emitted; a later page is the only place 1.2.0 changes an id.
    const ids = (family: Family) =>
      transactions(
        readFileSync(join(FIXTURES_ROOT, `vpass-parser-boundaries/${family}.json`)),
        "top-000",
      ).map((row) => [row.externalId, kogane(row)["identityOrigin"]]);
    const origin = "sanitized-row+card+month+family+occurrence";
    expect(ids("web")).toEqual([
      ["vpass:card-001:202608:web:d914f30977e2c3b5b822a8b35331fd19:0", origin],
    ]);
    expect(ids("customized")).toEqual([
      ["vpass:card-001:202608:customized:9ca2b8bed94f4612dfed45d047febe2e:0", origin],
      ["vpass:card-001:202608:customized:0fd5ed556505e519d64a2cf3ead145e5:0", origin],
    ]);
  });
});
