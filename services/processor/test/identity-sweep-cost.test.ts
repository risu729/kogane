import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Miniflare, convertV4MiniflareOptions } from "miniflare";
import {
  identitySweepFixture,
  type SeedStatement,
} from "../../../packages/storage-d1/test/identity-sweep-fixture.ts";
import { identitySweepCandidatesSql } from "../../../packages/storage-d1/src/core/identity-sweep-sql.ts";
import {
  CORE_MIGRATIONS_URL,
  migrationFiles,
  migrationSql,
  splitSqlStatements,
} from "../../../packages/storage-d1/src/migrations.ts";

const legacy = readFileSync(
  new URL("../../../packages/storage-d1/test/fixtures/identity-sweep-legacy.sql", import.meta.url),
  "utf8",
);

test("identity sweep lowers mixed and Vpass reads with bounded source-scoped overhead", async () => {
  const seed: SeedStatement[] = [];
  identitySweepFixture(500, 731, seed).close();
  const mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: "export default {fetch(){return new Response('local')}}",
      compatibilityDate: "2026-09-07",
      d1Databases: ["DB"],
    }),
  );
  try {
    const db = await mf.getD1Database("DB");
    for (const file of migrationFiles(CORE_MIGRATIONS_URL)) {
      const statements = splitSqlStatements(migrationSql(CORE_MIGRATIONS_URL, file));
      await db.batch(statements.map((sql) => db.prepare(sql)));
    }
    for (let offset = 0; offset < seed.length; offset += 80)
      await db.batch(
        seed
          .slice(offset, offset + 80)
          .map(({ sql, values }) =>
            values.length ? db.prepare(sql).bind(...values) : db.prepare(sql),
          ),
      );
    for (const source of [null, "mizuho-bank", "vpass"]) {
      const old = await db.prepare(legacy).bind(source, 40).all();
      const updated = await db
        .prepare(identitySweepCandidatesSql(source !== null))
        .bind(source, 40)
        .all();
      expect(old.results.length).toBeGreaterThan(0);
      expect(updated.results).toEqual(old.results);
      if (source === "mizuho-bank")
        expect(updated.meta.rows_read).toBeLessThanOrEqual(old.meta.rows_read + 40);
      else expect(updated.meta.rows_read).toBeLessThan(old.meta.rows_read * 0.95);

      console.info("identity synthetic D1 rows_read", {
        source,
        legacy: old.meta.rows_read,
        updated: updated.meta.rows_read,
      });
    }
  } finally {
    await mf.dispose();
  }
}, 180000);
