import { getPlatformProxy } from "wrangler";
import {
  observationStore,
  latestBalances,
  positionsWithValuations,
} from "../../evidence-browser/src/observations.ts";
const proxy = await getPlatformProxy<{ DB: D1Database }>({
  configPath: new URL("../wrangler.diagnostic.jsonc", import.meta.url).pathname,
  persist: false,
  remoteBindings: true,
});
try {
  for (const [name, query] of [
    ["balances", latestBalances],
    ["positions", positionsWithValuations],
  ] as const) {
    try {
      const rows = await query(observationStore(proxy.env.DB));
      console.log(JSON.stringify({ name, status: "ok", count: rows.length }));
    } catch (error) {
      // Queries contain only code-owned SQL with no provider values. Reveal
      // known engine diagnostics only, never a result or arbitrary error text.
      const message = error instanceof Error ? error.message : "";
      const known =
        /(?:no such (?:table|column): [a-zA-Z_][a-zA-Z0-9_.]*|ambiguous column name: [a-zA-Z_][a-zA-Z0-9_.]*|too many [a-z ]+|parser stack overflow|Expression tree is too large[^:]*|SQLITE_[A-Z_]+|result_limit_exceeded)/g;
      console.log(
        JSON.stringify({
          name,
          status: "failed",
          diagnostics: message.match(known) ?? ["unknown_engine_error"],
          engineSummary: message.startsWith("D1_ERROR:")
            ? message
                .replace(/"[^"]*"|'[^']*'/g, "<quoted>")
                .replace(/[^a-zA-Z _:.,()<>-]/g, "#")
                .slice(0, 240)
            : "non-D1 error",
        }),
      );
    }
  }
} finally {
  await proxy.dispose();
}
