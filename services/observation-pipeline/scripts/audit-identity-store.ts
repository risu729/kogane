import { getPlatformProxy } from "wrangler";
import { IDENTITY_AUDIT_QUERIES, validateIdentityAudit } from "../src/identity-audit.ts";

// A single read-only batch observes a consistent snapshot while backfill runs.
// Catch errors without exposing provider data, SQL diagnostics, or credentials.
let proxy: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>> | undefined;
let stage = "setup";
try {
  if (process.argv.length > 2) throw new Error("unexpected_arguments");
  proxy = await getPlatformProxy<{ DB: D1Database }>({
    configPath: new URL("../wrangler.diagnostic.jsonc", import.meta.url).pathname,
    persist: false,
    remoteBindings: true,
  });
  stage = "read";
  const result = await proxy.env.DB.batch(
    IDENTITY_AUDIT_QUERIES.map((query) => proxy!.env.DB.prepare(query.sql)),
  );
  stage = "validate";
  const sections = validateIdentityAudit(result.map((row) => row.results));
  console.log(
    JSON.stringify({
      audit: "identity-store",
      snapshotAt: new Date().toISOString(),
      interpretation: "coverage-is-a-snapshot-not-a-backfill-failure",
      sections,
    }),
  );
} catch (error) {
  const message = error instanceof Error ? error.message : "";
  const category = /no such table/.test(message)
    ? "missing_table"
    : /no such column/.test(message)
      ? "missing_column"
      : /too many references/i.test(message)
        ? "view_reference_limit"
        : /too many SQL variables/i.test(message)
          ? "sql_variable_limit"
          : /time|duration/i.test(message)
            ? "timeout"
            : /too many|limit/i.test(message)
              ? "other_limit"
              : /^identity_audit_/.test(message)
                ? "invalid_result"
                : "other";
  console.error(
    JSON.stringify({
      audit: "identity-store",
      error: "identity_audit_failed",
      stage,
      category,
      diagnostic: [
        "FROM clause",
        "compound SELECT",
        "expression tree",
        "SQL statements",
        "SQLITE",
        "subrequest",
        "authorization",
        "Too many API",
        "column",
        "length",
        "size",
        "session",
      ].filter((token) => message.toLowerCase().includes(token.toLowerCase())),
    }),
  );
  process.exitCode = 1;
} finally {
  try {
    await proxy?.dispose();
  } catch {
    console.error(
      JSON.stringify({
        audit: "identity-store",
        error: "identity_audit_cleanup_failed",
      }),
    );
    process.exitCode = 1;
  }
}
