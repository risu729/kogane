// Conformance checks every observation API implementation must pass: the
// local PoC store (Bun), the hosted synthetic demo, and the production
// evidence-browser Worker (both under workerd). Runner-agnostic: each check
// throws on failure, and a small test file per runtime registers them.
//
// The checks prove three things from the shared schema alone:
//   * `/api/meta` is valid and advertises exactly what the target expects.
//   * Every advertised capability works; every parameter a capability does
//     not grant is refused with 400.
//   * Authentication is not a capability. The target's `get` carries its own
//     credentials; nothing here weakens or replaces that gate.
import type { ApiCapabilities, ApiMetadata } from "../shared/api-contract.ts";
import { validApiResponse } from "../shared/api-validation.ts";
import { validEvidenceResponse } from "../shared/evidence-validation.ts";
import {
  allowedQueryParameters,
  capabilityGrants,
  LIST_REQUEST_SCHEMA,
  MEASURE_VIEWS,
  OBSERVATION_API_CONTRACT_VERSION,
  type ListPath,
} from "../shared/api-schema.ts";

export interface ConformanceTarget {
  /** An authenticated request; credentials are the target's concern. */
  get(path: string, method?: "GET" | "POST"): Promise<Response>;
  /** The capabilities this implementation is expected to advertise. */
  expected: ApiCapabilities;
}
export interface ConformanceCheck {
  name: string;
  run(target: ConformanceTarget): Promise<void>;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function same(actual: unknown, expected: unknown): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}
async function ok(target: ConformanceTarget, path: string): Promise<unknown> {
  const response = await target.get(path);
  assert(response.status === 200, `${path}: expected 200, got ${response.status}`);
  assert(response.headers.get("cache-control") === "no-store", `${path}: not no-store`);
  const body: unknown = await response.json();
  assert(validApiResponse(path.split("?", 1)[0]!, body), `${path}: fails the shared validator`);
  return body;
}
async function refused(target: ConformanceTarget, path: string, status = 400): Promise<void> {
  const response = await target.get(path);
  assert(response.status === status, `${path}: expected ${status}, got ${response.status}`);
}
async function metadata(target: ConformanceTarget): Promise<ApiMetadata> {
  return (await ok(target, "/api/meta")) as ApiMetadata;
}

/** Well-formed sample values; every list filter tolerates a value that matches nothing. */
const SAMPLE: Record<string, string> = {
  source: "conformance-source",
  account: "conformance-account",
  from: "2026-01-01",
  to: "2026-01-31",
  q: "conformance",
  instrument: "JPY",
  metric: "cash",
  offset: "0",
  latestOffset: "0",
  cursor: "1",
  view: "balances",
  kind: "transactions",
  identityRead: "latest",
};
/** Parameters a path needs before any other parameter is meaningful. */
const BASE: Partial<Record<ListPath, Record<string, string>>> = {
  "/api/filter-options": { kind: "balances" },
};
const LISTS = Object.keys(LIST_REQUEST_SCHEMA) as ListPath[];
const COLLECTIONS: ListPath[] = ["/api/transactions", "/api/balances", "/api/positions"];

function withParams(path: ListPath, params: Record<string, string>): string {
  const search = new URLSearchParams(params);
  return search.size ? `${path}?${search}` : path;
}
function rowsOf(body: unknown, path: ListPath): Record<string, unknown>[] {
  const value = body as Record<string, unknown[]>;
  if (path === "/api/transactions") return value["transactions"] as Record<string, unknown>[];
  if (path === "/api/balances")
    return [...value["latest"]!, ...value["history"]!] as Record<string, unknown>[];
  return (value["positions"] as { position: Record<string, unknown> }[]).map(
    (entry) => entry.position,
  );
}

export const CONFORMANCE_CHECKS: ConformanceCheck[] = [
  {
    name: "metadata is valid and advertises exactly the expected capabilities",
    async run(target) {
      const meta = await metadata(target);
      assert(meta.capabilities.contractVersion === OBSERVATION_API_CONTRACT_VERSION, "version");
      assert(
        same(meta.capabilities, target.expected),
        `capabilities differ from the expected object: ${JSON.stringify(meta.capabilities)}`,
      );
      await refused(target, "/api/meta?unexpected=1");
    },
  },
  {
    name: "writes are refused regardless of capabilities",
    async run(target) {
      const response = await target.get("/api/meta", "POST");
      assert(response.status === 405, `POST /api/meta: expected 405, got ${response.status}`);
    },
  },
  {
    name: "lists answer without parameters and carry coverage only under offset-v1",
    async run(target) {
      const { capabilities } = await metadata(target);
      for (const path of [...COLLECTIONS, "/api/artifacts" as const]) {
        const body = (await ok(target, path)) as Record<string, unknown>;
        const paged = capabilities.paginationVersion === "offset-v1";
        assert(
          Object.hasOwn(body, "coverage") === paged,
          `${path}: coverage record must be present exactly under offset-v1`,
        );
        if (paged) {
          const coverage = body["coverage"] as { limit: unknown; truncated: unknown };
          assert(typeof coverage.limit === "number", `${path}: coverage.limit`);
          assert(typeof coverage.truncated === "boolean", `${path}: coverage.truncated`);
        }
      }
      await ok(target, "/api/overview");
      if (capabilities.collectionFilters) await ok(target, "/api/filter-options?kind=transactions");
      else {
        const response = await target.get("/api/filter-options");
        assert(response.status !== 200, "filter-options served without collectionFilters");
      }
    },
  },
  {
    name: "each schema parameter is accepted when granted and refused with 400 otherwise",
    async run(target) {
      const { capabilities } = await metadata(target);
      for (const path of LISTS) {
        const schema: Record<string, string> = LIST_REQUEST_SCHEMA[path];
        const granted = allowedQueryParameters(path, capabilities);
        const base = Object.fromEntries(
          Object.entries(BASE[path] ?? {}).filter(([name]) => granted.includes(name)),
        );
        for (const [name, requirement] of Object.entries(schema)) {
          const request = withParams(path, { ...base, [name]: SAMPLE[name]! });
          if (capabilityGrants(requirement as never, capabilities)) await ok(target, request);
          else await refused(target, request);
        }
        await refused(target, withParams(path, { ...base, unexpected: "1" }));
      }
    },
  },
  {
    name: "measure views outside the advertised set are refused",
    async run(target) {
      const { capabilities } = await metadata(target);
      await refused(target, "/api/balances?view=nonsense");
      for (const view of MEASURE_VIEWS) {
        const request = `/api/balances?view=${view}`;
        if (capabilities.measureViews.includes(view)) await ok(target, request);
        else await refused(target, request);
      }
    },
  },
  {
    name: "identity reads are served exactly when a read mode is advertised",
    async run(target) {
      const { capabilities } = await metadata(target);
      const paths = ["/api/identity/connections", "/api/identity/accounts?offset=0"];
      for (const path of paths) {
        if (capabilities.identityReadModes.includes("latest")) await ok(target, path);
        else {
          const response = await target.get(path);
          assert(response.status !== 200, `${path}: served without identityReadModes`);
        }
      }
    },
  },
  {
    name: "the sealed evidence history is served exactly when advertised",
    async run(target) {
      const { capabilities } = await metadata(target);
      const response = await target.get("/api/evidence/v1/meta");
      if (capabilities.evidenceHistory) {
        assert(response.status === 200, `evidence meta: ${response.status}`);
        assert(validEvidenceResponse("/api/evidence/v1/meta", await response.json()), "meta");
      } else assert(response.status !== 200, "evidence history served without the capability");
    },
  },
  {
    name: "rows carry organization and products exactly when advertised",
    async run(target) {
      const { capabilities } = await metadata(target);
      let rows = 0;
      for (const path of COLLECTIONS) {
        for (const row of rowsOf(await ok(target, path), path)) {
          rows += 1;
          assert(
            Object.hasOwn(row, "organization") === capabilities.organizedDisplay,
            `${path}: organization presence must follow organizedDisplay`,
          );
          const organization = row["organization"] as { product?: unknown } | undefined;
          assert(
            capabilities.financialProducts || organization?.product === undefined,
            `${path}: a product claim without financialProducts`,
          );
        }
      }
      assert(rows > 0, "the target must hold at least one observation row");
    },
  },
  {
    name: "raw evidence for a listed artifact is served inert",
    async run(target) {
      const listing = (await ok(target, "/api/artifacts")) as { artifacts: { sha256: string }[] };
      const artifact = listing.artifacts[0];
      assert(artifact, "the target must list at least one artifact");
      const path = `/api/raw/${artifact.sha256}`;
      const response = await target.get(path);
      assert(response.status === 200, `${path}: ${response.status}`);
      assert(response.headers.get("x-content-type-options") === "nosniff", `${path}: nosniff`);
      assert(response.headers.get("content-security-policy")?.includes("sandbox"), `${path}: csp`);
      assert(response.headers.get("cache-control") === "no-store", `${path}: no-store`);
      await refused(target, `${path}?unexpected=1`);
    },
  },
];
