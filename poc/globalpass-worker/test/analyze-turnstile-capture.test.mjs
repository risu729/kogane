import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { analyzeCapture, sanitizeUrl } from "../scripts/analyze-turnstile-capture.mjs";

test("sanitizeUrl removes query values, challenge paths, and unknown subdomains", () => {
  const secret = "fake-challenge-identifier-1234567890";
  const sanitized = sanitizeUrl(
    `https://random-probe.challenges.cloudflare.com/turnstile/v0/g/${secret}/api.js?ray=${secret}&lang=ja`,
  );
  assert.equal(sanitized.includes(secret), false);
  assert.equal(sanitized.includes("random-probe"), false);
  assert.match(sanitized, /<redacted>/u);
  assert.match(sanitized, /lang=<redacted>/u);
  assert.match(sanitized, /ray=<redacted>/u);
  const shortDynamic = sanitizeUrl(
    "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/f/av0/rch/short1/short2/auto/build/new/normal?lang=ja",
  );
  assert.equal(shortDynamic.includes("short1"), false);
  assert.equal(shortDynamic.includes("short2"), false);
  assert.equal(shortDynamic.includes("build"), false);
});
test("analyzeCapture emits hashes and an AST feature index without raw source", async () => {
  const capture = await mkdtemp(path.join(os.tmpdir(), "kogane-turnstile-test-"));
  await mkdir(path.join(capture, "bodies"));
  const source = [
    "const xhr = new XMLHttpRequest();",
    "xhr.open('POST', '/example');",
    "xhr.setRequestHeader('content-type', 'application/json');",
    "xhr.send(JSON.stringify({value: btoa('x')}));",
    "const encoded = new TextEncoder().encode('x');",
    "crypto.subtle.digest('SHA-256', encoded);",
    "fetch('/next');",
    "const decoded = atob('eA==');",
  ].join("\n");
  const bodyFile = "bodies\\fake.js";
  await writeFile(path.join(capture, "bodies", "fake.js"), source);
  const secret = "fake-challenge-identifier-1234567890";
  const metadata = {
    bodySaved: true,
    bodyFile,
    mimeType: "application/javascript",
    url: `https://challenges.cloudflare.com/turnstile/v0/g/${secret}/api.js?ray=${secret}`,
  };
  await writeFile(path.join(capture, "metadata.ndjson"), `${JSON.stringify(metadata)}\n`);

  const report = await analyzeCapture(capture);
  const serialized = JSON.stringify(report);
  assert.equal(report.artifacts.length, 1);
  assert.equal(report.safety.rawResponseIncluded, false);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes("const xhr"), false);

  const symbols = new Set(report.artifacts[0].features.map((feature) => feature.symbol));
  for (const expected of [
    "fetch",
    "XMLHttpRequest",
    "XMLHttpRequest.open",
    "XMLHttpRequest.send",
    "XMLHttpRequest.setRequestHeader",
    "TextEncoder",
    "JSON.stringify",
    "btoa",
    "atob",
    "crypto.subtle",
    "subtle.digest",
  ]) {
    assert.equal(symbols.has(expected), true, `missing ${expected}`);
  }
});

test("analyzeCapture rejects body paths outside the capture", async () => {
  const capture = await mkdtemp(path.join(os.tmpdir(), "kogane-turnstile-path-test-"));
  const metadata = {
    bodySaved: true,
    bodyFile: "..\\outside.js",
    mimeType: "application/javascript",
    url: "https://challenges.cloudflare.com/turnstile/v0/api.js",
  };
  await writeFile(path.join(capture, "metadata.ndjson"), `${JSON.stringify(metadata)}\n`);
  await assert.rejects(() => analyzeCapture(capture), /escaped the capture directory/u);
});
