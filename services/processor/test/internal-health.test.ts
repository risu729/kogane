// The Processor's internal health route (unified plan 11 §6, U14). This Worker
// is published on no hostname, so the release reaches it only through the App's
// service binding; these checks pin both halves of that — who is refused, and
// what the answer contains.
//
// Synthetic data only: the harness applies the real migrations to a local D1
// and seeds nothing from a provider.
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { Miniflare } from "miniflare";
import {
  DATA_MARKER_KEY,
  INTERNAL_CALLER_HEADER,
  INTERNAL_HEALTH_PATH,
  declaredFlags,
  internalHealthBody,
  internalHealthRoute,
  releaseSha,
  serviceBindingRequest,
} from "../src/internal-health.ts";
import { startPipeline } from "./harness.ts";

let mf: Miniflare;
let env: Env;

beforeAll(async () => {
  ({ mf, env } = await startPipeline(undefined, { RELEASE_SHA: "b".repeat(40) }));
});
afterAll(async () => {
  await mf.dispose();
});

function internalRequest(headers: Record<string, string>): Request {
  return new Request(`https://observation-pipeline.internal${INTERNAL_HEALTH_PATH}`, { headers });
}

test("only a service-binding caller may read the internal health route", () => {
  // What the App sends: a request it built itself, naming the caller.
  expect(serviceBindingRequest(internalRequest({ [INTERNAL_CALLER_HEADER]: "kogane-app" }))).toBe(
    true,
  );
  // A request that entered from the internet is terminated at the edge first,
  // which always attaches CF-Connecting-IP.
  expect(
    serviceBindingRequest(
      internalRequest({
        [INTERNAL_CALLER_HEADER]: "kogane-app",
        "cf-connecting-ip": "203.0.113.7",
      }),
    ),
  ).toBe(false);
  // And a binding caller that does not name itself is refused too.
  expect(serviceBindingRequest(internalRequest({}))).toBe(false);
  expect(serviceBindingRequest(internalRequest({ [INTERNAL_CALLER_HEADER]: "Not A Name" }))).toBe(
    false,
  );
});

test("the route refuses a request that arrived from the edge", async () => {
  // `dispatchFetch` simulates an edge request (it sets CF-Connecting-IP), which
  // is exactly the caller this route must not answer — even with the header.
  const response = await mf.dispatchFetch(`https://private.test${INTERNAL_HEALTH_PATH}`, {
    headers: { [INTERNAL_CALLER_HEADER]: "kogane-evidence-browser" },
  });
  expect(response.status).toBe(403);
  expect(response.headers.get("x-kogane-error")).toBe("service_binding_required");
  expect(await response.text()).toBe("Forbidden");
});

test("the route answers a request built the way the App builds it", async () => {
  // The App constructs a fresh Request over the service binding with only the
  // caller header (services/app/src/health.ts): no CF-Connecting-IP, because
  // no edge was involved. That request, and only that one, is answered.
  const response = await internalHealthRoute(
    internalRequest({ [INTERNAL_CALLER_HEADER]: "kogane-evidence-browser" }),
    env,
    INTERNAL_HEALTH_PATH,
  );
  expect(response?.status).toBe(200);
  const body = (await response?.json()) as Record<string, unknown>;
  expect(body["ok"]).toBe(true);
  expect(body["releaseSha"]).toBe("b".repeat(40));
  // Every other path is somebody else's, untouched by this module.
  expect(await internalHealthRoute(internalRequest({}), env, "/status")).toBeNull();
  expect(
    await internalHealthRoute(internalRequest({}), env, `${INTERNAL_HEALTH_PATH}/`),
  ).toBeNull();
});

test("a verb other than GET is not a route at all", async () => {
  const response = await mf.dispatchFetch(`https://private.test${INTERNAL_HEALTH_PATH}`, {
    method: "POST",
  });
  expect(response.status).toBe(404);
});

test("the answer carries the build identity, the stores, the flags and the cursors", async () => {
  const { status, body } = await internalHealthBody(env);
  const health = body as Record<string, any>;
  expect(status).toBe(200);
  expect(health["ok"]).toBe(true);
  expect(health["worker"]).toBe("kogane-observation-pipeline");
  expect(health["releaseSha"]).toBe("b".repeat(40));
  expect(health["core"]).toMatchObject({ bound: true, ok: true });
  expect(health["read"]).toMatchObject({ bound: true, ok: true });
  expect(health["data"]).toMatchObject({ bound: true, ok: true, markerPresent: false });
  expect(health["bindings"]).toEqual({ DB: true, READ: true, EVIDENCE: true, DATA: true });
  // Every lane flag this deployment declares, as the string it is: the release
  // sees that the Worker it just uploaded holds the configuration it carried.
  expect(Object.keys(health["flags"] as Record<string, string>)).toContain(
    "SHARED_R2_INGEST_ENABLED",
  );
  expect(health["collectionScan"]).toMatchObject({ lane: "collection_scan" });
  // Nothing has been projected in this fixture, so the READ pointer is absent
  // — reported as absence, never as a fresh pointer.
  expect(health["readPointer"]).toEqual({ present: false });
});

test("the DATA probe is one head of a fixed key and writes nothing", async () => {
  const before = (await env.DATA.list()).objects.length;
  await env.DATA.put(DATA_MARKER_KEY, "synthetic");
  const { body } = await internalHealthBody(env);
  expect((body as Record<string, any>)["data"]).toMatchObject({ markerPresent: true });
  expect((await env.DATA.list()).objects.length).toBe(before + 1);
  await env.DATA.delete(DATA_MARKER_KEY);
});

test("a release sha is only reported when it is one", () => {
  expect(releaseSha({ RELEASE_SHA: "c".repeat(40) })).toBe("c".repeat(40));
  expect(releaseSha({ RELEASE_SHA: "" })).toBe("");
  expect(releaseSha({ RELEASE_SHA: "not-a-sha" })).toBe("");
  expect(releaseSha({})).toBe("");
});

test("the flag summary names every lane flag of the configuration", () => {
  const flags = declaredFlags(env);
  expect(Object.keys(flags).sort()).toEqual([
    "BALANCE_PROJECTION_ENABLED",
    "OPS_DISPATCH_ENABLED",
    "READ_PROJECTION_ENABLED",
    "RECONCILIATION_ENABLED",
    "RELEASE_CANDIDATES_ENABLED",
    "REPORTS_ENABLED",
    "REWARD_CLAIMS_ENABLED",
    "REWARD_READ_PROJECTION_ENABLED",
    "SHARED_R2_INGEST_ENABLED",
  ]);
});
