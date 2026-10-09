// Field boundaries of the keyset cursor in paging.ts.
//
// paging.test.ts already covers the page envelope, dataCoverage, observed
// quantities, the malformed and oversized samples, a filter mismatch, and a
// snapshot pin that names a different snapshot. read-cursor.test.ts already
// covers expiry when a cursor that names `r` meets another read instance.
// This file only adds boundaries those cases do not lock.
import { describe, expect, test } from "bun:test";
import {
  CURSOR_REJECTIONS,
  CURSOR_VERSION,
  type KeysetCursor,
  checkKeysetCursor,
  decodeKeysetCursor,
  encodeKeysetCursor,
} from "../src/paging.ts";

function base64url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function wire(value: unknown): string {
  return base64url(JSON.stringify(value));
}

function decodedText(text: string): string {
  const standard = text.replace(/-/gu, "+").replace(/_/gu, "/");
  return atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));
}

const payload = {
  v: CURSOR_VERSION,
  s: "s",
  f: "f",
  k: "k",
  t: 1,
} as const;

const fiveKey = {
  v: CURSOR_VERSION,
  s: "snap",
  f: "filt",
  k: "k",
  t: 1,
} as const satisfies KeysetCursor;

describe("keyset cursor field boundaries", () => {
  test("the closed rejection codes stay cursor_invalid, cursor_mismatch, and context_expired", () => {
    // decode returns null for a bad wire. checkKeysetCursor returns only
    // cursor_mismatch, context_expired, or null. Neither function emits
    // cursor_invalid or the HTTP invalid_cursor string.
    expect([...CURSOR_REJECTIONS]).toEqual([
      "cursor_invalid",
      "cursor_mismatch",
      "context_expired",
    ]);
  });

  test("canonical JSON keeps key order v, s, f, k, t, and r only when present", () => {
    expect(decodedText(encodeKeysetCursor({ s: "s", f: "f", k: "k", t: 1 }))).toBe(
      '{"v":"keyset-cursor-v1","s":"s","f":"f","k":"k","t":1}',
    );
    expect(decodedText(encodeKeysetCursor({ s: "s", f: "f", k: "k", t: 1, r: "inst" }))).toBe(
      '{"v":"keyset-cursor-v1","s":"s","f":"f","k":"k","t":1,"r":"inst"}',
    );
  });

  test("inclusive length and position bounds round-trip, including an empty sort key", () => {
    expect(
      decodeKeysetCursor(
        encodeKeysetCursor({
          s: "a".repeat(128),
          f: "b".repeat(128),
          k: "k".repeat(256),
          t: 2_000_000_000,
          r: "r".repeat(128),
        }),
      ),
    ).toEqual({
      v: CURSOR_VERSION,
      s: "a".repeat(128),
      f: "b".repeat(128),
      k: "k".repeat(256),
      t: 2_000_000_000,
      r: "r".repeat(128),
    });
    expect(decodeKeysetCursor(encodeKeysetCursor({ s: "s", f: "f", k: "", t: 0 }))).toEqual({
      v: CURSOR_VERSION,
      s: "s",
      f: "f",
      k: "",
      t: 0,
    });
  });

  test("a non-ASCII sort key round-trips through UTF-8", () => {
    expect(decodeKeysetCursor(encodeKeysetCursor({ s: "s", f: "f", k: "é", t: 1 }))).toEqual({
      v: CURSOR_VERSION,
      s: "s",
      f: "f",
      k: "é",
      t: 1,
    });
  });

  test("one illegal field, an unknown field, or a wrong version decodes to null", () => {
    const cases: ReadonlyArray<readonly [string, unknown]> = [
      ["wrong version", { ...payload, v: "keyset-cursor-v2" }],
      ["unknown field", { ...payload, x: 1 }],
      ["empty snapshot id", { ...payload, s: "" }],
      ["snapshot id over 128", { ...payload, s: "a".repeat(129) }],
      ["snapshot id number", { ...payload, s: 1 }],
      ["empty filter digest", { ...payload, f: "" }],
      ["filter digest over 128", { ...payload, f: "b".repeat(129) }],
      ["filter digest number", { ...payload, f: 1 }],
      ["sort key number", { ...payload, k: 1 }],
      ["sort key over 256", { ...payload, k: "k".repeat(257) }],
      ["position string", { ...payload, t: "1" }],
      ["position fraction", { ...payload, t: 1.5 }],
      ["position below zero", { ...payload, t: -1 }],
      ["position above 2000000000", { ...payload, t: 2_000_000_001 }],
      ["empty read instance", { ...payload, r: "" }],
      ["read instance over 128", { ...payload, r: "r".repeat(129) }],
      ["read instance null", { ...payload, r: null }],
    ];
    for (const [label, value] of cases) expect(decodeKeysetCursor(wire(value)), label).toBeNull();
  });

  test("the URL alphabet round-trips and the standard alphabet and padding do not", () => {
    const text = encodeKeysetCursor({ s: "s", f: "f", k: ">>>>????", t: 1 });
    expect(text).toContain("-");
    expect(text).toContain("_");
    expect(text).not.toContain("+");
    expect(text).not.toContain("/");
    expect(decodeKeysetCursor(text)).toEqual({
      v: CURSOR_VERSION,
      s: "s",
      f: "f",
      k: ">>>>????",
      t: 1,
    });
    expect(decodeKeysetCursor(text.replace(/-/gu, "+").replace(/_/gu, "/"))).toBeNull();
    const padding = "=".repeat((4 - (text.length % 4)) % 4);
    expect(padding.length).toBeGreaterThan(0);
    expect(decodeKeysetCursor(text + padding)).toBeNull();
  });

  test("a 2048-character wire is the alphabet cap and the next unpadded length is refused", () => {
    // The short ASCII payload's base64url wire is shorter than 2048
    // characters. Leading JSON spaces are ASCII, so each is one UTF-8 byte
    // and one UTF-16 code unit, and they lengthen only that wire: 1536 such
    // bytes encode to the 2048-character cap, and one more byte encodes to
    // 2050. The decoded object stays the short payload. UTF-16 field limits
    // are a separate check.
    const json = JSON.stringify(payload);
    const accepted = base64url(`${" ".repeat(1536 - json.length)}${json}`);
    expect(accepted).toHaveLength(2048);
    expect(decodeKeysetCursor(accepted)).toEqual(payload);
    const refused = base64url(`${" ".repeat(1537 - json.length)}${json}`);
    expect(refused).toHaveLength(2050);
    expect(decodeKeysetCursor(refused)).toBeNull();
  });

  test("a one-character wire is refused and does not throw", () => {
    expect(decodeKeysetCursor("a")).toBeNull();
  });

  test("the same snapshot pin, or an explicit null pin, continues", () => {
    expect(
      checkKeysetCursor(fiveKey, {
        filterDigest: fiveKey.f,
        requestedSnapshotId: fiveKey.s,
        snapshotReadable: true,
      }),
    ).toBeNull();
    expect(
      checkKeysetCursor(fiveKey, {
        filterDigest: fiveKey.f,
        requestedSnapshotId: null,
        snapshotReadable: true,
      }),
    ).toBeNull();
  });

  test("a cursor that names no read instance continues on CORE and expires on another instance", () => {
    expect(
      checkKeysetCursor(fiveKey, {
        filterDigest: fiveKey.f,
        readInstanceId: null,
        snapshotReadable: true,
      }),
    ).toBeNull();
    expect(
      checkKeysetCursor(fiveKey, {
        filterDigest: fiveKey.f,
        readInstanceId: "other",
        snapshotReadable: true,
      }),
    ).toBe("context_expired");
  });

  test("omitting the read instance does not expire a cursor that names one", () => {
    expect(
      checkKeysetCursor(
        { ...fiveKey, r: "inst" },
        { filterDigest: fiveKey.f, snapshotReadable: true },
      ),
    ).toBeNull();
  });
});
