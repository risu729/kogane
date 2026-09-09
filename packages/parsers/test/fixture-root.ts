// The synthetic collector fixtures did not move with the parsers (design
// review D07): they are shared with the PoC entry points and with the audit
// tests of services/collector-r2-importer, so they stay where every consumer
// already reads them. Only the parser modules moved into this package.
import { fileURLToPath } from "node:url";

export const FIXTURES_ROOT = fileURLToPath(
  new URL("../../../poc/observation-pipeline/fixtures/", import.meta.url),
);
