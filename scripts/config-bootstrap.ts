// Renders `config/ingest-clients.json` to idempotent CORE SQL
// (`infra/bootstrap/ingest-clients.sql`), unified plan 06 §3 and U08.
//
// The declaration is the source of truth and the SQL is its derived form:
// `scripts/config-bootstrap.test.ts` fails when the committed SQL differs
// from a fresh render, applies the SQL to a fresh CORE twice and checks that
// the second apply changes nothing. Every statement is conditional on its own
// absence, or converges one `active` flag, so the file can be applied to a
// database that already carries some of its rows — after a partial apply, or
// after the declaration gained a route.
//
// Nothing here is a credential. The Processor's client registers in process
// (`directRegistrationPort`), so it has no bearer token and the legacy ingest
// Worker cannot authenticate as it: no token is generated and none is stored.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const CONFIG_PATH = "config/ingest-clients.json";
export const OUTPUT_PATH = "infra/bootstrap/ingest-clients.sql";

/** The ingest contract's identifier charset (`packages/evidence-contract`). */
const ID = /^[a-z0-9-]{1,100}$/u;
/** Display names: plain words and punctuation, no quote, no control character. */
const DISPLAY_NAME = /^[A-Za-z0-9 ().,_-]{1,200}$/u;

export interface RouteDeclaration {
  readonly source: string;
  readonly producer: string;
  readonly active: boolean;
}

export interface ClientDeclaration {
  readonly id: string;
  readonly displayName: string;
  readonly active: boolean;
  readonly routes: readonly RouteDeclaration[];
}

export interface IngestClientsConfig {
  readonly version: "ingest-clients-v1";
  readonly description?: string;
  readonly clients: readonly ClientDeclaration[];
}

function fail(message: string): never {
  throw new Error(`config/ingest-clients.json: ${message}`);
}

function record(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function identifier(value: unknown, what: string): string {
  if (typeof value !== "string" || !ID.test(value)) fail(`${what} must match ${ID}`);
  return value;
}

function flag(value: unknown, what: string): boolean {
  if (typeof value !== "boolean") fail(`${what} must be true or false`);
  return value;
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], what: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${what} has an unknown key "${key}"`);
  }
}

/** Strict parse: unknown keys, bad identifiers and duplicates are refusals. */
export function parseIngestClientsConfig(value: unknown): IngestClientsConfig {
  const root = record(value, "the document");
  exactKeys(root, ["version", "description", "clients"], "the document");
  if (root.version !== "ingest-clients-v1") fail("version must be ingest-clients-v1");
  if (root.description !== undefined && typeof root.description !== "string") {
    fail("description must be a string");
  }
  if (!Array.isArray(root.clients) || root.clients.length === 0) {
    fail("clients must be a non-empty array");
  }
  const clientIds = new Set<string>();
  const clients = root.clients.map((entry, index): ClientDeclaration => {
    const what = `clients[${index}]`;
    const client = record(entry, what);
    exactKeys(client, ["id", "displayName", "active", "routes"], what);
    const id = identifier(client.id, `${what}.id`);
    if (clientIds.has(id)) fail(`client "${id}" is declared twice`);
    clientIds.add(id);
    if (typeof client.displayName !== "string" || !DISPLAY_NAME.test(client.displayName)) {
      fail(`${what}.displayName must match ${DISPLAY_NAME}`);
    }
    if (!Array.isArray(client.routes)) fail(`${what}.routes must be an array`);
    const seen = new Set<string>();
    const routes = client.routes.map((routeEntry, routeIndex): RouteDeclaration => {
      const where = `${what}.routes[${routeIndex}]`;
      const route = record(routeEntry, where);
      exactKeys(route, ["source", "producer", "active"], where);
      const source = identifier(route.source, `${where}.source`);
      const producer = identifier(route.producer, `${where}.producer`);
      const key = `${producer} ${source}`;
      if (seen.has(key)) fail(`${where} repeats route ${producer} -> ${source}`);
      seen.add(key);
      return { source, producer, active: flag(route.active, `${where}.active`) };
    });
    return {
      id,
      displayName: client.displayName,
      active: flag(client.active, `${what}.active`),
      routes,
    };
  });
  return {
    version: "ingest-clients-v1",
    ...(typeof root.description === "string" ? { description: root.description } : {}),
    clients,
  };
}

const quote = (value: string): string => `'${value.replaceAll("'", "''")}'`;
const bit = (value: boolean): string => (value ? "1" : "0");

/**
 * The SQL. Insert-if-absent for every row; `active` converges for the client
 * and its routes because that flag is the one thing the declaration is meant
 * to change later. Producers and producer-source pairs are only ever added:
 * a producer may be shared with rows this file does not own.
 */
export function renderIngestClientsSql(config: IngestClientsConfig): string {
  const lines: string[] = [
    "-- GENERATED by scripts/config-bootstrap.ts from config/ingest-clients.json.",
    "-- Do not edit: change the declaration and run `mise run bootstrap:ingest-clients`.",
    "--",
    "-- Idempotent: every INSERT is conditional on its own absence and every UPDATE",
    "-- converges one `active` flag, so applying this file twice changes nothing.",
    "-- It is applied by an operator, never by a migration (docs/processor.md §10).",
    "",
  ];
  for (const client of config.clients) {
    const clientId = quote(client.id);
    lines.push(`-- ingest client ${client.id}`);
    lines.push(
      "INSERT INTO ingest_clients (id, display_name, active)",
      `SELECT ${clientId}, ${quote(client.displayName)}, ${bit(client.active)}`,
      `WHERE NOT EXISTS (SELECT 1 FROM ingest_clients WHERE id = ${clientId});`,
      `UPDATE ingest_clients SET active = ${bit(client.active)}`,
      `WHERE id = ${clientId} AND active <> ${bit(client.active)};`,
    );
    const producers = [...new Set(client.routes.map((route) => route.producer))].sort();
    for (const producer of producers) {
      const producerId = quote(producer);
      lines.push(
        "INSERT INTO producers (id, kind, display_name)",
        `SELECT ${producerId}, 'collector', ${quote(`Shared-R2 collector ${producer}`)}`,
        `WHERE NOT EXISTS (SELECT 1 FROM producers WHERE id = ${producerId});`,
        "INSERT INTO ingest_client_producers (ingest_client_id, producer_id)",
        `SELECT ${clientId}, ${producerId}`,
        "WHERE NOT EXISTS (SELECT 1 FROM ingest_client_producers",
        `  WHERE ingest_client_id = ${clientId} AND producer_id = ${producerId});`,
      );
    }
    const routes = [...client.routes].sort((left, right) =>
      left.producer === right.producer
        ? left.source.localeCompare(right.source)
        : left.producer.localeCompare(right.producer),
    );
    for (const route of routes) {
      const pair = `producer_id = ${quote(route.producer)} AND source_id = ${quote(route.source)}`;
      const active = bit(route.active);
      lines.push(
        "INSERT INTO producer_sources (producer_id, source_id)",
        `SELECT ${quote(route.producer)}, ${quote(route.source)}`,
        `WHERE NOT EXISTS (SELECT 1 FROM producer_sources WHERE ${pair});`,
        "INSERT INTO ingest_client_routes (ingest_client_id, producer_id, source_id, active)",
        `SELECT ${clientId}, ${quote(route.producer)}, ${quote(route.source)}, ${active}`,
        "WHERE NOT EXISTS (SELECT 1 FROM ingest_client_routes",
        `  WHERE ingest_client_id = ${clientId} AND ${pair});`,
        `UPDATE ingest_client_routes SET active = ${active}`,
        `WHERE ingest_client_id = ${clientId} AND ${pair} AND active <> ${active};`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function loadIngestClientsConfig(repoRoot: string): IngestClientsConfig {
  return parseIngestClientsConfig(JSON.parse(readFileSync(join(repoRoot, CONFIG_PATH), "utf8")));
}

if (import.meta.main) {
  const sql = renderIngestClientsSql(loadIngestClientsConfig(REPO_ROOT));
  mkdirSync(join(REPO_ROOT, dirname(OUTPUT_PATH)), { recursive: true });
  writeFileSync(join(REPO_ROOT, OUTPUT_PATH), sql);
  console.log(`wrote ${OUTPUT_PATH}`);
}
