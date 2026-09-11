// The committed bootstrap SQL must be the render of the declaration, must
// apply to a fresh CORE, and must be a no-op the second time (plan 06 §3).
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  CONFIG_PATH,
  OUTPUT_PATH,
  REPO_ROOT,
  loadIngestClientsConfig,
  parseIngestClientsConfig,
  renderIngestClientsSql,
} from "./config-bootstrap.ts";
import { COLLECTOR_SOURCE_IDS } from "../packages/application/src/collection/descriptors.ts";

const MIGRATIONS = join(REPO_ROOT, "packages/storage-d1/migrations/core");

/** CORE from 0001 with foreign keys on, as D1 enforces them. */
function freshCore(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  for (const name of readdirSync(MIGRATIONS)
    .filter((entry) => entry.endsWith(".sql"))
    .sort()) {
    db.exec(readFileSync(join(MIGRATIONS, name), "utf8"));
  }
  return db;
}

const REGISTRY = [
  "ingest_clients",
  "ingest_client_producers",
  "ingest_client_routes",
  "producers",
  "producer_sources",
];
const registry = (db: Database) =>
  Object.fromEntries(
    REGISTRY.map((table) => [table, db.query(`SELECT * FROM ${table} ORDER BY 1, 2, 3`).all()]),
  );
const ROUTE_ACTIVE =
  "SELECT 1 AS ok FROM active_ingest_routes WHERE ingest_client_id=? AND producer_id=? AND source_id=?";

describe("config/ingest-clients.json", () => {
  const config = loadIngestClientsConfig(REPO_ROOT);
  const sql = readFileSync(join(REPO_ROOT, OUTPUT_PATH), "utf8");

  test("the committed SQL is the render of the declaration", () => {
    expect(sql).toBe(renderIngestClientsSql(config));
  });

  test("the Processor's routes cover the collector source mapping, and only it", () => {
    const processor = config.clients.find((client) => client.id === "processor-shared-r2");
    expect(processor).toBeDefined();
    // One route per collector id the Processor knows, except the synthetic
    // verification source, whose rows every test harness seeds itself.
    const expected = Object.entries(COLLECTOR_SOURCE_IDS)
      .filter(([collector]) => collector !== "kogane-synthetic")
      .map(([collector, source]) => ({ source, producer: `collector-${collector}`, active: true }))
      .sort((left, right) => left.producer.localeCompare(right.producer));
    const declared = [...processor!.routes].sort((left, right) =>
      left.producer.localeCompare(right.producer),
    );
    expect(declared).toEqual(expected);
    // Every CORE source the mapping points at is a declared, active source, so
    // a terminal that maps is never refused as `source_undeclared`.
    const db = freshCore();
    for (const source of new Set(Object.values(COLLECTOR_SOURCE_IDS))) {
      expect(db.query("SELECT 1 AS ok FROM sources WHERE id=? AND active=1").get(source)).toEqual({
        ok: 1,
      });
    }
  });

  test("applies to a fresh CORE and is a no-op on the second apply", () => {
    const db = freshCore();
    db.exec(sql);
    const first = registry(db);
    for (const client of config.clients) {
      for (const route of client.routes) {
        const active = db.query(ROUTE_ACTIVE).get(client.id, route.producer, route.source);
        expect(active !== null).toBe(client.active && route.active);
      }
    }
    db.exec(sql);
    expect(registry(db)).toEqual(first);
  });

  test("a flag turned off in the declaration converges on the next apply", () => {
    const db = freshCore();
    db.exec(sql);
    const client = config.clients[0]!;
    const route = client.routes[0]!;
    const off = {
      ...config,
      clients: [
        {
          ...client,
          routes: client.routes.map((entry) =>
            entry === route ? { ...entry, active: false } : entry,
          ),
        },
      ],
    };
    db.exec(renderIngestClientsSql(off));
    expect(db.query(ROUTE_ACTIVE).get(client.id, route.producer, route.source)).toBeNull();
    // And back on: the flag follows the declaration in both directions.
    db.exec(sql);
    expect(db.query(ROUTE_ACTIVE).get(client.id, route.producer, route.source)).toEqual({ ok: 1 });
  });

  test("refuses what the SQL could not express safely", () => {
    const valid = JSON.parse(readFileSync(join(REPO_ROOT, CONFIG_PATH), "utf8"));
    expect(() => parseIngestClientsConfig(valid)).not.toThrow();
    const client = valid.clients[0];
    const withClient = (patch: Record<string, unknown>) => ({
      ...valid,
      clients: [{ ...client, ...patch }],
    });
    expect(() => parseIngestClientsConfig(withClient({ id: "Bad Id" }))).toThrow(/id must match/);
    expect(() => parseIngestClientsConfig(withClient({ displayName: "x'y" }))).toThrow(
      /displayName/,
    );
    expect(() => parseIngestClientsConfig(withClient({ token: "secret" }))).toThrow(
      /unknown key "token"/,
    );
    expect(() =>
      parseIngestClientsConfig(withClient({ routes: [client.routes[0], client.routes[0]] })),
    ).toThrow(/repeats route/);
    expect(() => parseIngestClientsConfig({ ...valid, clients: [client, client] })).toThrow(
      /declared twice/,
    );
  });
});
