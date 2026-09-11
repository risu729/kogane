// The synthetic collector fixtures are shared: the parser tests here, the
// audit tests of services/collector-r2-importer, the identity tests and the
// local pipeline experiment all read the same bytes. Unified plan U04 moved
// them out of the PoC to `tests/fixtures/observation-pipeline/`, unchanged
// byte for byte; `tests/fixtures/MANIFEST.sha256` and
// `tests/fixture-manifest.test.ts` prove it (acceptance test G0-04).
import { fileURLToPath } from "node:url";

export const FIXTURES_ROOT = fileURLToPath(
  new URL("../../../tests/fixtures/observation-pipeline/", import.meta.url),
);
