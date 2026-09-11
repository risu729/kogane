import assert from "node:assert/strict";
import test from "node:test";

import {
  detectVmPropertyResolvers,
  knownTokenCounts,
  positionAnalysis,
} from "../scripts/analyze-turnstile-debugger-capture.mjs";

test("detects VM host-property resolution without reporting raw identifiers", () => {
  const source = [
    "function syntheticVm(hostObject, propertyKey) {",
    "  let resolvedTarget;",
    "  resolvedTarget = hostObject === void 0 ? propertyKey : hostObject[propertyKey];",
    "  return resolvedTarget(1, 2);",
    "}",
  ].join("\n");
  const sites = detectVmPropertyResolvers(source);

  assert.equal(sites.length, 1);
  assert.equal(sites[0].hostVoidFallback, true);
  assert.equal(sites[0].propertyNameFlowsToElementAccess, true);
  assert.equal(sites[0].directResolvedTargetCalls, 1);
  assert.equal(sites[0].callApplyResolvedTargetCalls, 0);
  const serialized = JSON.stringify(sites);
  assert.doesNotMatch(serialized, /hostObject|propertyKey/u);
});

test("reports only allowlisted Web API token counts", () => {
  const counts = knownTokenCounts(
    "navigator.userAgent; performance.now(); localStorage.getItem('x'); privateChallengeValue;",
  );

  assert.equal(counts.navigator, 1);
  assert.equal(counts.userAgent, 1);
  assert.equal(counts.performance, 1);
  assert.equal(counts.localStorage, 1);
  assert.equal(Object.hasOwn(counts, "privateChallengeValue"), false);
});

test("position summary hashes arbitrary callee names", () => {
  const source = "function wrapper(value) { return privateTransport(value); }";
  const columnNumber = source.indexOf("privateTransport") + 2;
  const summary = positionAnalysis(source, { lineNumber: 0, columnNumber });

  assert.equal(summary.call.callee.nameLength, "privateTransport".length);
  assert.equal(typeof summary.call.callee.nameSha256, "string");
  assert.doesNotMatch(JSON.stringify(summary), /privateTransport/u);
});
