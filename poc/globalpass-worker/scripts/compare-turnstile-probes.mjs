#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { analyzeSource, sanitizeUrl, sha256 } from "./analyze-turnstile-capture.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const TURNSTILE_HOST = "challenges.cloudflare.com";
const SAFE_CALLEES = new Set([
  "atob",
  "btoa",
  "fetch",
  "open",
  "send",
  "setRequestHeader",
  "stringify",
]);

function isTurnstileUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === TURNSTILE_HOST || host.endsWith(`.${TURNSTILE_HOST}`);
  } catch {
    return false;
  }
}

function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return null;
  const match = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return match ? String(match[1]) : null;
}

function responseBuffer(request) {
  if (typeof request.responseBody !== "string") return null;
  return request.responseBodyBase64Encoded
    ? Buffer.from(request.responseBody, "base64")
    : Buffer.from(request.responseBody, "utf8");
}

function sourceUrls(source) {
  const urls = [];
  const pattern = /(?:\/\/[#@]\s*sourceURL\s*=\s*|\/\*#\s*sourceURL\s*=\s*)([^\s*]+)/gu;
  for (const match of source.matchAll(pattern)) {
    const candidate = match[1].replace(/["']$/u, "");
    if (isTurnstileUrl(candidate)) urls.push(candidate);
  }
  return [...new Set(urls)];
}

function requestBodyBuffer(request) {
  if (typeof request.requestPostData !== "string") return null;
  return Buffer.from(request.requestPostData, "utf8");
}

function isJavaScriptRequest(request) {
  const contentType = headerValue(request.responseHeaders, "content-type")?.toLowerCase() ?? "";
  let pathname = "";
  try {
    pathname = new URL(request.url).pathname.toLowerCase();
  } catch {
    // Invalid URLs are excluded earlier.
  }
  return (
    request.resourceType === "Script" ||
    contentType.includes("javascript") ||
    contentType.includes("ecmascript") ||
    pathname.endsWith(".js")
  );
}

function tokenShapeSha256(source) {
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    false,
    ts.LanguageVariant.Standard,
    source,
  );
  const hash = createHash("sha256");
  let token;
  do {
    token = scanner.scan();
    if (token === ts.SyntaxKind.Identifier) {
      hash.update("identifier,");
    } else if (
      token === ts.SyntaxKind.StringLiteral ||
      token === ts.SyntaxKind.NumericLiteral ||
      token === ts.SyntaxKind.RegularExpressionLiteral ||
      token === ts.SyntaxKind.NoSubstitutionTemplateLiteral ||
      token === ts.SyntaxKind.TemplateHead ||
      token === ts.SyntaxKind.TemplateMiddle ||
      token === ts.SyntaxKind.TemplateTail
    ) {
      hash.update("literal,");
    } else {
      hash.update(`${token},`);
    }
  } while (token !== ts.SyntaxKind.EndOfFileToken);
  return hash.digest("hex");
}

function shannonEntropy(buffer) {
  if (buffer.length === 0) return 0;
  const counts = new Uint32Array(256);
  for (const byte of buffer) counts[byte] += 1;
  let entropy = 0;
  for (const count of counts) {
    if (!count) continue;
    const probability = count / buffer.length;
    entropy -= probability * Math.log2(probability);
  }
  return Number(entropy.toFixed(4));
}

function shapeClass(character) {
  if (/[A-Z]/u.test(character)) return "A";
  if (/[a-z]/u.test(character)) return "a";
  if (/[0-9]/u.test(character)) return "0";
  if (/\s/u.test(character)) return "_";
  return character;
}

function textShapeSha256(text) {
  const hash = createHash("sha256");
  let previous = null;
  let run = 0;
  for (const character of text) {
    const current = shapeClass(character);
    if (current === previous) {
      run += 1;
      continue;
    }
    if (previous !== null) hash.update(`${previous}:${run},`);
    previous = current;
    run = 1;
  }
  if (previous !== null) hash.update(`${previous}:${run},`);
  return hash.digest("hex");
}

function charClasses(text) {
  const counts = { uppercase: 0, lowercase: 0, digits: 0, whitespace: 0, other: 0 };
  for (const character of text) {
    if (/[A-Z]/u.test(character)) counts.uppercase += 1;
    else if (/[a-z]/u.test(character)) counts.lowercase += 1;
    else if (/[0-9]/u.test(character)) counts.digits += 1;
    else if (/\s/u.test(character)) counts.whitespace += 1;
    else counts.other += 1;
  }
  return counts;
}

function delimiterCounts(text) {
  const delimiters = ["&", "=", ":", ",", '"', ".", "-", "_", "/", "+"];
  return Object.fromEntries(
    delimiters.map((delimiter) => [delimiter, text.split(delimiter).length - 1]),
  );
}

function jsonShape(value, depth = 0) {
  if (depth > 8) return { type: "depth-limit" };
  if (value === null) return { type: "null" };
  if (Array.isArray(value)) {
    const itemShapes = value.slice(0, 32).map((item) => jsonShape(item, depth + 1));
    return {
      type: "array",
      length: value.length,
      itemShapeHashes: [
        ...new Set(itemShapes.map((shape) => sha256(JSON.stringify(shape)))),
      ].sort(),
    };
  }
  if (typeof value === "object") {
    return {
      type: "object",
      fields: Object.entries(value)
        .map(([key, item]) => ({ keySha256: sha256(key), value: jsonShape(item, depth + 1) }))
        .sort((a, b) => a.keySha256.localeCompare(b.keySha256)),
    };
  }
  if (typeof value === "string") {
    return {
      type: "string",
      byteLength: Buffer.byteLength(value),
      shapeSha256: textShapeSha256(value),
    };
  }
  return { type: typeof value };
}

function bodyStructure(body, contentType) {
  const text = body.toString("utf8");
  let encoding = "opaque-text";
  let parsedShape = null;
  const trimmed = text.trim();
  if (contentType?.includes("application/json") || /^[{[]/u.test(trimmed)) {
    try {
      parsedShape = jsonShape(JSON.parse(trimmed));
      encoding = "json";
    } catch {
      // Continue classifying as opaque text.
    }
  }
  if (encoding === "opaque-text" && contentType?.includes("application/x-www-form-urlencoded")) {
    const parameters = new URLSearchParams(text);
    parsedShape = [...parameters.entries()]
      .map(([key, value]) => ({
        keySha256: sha256(key),
        valueByteLength: Buffer.byteLength(value),
        valueShapeSha256: textShapeSha256(value),
      }))
      .sort((a, b) => a.keySha256.localeCompare(b.keySha256));
    encoding = "urlencoded";
  }
  const compact = trimmed.replace(/\s/gu, "");
  const base64Like =
    compact.length > 0 && compact.length % 4 === 0 && /^[A-Za-z0-9+/_=-]+$/u.test(compact);
  return {
    sha256: sha256(body),
    byteLength: body.byteLength,
    encoding,
    base64Like,
    entropyBitsPerByte: shannonEntropy(body),
    charClasses: charClasses(text),
    delimiterCounts: delimiterCounts(text),
    shapeSha256: textShapeSha256(text),
    parsedShape,
  };
}

function safeCallee(expression) {
  let property = null;
  if (ts.isIdentifier(expression)) property = expression.text;
  if (ts.isPropertyAccessExpression(expression)) property = expression.name.text;
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    property = expression.argumentExpression.text;
  }
  if (!property) return null;
  return SAFE_CALLEES.has(property)
    ? { known: property }
    : { nameSha256: sha256(property), nameLength: property.length };
}

function subtreeShape(node) {
  const hash = createHash("sha256");
  let nodes = 0;
  const visit = (current) => {
    nodes += 1;
    hash.update(`${current.kind},`);
    ts.forEachChild(current, visit);
  };
  visit(node);
  return { nodes, shapeSha256: hash.digest("hex") };
}

function functionName(node) {
  if (node.name && ts.isIdentifier(node.name)) return node.name.text;
  if (node.parent && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) {
    return node.parent.name.text;
  }
  if (node.parent && ts.isPropertyAssignment(node.parent)) {
    if (ts.isIdentifier(node.parent.name) || ts.isStringLiteralLike(node.parent.name))
      return node.parent.name.text;
  }
  return null;
}

function artifactLookup(artifactsByUrl, sessionId, rawUrl) {
  return artifactsByUrl.get(`${sessionId ?? ""}\u0000${rawUrl}`) ?? artifactsByUrl.get(rawUrl);
}

function registerArtifactUrl(artifactsByUrl, artifact, sessionId, rawUrl) {
  artifactsByUrl.set(rawUrl, artifact);
  if (sessionId) artifactsByUrl.set(`${sessionId}\u0000${rawUrl}`, artifact);
}

function summarizeInitiatorFrame(frame, artifactsByUrl, sessionId) {
  const sanitizedFrameUrl = sanitizeUrl(frame.url ?? "");
  const summary = {
    url: sanitizedFrameUrl,
    line: Number.isInteger(frame.lineNumber) ? frame.lineNumber + 1 : null,
    column: Number.isInteger(frame.columnNumber) ? frame.columnNumber + 1 : null,
    functionNameSha256: frame.functionName ? sha256(frame.functionName) : null,
    functionNameLength: frame.functionName ? frame.functionName.length : 0,
  };
  const artifact = artifactLookup(artifactsByUrl, sessionId, frame.url);
  if (!artifact || !Number.isInteger(frame.lineNumber) || !Number.isInteger(frame.columnNumber))
    return summary;
  if (frame.lineNumber >= artifact.sourceFile.getLineStarts().length) return summary;

  const position = artifact.sourceFile.getPositionOfLineAndCharacter(
    frame.lineNumber,
    frame.columnNumber,
  );
  let deepestFunction = null;
  let deepestCall = null;
  const visit = (node) => {
    if (position < node.getFullStart() || position > node.end) return;
    if (ts.isFunctionLike(node)) deepestFunction = node;
    if (ts.isCallExpression(node)) deepestCall = node;
    ts.forEachChild(node, visit);
  };
  visit(artifact.sourceFile);

  if (deepestCall) summary.call = safeCallee(deepestCall.expression);
  if (deepestFunction) {
    const start = artifact.sourceFile.getLineAndCharacterOfPosition(
      deepestFunction.getStart(artifact.sourceFile, false),
    );
    const end = artifact.sourceFile.getLineAndCharacterOfPosition(deepestFunction.end);
    const name = functionName(deepestFunction);
    const functionAnalysis = analyzeSource(
      deepestFunction.getText(artifact.sourceFile),
      `function-${start.line + 1}.js`,
    );
    summary.enclosingFunction = {
      kind: ts.SyntaxKind[deepestFunction.kind],
      startLine: start.line + 1,
      endLine: end.line + 1,
      parameterCount: deepestFunction.parameters?.length ?? 0,
      async: Boolean(
        deepestFunction.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword),
      ),
      generator: Boolean(deepestFunction.asteriskToken),
      nameSha256: name ? sha256(name) : null,
      nameLength: name?.length ?? 0,
      subtree: subtreeShape(deepestFunction),
      features: functionAnalysis.features,
    };
  }
  return summary;
}

function initiatorFrames(request, artifactsByUrl) {
  const frames = request.initiator?.stack?.callFrames;
  if (!Array.isArray(frames)) return [];
  return frames.map((frame) => summarizeInitiatorFrame(frame, artifactsByUrl, request.sessionId));
}

function challengeHeaderSummary(headers) {
  const result = {};
  for (const name of ["cf-chl", "cf-chl-ra"]) {
    const value = headerValue(headers, name);
    if (value !== null) result[name] = { byteLength: Buffer.byteLength(value) };
  }
  return result;
}

export async function analyzeProbe(filename) {
  const raw = await readFile(filename);
  const probe = JSON.parse(raw.toString("utf8"));
  const requests = Array.isArray(probe.requests)
    ? probe.requests.filter((request) => isTurnstileUrl(request.url))
    : [];
  const scriptArtifacts = [];
  const artifactsByUrl = new Map();
  const debuggerArtifactsBySha256 = new Map();

  for (const script of Array.isArray(probe.scripts) ? probe.scripts : []) {
    if (
      (!isTurnstileUrl(script.url) && !isTurnstileUrl(script.targetUrl)) ||
      typeof script.scriptSource !== "string"
    )
      continue;
    const body = Buffer.from(script.scriptSource, "utf8");
    const digest = sha256(body);
    const nonWhitespaceCharacters = script.scriptSource.replace(/\s/gu, "").length;
    let artifact = debuggerArtifactsBySha256.get(digest);
    if (artifact) {
      artifact.safe.occurrences += 1;
      if (script.targetType) artifact.safe.targetTypes.push(String(script.targetType));
      if (script.url) artifact.safe.urls.push(sanitizeUrl(script.url));
      if (script.targetUrl) artifact.safe.targetUrls.push(sanitizeUrl(script.targetUrl));
      if (script.url) registerArtifactUrl(artifactsByUrl, artifact, script.sessionId, script.url);
      continue;
    }
    if (nonWhitespaceCharacters <= 100) {
      artifact = {
        rawUrl: script.url,
        sourceFile: ts.createSourceFile(
          `debugger-${digest.slice(0, 12)}.js`,
          script.scriptSource,
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.JS,
        ),
        safe: {
          kind: "debugger-nonsubstantive-source",
          urls: script.url ? [sanitizeUrl(script.url)] : [],
          targetTypes: script.targetType ? [String(script.targetType)] : [],
          targetUrls: script.targetUrl ? [sanitizeUrl(script.targetUrl)] : [],
          sha256: digest,
          byteLength: body.byteLength,
          nonWhitespaceCharacters,
          occurrences: 1,
        },
      };
      debuggerArtifactsBySha256.set(digest, artifact);
      scriptArtifacts.push(artifact);
      if (script.url) registerArtifactUrl(artifactsByUrl, artifact, script.sessionId, script.url);
      continue;
    }
    const analysis = analyzeSource(script.scriptSource, `debugger-${digest.slice(0, 12)}.js`);
    const sourceFile = ts.createSourceFile(
      `debugger-${digest.slice(0, 12)}.js`,
      script.scriptSource,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    artifact = {
      rawUrl: script.url,
      sourceFile,
      safe: {
        kind: "debugger-script-source",
        urls: script.url ? [sanitizeUrl(script.url)] : [],
        targetTypes: script.targetType ? [String(script.targetType)] : [],
        targetUrls: script.targetUrl ? [sanitizeUrl(script.targetUrl)] : [],
        sha256: digest,
        byteLength: body.byteLength,
        nonWhitespaceCharacters,
        occurrences: 1,
        tokenShapeSha256: tokenShapeSha256(script.scriptSource),
        parseDiagnostics: analysis.parseDiagnostics,
        ast: analysis.ast,
        features: analysis.features,
      },
    };
    debuggerArtifactsBySha256.set(digest, artifact);
    scriptArtifacts.push(artifact);
    if (script.url) registerArtifactUrl(artifactsByUrl, artifact, script.sessionId, script.url);
  }

  for (const artifact of debuggerArtifactsBySha256.values()) {
    artifact.safe.urls = [...new Set(artifact.safe.urls)].sort();
    artifact.safe.targetTypes = [...new Set(artifact.safe.targetTypes)].sort();
    artifact.safe.targetUrls = [...new Set(artifact.safe.targetUrls)].sort();
  }

  for (const request of requests) {
    const body = responseBuffer(request);
    if (!body) continue;
    const source = body.toString("utf8");
    const analysis = analyzeSource(source, `turnstile-${sha256(body).slice(0, 12)}.js`);
    const directScript = isJavaScriptRequest(request);
    const dynamicScript =
      !directScript &&
      body.byteLength >= 1024 &&
      analysis.parseDiagnostics.length === 0 &&
      (analysis.ast.calls > 0 || analysis.ast.functions > 0);
    if (!directScript && !dynamicScript) continue;
    const executionUrls = sourceUrls(source);
    const sourceFile = ts.createSourceFile(
      `turnstile-${sha256(body).slice(0, 12)}.js`,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    const artifact = {
      rawUrl: request.url,
      sourceFile,
      safe: {
        kind: directScript ? "script-response" : "dynamic-script-response",
        url: sanitizeUrl(request.url),
        executionUrls: executionUrls.map(sanitizeUrl).sort(),
        sha256: sha256(body),
        byteLength: body.byteLength,
        contentType: headerValue(request.responseHeaders, "content-type"),
        tokenShapeSha256: tokenShapeSha256(source),
        parseDiagnostics: analysis.parseDiagnostics,
        ast: analysis.ast,
        features: analysis.features,
      },
    };
    scriptArtifacts.push(artifact);
    registerArtifactUrl(artifactsByUrl, artifact, request.sessionId, request.url);
    for (const executionUrl of executionUrls) {
      registerArtifactUrl(artifactsByUrl, artifact, request.sessionId, executionUrl);
    }
  }

  const posts = requests
    .filter((request) => request.method === "POST")
    .map((request) => {
      const body = requestBodyBuffer(request) ?? Buffer.alloc(0);
      const contentType =
        headerValue(request.requestHeadersExtra, "content-type") ??
        headerValue(request.requestHeaders, "content-type");
      return {
        url: sanitizeUrl(request.url),
        resourceType: request.resourceType ?? null,
        status: Number.isFinite(request.status) ? request.status : null,
        contentType,
        body: bodyStructure(body, contentType?.toLowerCase() ?? null),
        requestHeaderNames: [
          ...new Set(
            [
              ...Object.keys(request.requestHeaders ?? {}),
              ...Object.keys(request.requestHeadersExtra ?? {}),
            ].map((name) => name.toLowerCase()),
          ),
        ].sort(),
        challengeHeaders: challengeHeaderSummary({
          ...(request.requestHeaders ?? {}),
          ...(request.requestHeadersExtra ?? {}),
        }),
        initiatorFrames: initiatorFrames(request, artifactsByUrl),
      };
    });

  const allInitiatorFrames = posts.flatMap((post) => post.initiatorFrames);
  const missingInitiatorSourceUrls = [
    ...new Set(
      allInitiatorFrames.filter((frame) => !frame.enclosingFunction).map((frame) => frame.url),
    ),
  ].sort();
  const missingResponseBodies = requests
    .filter((request) => typeof request.responseBody !== "string" && request.responseBodyError)
    .map((request) => ({
      url: sanitizeUrl(request.url),
      resourceType: request.resourceType ?? null,
      status: Number.isFinite(request.status) ? request.status : null,
      responseBodyErrorPresent: true,
    }));

  return {
    private: { scriptArtifacts },
    safe: {
      fileBasename: path.basename(filename),
      fileSha256: sha256(raw),
      turnstileRequestCount: requests.length,
      scriptArtifacts: scriptArtifacts.map((artifact) => artifact.safe),
      posts,
      sourceCoverage: {
        initiatorFrames: allInitiatorFrames.length,
        mappedInitiatorFrames: allInitiatorFrames.filter((frame) => frame.enclosingFunction).length,
        unmappedInitiatorFrames: allInitiatorFrames.filter((frame) => !frame.enclosingFunction)
          .length,
        missingInitiatorSourceUrls,
        missingResponseBodies,
      },
    },
  };
}

function compareArraysByIndex(left, right, comparator) {
  const count = Math.max(left.length, right.length);
  return Array.from({ length: count }, (_, index) =>
    comparator(left[index] ?? null, right[index] ?? null, index),
  );
}

function featureVector(features) {
  return Object.fromEntries(
    (features ?? []).map((feature) => [`${feature.category}:${feature.symbol}`, feature.count]),
  );
}

function compareReports(left, right) {
  const scripts = compareArraysByIndex(
    left.scriptArtifacts,
    right.scriptArtifacts,
    (a, b, index) => ({
      index,
      bothPresent: Boolean(a && b),
      sameRawSha256: Boolean(a && b && a.sha256 === b.sha256),
      sameAstShapeSha256: Boolean(a?.ast && b?.ast && a.ast.shapeSha256 === b.ast.shapeSha256),
      sameTokenShapeSha256: Boolean(
        a?.tokenShapeSha256 && b?.tokenShapeSha256 && a.tokenShapeSha256 === b.tokenShapeSha256,
      ),
      sameFeatureVector: Boolean(
        a &&
        b &&
        JSON.stringify(featureVector(a.features)) === JSON.stringify(featureVector(b.features)),
      ),
      byteLengthDelta: a && b ? b.byteLength - a.byteLength : null,
      astNodeDelta: a?.ast && b?.ast ? b.ast.nodes - a.ast.nodes : null,
    }),
  );
  const posts = compareArraysByIndex(left.posts, right.posts, (a, b, index) => ({
    index,
    bothPresent: Boolean(a && b),
    sameEndpointShape: Boolean(a && b && a.url === b.url && a.resourceType === b.resourceType),
    sameRawBodySha256: Boolean(a && b && a.body.sha256 === b.body.sha256),
    sameBodyShapeSha256: Boolean(a && b && a.body.shapeSha256 === b.body.shapeSha256),
    sameEncoding: Boolean(a && b && a.body.encoding === b.body.encoding),
    bodyByteLengthDelta: a && b ? b.body.byteLength - a.body.byteLength : null,
    entropyDelta:
      a && b ? Number((b.body.entropyBitsPerByte - a.body.entropyBitsPerByte).toFixed(4)) : null,
    sameRequestHeaderNames: Boolean(
      a && b && JSON.stringify(a.requestHeaderNames) === JSON.stringify(b.requestHeaderNames),
    ),
    sameInitiatorFrameLocations: Boolean(
      a &&
      b &&
      JSON.stringify(a.initiatorFrames.map((frame) => [frame.url, frame.line, frame.column])) ===
        JSON.stringify(b.initiatorFrames.map((frame) => [frame.url, frame.line, frame.column])),
    ),
    sameInitiatorStackShape: Boolean(
      a &&
      b &&
      JSON.stringify(a.initiatorFrames.map((frame) => [frame.url, frame.functionNameLength])) ===
        JSON.stringify(b.initiatorFrames.map((frame) => [frame.url, frame.functionNameLength])),
    ),
  }));
  return {
    sameCapturedScriptBuild:
      scripts.length > 0 &&
      scripts.every(
        (item) => item.bothPresent && item.sameAstShapeSha256 && item.sameTokenShapeSha256,
      ),
    challengeExecutionSourcesCaptured:
      left.sourceCoverage.unmappedInitiatorFrames === 0 &&
      right.sourceCoverage.unmappedInitiatorFrames === 0,
    scripts,
    posts,
  };
}

export async function compareProbeFiles(leftFilename, rightFilename) {
  const left = await analyzeProbe(leftFilename);
  const right = await analyzeProbe(rightFilename);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    safety: {
      rawBodiesIncluded: false,
      rawHeadersIncluded: false,
      rawInitiatorFunctionNamesIncluded: false,
      queryValuesRedacted: true,
      highEntropyPathSegmentsRedacted: true,
    },
    left: left.safe,
    right: right.safe,
    comparison: compareReports(left.safe, right.safe),
  };
}

function usage() {
  return "Usage: node scripts/compare-turnstile-probes.mjs <left-private-capture.json> <right-private-capture.json>";
}

async function main(argv) {
  if (argv.length !== 2 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) return;
    process.exitCode = 2;
    return;
  }
  const report = await compareProbeFiles(argv[0], argv[1]);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`Turnstile probe comparison failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
