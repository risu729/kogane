import { expect, test } from "bun:test";
import jobs from "../../../config/alarm-jobs.json";
import { OPERATION_CONNECTIONS } from "../../../packages/collection/src/operation-rpc";
import { collectionRequestTarget, connectionFor } from "../src/operations/collection-targets";

const ON = { OPS_DISPATCH_ENABLED: "true", OPS_COLLECTOR_DISPATCH_CONNECTIONS: '["sony-bank"]' };

test("a collection job names the CORE source its request carries", () => {
  expect(collectionRequestTarget(ON, "sony-bank")).toEqual({
    source: "sony-bank",
    dispatch: "enabled",
  });
  // The job id is not the source: the request names what terminals register under.
  expect(collectionRequestTarget(ON, "prestia-globalpass")).toEqual({
    source: "global-pass",
    dispatch: "connection_disabled",
  });
  expect(collectionRequestTarget(ON, "vpoint")?.source).toBe("v-point");
  expect(collectionRequestTarget(ON, "sbi-shinsei")?.source).toBe("sbi-shinsei-bank");
});

test("dispatch is reported as the lane decides it", () => {
  expect(collectionRequestTarget({}, "sony-bank")?.dispatch).toBe("lane_disabled");
  expect(
    collectionRequestTarget({ ...ON, OPS_DISPATCH_ENABLED: "false" }, "sony-bank")?.dispatch,
  ).toBe("lane_disabled");
  expect(collectionRequestTarget({ OPS_DISPATCH_ENABLED: "true" }, "sony-bank")?.dispatch).toBe(
    "connection_disabled",
  );
  expect(
    collectionRequestTarget(
      { OPS_DISPATCH_ENABLED: "true", OPS_COLLECTOR_DISPATCH_CONNECTIONS: "sony-bank" },
      "sony-bank",
    )?.dispatch,
  ).toBe("connection_disabled");
});

test("jobs no collector serves for a request have no target", () => {
  for (const id of ["sbi-vc-keepalive", "processor-tick", "smbc-direct", "vpoint-pay", "unknown"])
    expect(collectionRequestTarget(ON, id)).toBeNull();
});

test("an ambiguous source is no target, never a guess", () => {
  const twice = [
    ...OPERATION_CONNECTIONS,
    {
      ...OPERATION_CONNECTIONS.find((entry) => entry.connectionId === "sony-bank")!,
      connectionId: "sony-bank-2",
    },
  ];
  expect(collectionRequestTarget(ON, "sony-bank", twice)).toBeNull();
});

test("every target resolves back to its own job on the dispatch lane", () => {
  const collectionJobs = jobs.filter((job) => job.kind === "collection").map((job) => job.id);
  expect(collectionJobs.length).toBeGreaterThan(0);
  for (const id of collectionJobs) {
    const target = collectionRequestTarget(ON, id);
    expect(target).not.toBeNull();
    expect(connectionFor(OPERATION_CONNECTIONS, target!.source, "collect")?.connectionId).toBe(id);
  }
});
