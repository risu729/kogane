// The local PoC store runs the same conformance checks as the hosted demo and
// the production Worker (services/evidence-browser/test/conformance.test.ts).
import { describe, test } from "bun:test";
import { createApi } from "../src/api.ts";
import { LOCAL_STORE_CAPABILITIES } from "../../../packages/observation-shared/src/api-schema.ts";
import { CONFORMANCE_CHECKS, type ConformanceTarget } from "../../../packages/observation-shared/test-support/api-conformance.ts";
import { buildFixture } from "./fixture.ts";

describe("observation API conformance: local PoC store", () => {
  const app = createApi(buildFixture().store);
  const target: ConformanceTarget = {
    expected: LOCAL_STORE_CAPABILITIES,
    get: async (path, method = "GET") =>
      app.fetch(new Request(`http://api.test${path}`, { method })),
  };
  for (const check of CONFORMANCE_CHECKS) test(check.name, () => check.run(target));
});
