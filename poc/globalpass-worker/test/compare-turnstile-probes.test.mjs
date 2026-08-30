import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { compareProbeFiles } from "../scripts/compare-turnstile-probes.mjs";

function syntheticProbe(challengeIdentifier, payloadSuffix) {
  const scriptUrl = `https://challenges.cloudflare.com/turnstile/v0/b/${challengeIdentifier}/api.js`;
  const script = [
    "function transmit(value) {",
    "  const xhr = new XMLHttpRequest();",
    "  xhr.open('POST', '/flow');",
    "  xhr.send(JSON.stringify({ value }));",
    "}",
    "transmit('example');",
  ].join("\n");
  return {
    requests: [
      {
        url: scriptUrl,
        method: "GET",
        resourceType: "Script",
        responseHeaders: { "content-type": "application/javascript" },
        responseBody: script,
        responseBodyBase64Encoded: false,
      },
      {
        url: `https://challenges.cloudflare.com/turnstile/v0/b/${challengeIdentifier}/flow?ray=${challengeIdentifier}`,
        method: "POST",
        resourceType: "XHR",
        status: 200,
        requestHeaders: { "content-type": "application/json", "cf-chl": challengeIdentifier },
        requestPostData: JSON.stringify({ payload: `value-${payloadSuffix}` }),
        initiator: {
          stack: {
            callFrames: [{ functionName: "transmit", url: scriptUrl, lineNumber: 3, columnNumber: 6 }],
          },
        },
      },
    ],
  };
}

test("compareProbeFiles compares structure without emitting private values", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kogane-turnstile-compare-"));
  const leftSecret = "fake-left-challenge-identifier-123456";
  const rightSecret = "fake-right-challenge-identifier-654321";
  const left = path.join(directory, "left.json");
  const right = path.join(directory, "right.json");
  await writeFile(left, JSON.stringify(syntheticProbe(leftSecret, "a")));
  await writeFile(right, JSON.stringify(syntheticProbe(rightSecret, "longer")));

  const report = await compareProbeFiles(left, right);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(leftSecret), false);
  assert.equal(serialized.includes(rightSecret), false);
  assert.equal(serialized.includes("transmit"), false);
  assert.equal(serialized.includes("value-longer"), false);
  assert.equal(report.comparison.sameCapturedScriptBuild, true);
  assert.equal(report.comparison.challengeExecutionSourcesCaptured, true);
  assert.equal(report.comparison.posts[0].sameRawBodySha256, false);
  assert.equal(report.left.posts[0].initiatorFrames[0].enclosingFunction.kind, "FunctionDeclaration");
});
