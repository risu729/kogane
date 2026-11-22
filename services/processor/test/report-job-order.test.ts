// The order the report job sorts a passing position cut into (`pageOrder`)
// against SQLite's own `ORDER BY` over the reader's page key
// (`ORDER_KEYS.positionsByScope`): STRICT TEXT NOT NULL columns under the
// default BINARY collation, then the INTEGER id. Seeded, so every run checks
// the same 1000 stores. The alphabet mixes ASCII, Japanese, a combining mark,
// characters near U+FFFF and characters above it (where UTF-16 code-unit
// order and UTF-8 byte order disagree); ids mix small and 52-bit values
// (where text order and integer order disagree). Every string is synthetic.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { PositionWithValuations } from "../../../packages/observation-shared/src/api-contract.ts";
import { ORDER_KEYS } from "../../../packages/read-model/src/scope.ts";
import { pageOrder } from "../src/report-job.ts";

const ALPHABET = [
  ...["", "a", "b", "Z", "0", "9", "-", " ", "~", "\u007f", "é", "é", "́"],
  ...["あ", "ア", "株", "Ａ", "～", "�", "￿"],
  ...["\u{1f600}", "\u{1f338}", "\u{10000}", "\u{10ffff}", "\u{1f1ef}\u{1f1f5}"],
];

function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface KeyRow {
  id: number;
  source_id: string;
  source_account: string;
  security_code: string;
}

function entry(row: KeyRow): PositionWithValuations {
  return {
    position: {
      ...row,
      security_name: null,
      market: null,
      quantity_text: "1",
      quantity_scale: 0,
      currency: null,
      as_of: null,
      parser: "synthetic@1",
    },
    valuations: [],
  };
}

test("pageOrder sorts rows as SQLite orders them by source, account, code and id", () => {
  const db = new Database(":memory:");
  db.run(`CREATE TABLE t (id INTEGER PRIMARY KEY, source_id TEXT NOT NULL,
            source_account TEXT NOT NULL, security_code TEXT NOT NULL) STRICT`);
  const insert = db.prepare("INSERT INTO t VALUES (?, ?, ?, ?)");
  const ordered = db.prepare(
    `SELECT id, source_id, source_account, security_code FROM t ORDER BY ${ORDER_KEYS.positionsByScope}`,
  );
  let mismatches = 0;
  for (let run = 0; run < 1000; run += 1) {
    const random = mulberry32(run + 1);
    const pick = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
    const text = (): string => {
      let value = "";
      for (let i = Math.floor(random() * 5); i > 0; i -= 1) value += pick(ALPHABET);
      return value;
    };
    // Small pools per column so rows tie on a prefix of the key and the later
    // columns decide.
    const pools = [3, 4, 6].map((size) => Array.from({ length: size }, text));
    const column = (index: number): string => (random() < 0.7 ? pick(pools[index]!) : text());
    db.run("DELETE FROM t");
    const ids = new Set<number>();
    const size = 1 + Math.floor(random() * 60);
    while (ids.size < size) ids.add(1 + Math.floor(random() * (random() < 0.5 ? 120 : 2 ** 52)));
    for (const id of ids) insert.run(id, column(0), column(1), column(2));

    const expected = (ordered.all() as KeyRow[]).map((row) => row.id);
    const shuffled = (ordered.all() as KeyRow[]).map(entry);
    for (let i = shuffled.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
    }
    const sorted = shuffled.sort(pageOrder).map((row) => row.position.id);
    // A read already in page order is left as it is.
    const quiet = (ordered.all() as KeyRow[])
      .map(entry)
      .sort(pageOrder)
      .map((row) => row.position.id);
    if (sorted.join() !== expected.join() || quiet.join() !== expected.join()) mismatches += 1;
  }
  db.close();
  expect(mismatches).toBe(0);
});
