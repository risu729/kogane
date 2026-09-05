#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = path.resolve(SCRIPT_DIRECTORY, "../../..");
const TURNSTILE_HOST = "challenges.cloudflare.com";
const SAFE_HOST_LABELS = new Set(["brunhild", "challenges"]);
const SAFE_PATH_SEGMENTS = new Set([
  "b",
  "cdn-cgi",
  "challenge-platform",
  "flow",
  "f",
  "g",
  "h",
  "if",
  "av0",
  "auto",
  "new",
  "normal",
  "ov1",
  "ov2",
  "pat",
  "rc",
  "turnstile",
  "v0",
  "api.js",
]);
const MAX_REPORTED_LOCATIONS = 40;

export function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isTurnstileHost(hostname) {
  const lower = hostname.toLowerCase();
  return lower === TURNSTILE_HOST || lower.endsWith(`.${TURNSTILE_HOST}`);
}

function sanitizeHost(hostname) {
  const lower = hostname.toLowerCase();
  if (!isTurnstileHost(lower)) return "<redacted-host>";
  if (lower === TURNSTILE_HOST) return lower;

  const suffix = `.${TURNSTILE_HOST}`;
  const prefix = lower.slice(0, -suffix.length);
  const sanitizedPrefix = prefix
    .split(".")
    .map((label) => (SAFE_HOST_LABELS.has(label) ? label : "<redacted>"))
    .join(".");
  return `${sanitizedPrefix}${suffix}`;
}

function isHighEntropySegment(segment) {
  const decoded = decodeURIComponentSafe(segment);
  if (decoded.length >= 20) return true;
  if (/^[0-9a-f]{12,}$/i.test(decoded)) return true;
  if (/^[A-Za-z0-9_-]{16,}$/.test(decoded)) return true;
  if (/^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(decoded)) return true;
  return false;
}

function decodeURIComponentSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function sanitizeUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const hostname = sanitizeHost(parsed.hostname);
    let inDynamicZone = false;
    const segments = parsed.pathname.split("/").map((segment) => {
      if (!segment) return segment;
      const decoded = decodeURIComponentSafe(segment);
      const lower = decoded.toLowerCase();
      if (lower === "rch" || lower === "fo") {
        inDynamicZone = true;
        return segment;
      }
      if (SAFE_PATH_SEGMENTS.has(lower)) return segment;
      if (inDynamicZone) return "<redacted>";
      if (isHighEntropySegment(segment)) return "<redacted>";
      return segment.replace(/[0-9a-f]{12,}/gi, "<redacted>");
    });
    const queryNames = [...new Set([...parsed.searchParams.keys()])].sort();
    const query = queryNames.length
      ? `?${queryNames.map((name) => `${encodeURIComponent(name)}=<redacted>`).join("&")}`
      : "";
    return `${parsed.protocol}//${hostname}${segments.join("/")}${query}`;
  } catch {
    return "<invalid-url>";
  }
}

function isJavaScriptResponse(record) {
  const mimeType = String(record.mimeType ?? "").toLowerCase();
  const bodyFile = String(record.bodyFile ?? "").toLowerCase();
  let pathname = "";
  try {
    pathname = new URL(record.url).pathname.toLowerCase();
  } catch {
    // Invalid URLs are filtered before this function is called.
  }
  return (
    mimeType.includes("javascript") ||
    mimeType.includes("ecmascript") ||
    bodyFile.endsWith(".js") ||
    pathname.endsWith(".js")
  );
}

function safeBodyPath(captureDirectory, bodyFile) {
  const resolvedCapture = path.resolve(captureDirectory);
  const normalizedBodyFile = String(bodyFile).replace(/[\\/]+/gu, path.sep);
  if (path.isAbsolute(normalizedBodyFile) || /^[A-Za-z]:/u.test(normalizedBodyFile)) {
    throw new Error("bodyFile must be relative to the capture directory");
  }
  const resolvedBody = path.resolve(resolvedCapture, normalizedBodyFile);
  if (!isWithin(resolvedCapture, resolvedBody)) {
    throw new Error("bodyFile escaped the capture directory");
  }
  return resolvedBody;
}

function propertyName(expression) {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    return expression.argumentExpression.text;
  }
  return null;
}

function rootIdentifier(expression) {
  let current = expression;
  while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
    current = current.expression;
  }
  return ts.isIdentifier(current) ? current.text : null;
}

function expressionPath(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) {
    const left = expressionPath(expression.expression);
    return left ? `${left}.${expression.name.text}` : expression.name.text;
  }
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    ts.isStringLiteralLike(expression.argumentExpression)
  ) {
    const left = expressionPath(expression.expression);
    return left
      ? `${left}.${expression.argumentExpression.text}`
      : expression.argumentExpression.text;
  }
  return null;
}

function collectXhrVariables(sourceFile) {
  const names = new Set();
  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isNewExpression(node.initializer) &&
      expressionPath(node.initializer.expression) === "XMLHttpRequest"
    ) {
      names.add(node.name.text);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      ts.isNewExpression(node.right) &&
      expressionPath(node.right.expression) === "XMLHttpRequest"
    ) {
      names.add(node.left.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

function createHitCollector(sourceFile) {
  const buckets = new Map();

  function add(category, symbol, node) {
    const key = `${category}\u0000${symbol}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { category, symbol, count: 0, locations: [], truncatedLocations: 0 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.locations.length < MAX_REPORTED_LOCATIONS) {
      const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile, false));
      bucket.locations.push({ line: position.line + 1, column: position.character + 1 });
    } else {
      bucket.truncatedLocations += 1;
    }
  }

  return {
    add,
    finish() {
      return [...buckets.values()].sort(
        (a, b) => a.category.localeCompare(b.category) || a.symbol.localeCompare(b.symbol),
      );
    },
  };
}

function parseDiagnostics(sourceFile) {
  return sourceFile.parseDiagnostics.map((diagnostic) => {
    const start = diagnostic.start ?? 0;
    const position = sourceFile.getLineAndCharacterOfPosition(start);
    return {
      code: diagnostic.code,
      line: position.line + 1,
      column: position.character + 1,
    };
  });
}

export function analyzeSource(source, virtualFilename) {
  const sourceFile = ts.createSourceFile(
    virtualFilename,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
  const xhrVariables = collectXhrVariables(sourceFile);
  const hits = createHitCollector(sourceFile);
  const stats = {
    nodes: 0,
    maxDepth: 0,
    calls: 0,
    newExpressions: 0,
    functions: 0,
    objectLiterals: 0,
    arrayLiterals: 0,
    stringLiterals: 0,
    identifiers: 0,
    elementAccesses: 0,
    sequenceExpressions: 0,
    conditionalExpressions: 0,
    bitwiseOperators: 0,
  };
  const astShapeHash = createHash("sha256");

  const cryptoMethods = new Set([
    "decrypt",
    "deriveBits",
    "deriveKey",
    "digest",
    "encrypt",
    "exportKey",
    "generateKey",
    "importKey",
    "sign",
    "unwrapKey",
    "verify",
    "wrapKey",
  ]);
  const xhrMethods = new Set(["abort", "open", "send", "setRequestHeader"]);
  const serializationIdentifiers = new Set([
    "ArrayBuffer",
    "Blob",
    "DataView",
    "FormData",
    "TextDecoder",
    "Uint8Array",
    "URLSearchParams",
  ]);
  const serializationCalls = new Set([
    "decodeURIComponent",
    "encodeURIComponent",
    "JSON.parse",
    "JSON.stringify",
  ]);
  const devicePaths = new Map([
    ["navigator.userAgent", "navigator.userAgent"],
    ["navigator.platform", "navigator.platform"],
    ["navigator.language", "navigator.language"],
    ["navigator.languages", "navigator.languages"],
    ["navigator.webdriver", "navigator.webdriver"],
    ["navigator.hardwareConcurrency", "navigator.hardwareConcurrency"],
    ["navigator.deviceMemory", "navigator.deviceMemory"],
    ["navigator.maxTouchPoints", "navigator.maxTouchPoints"],
    ["navigator.plugins", "navigator.plugins"],
    ["navigator.mimeTypes", "navigator.mimeTypes"],
    ["navigator.cookieEnabled", "navigator.cookieEnabled"],
    ["navigator.doNotTrack", "navigator.doNotTrack"],
    ["navigator.pdfViewerEnabled", "navigator.pdfViewerEnabled"],
    ["navigator.vendor", "navigator.vendor"],
    ["navigator.productSub", "navigator.productSub"],
    ["screen.width", "screen.width"],
    ["screen.height", "screen.height"],
    ["screen.availWidth", "screen.availWidth"],
    ["screen.availHeight", "screen.availHeight"],
    ["screen.colorDepth", "screen.colorDepth"],
    ["screen.pixelDepth", "screen.pixelDepth"],
    ["devicePixelRatio", "devicePixelRatio"],
    ["innerWidth", "innerWidth"],
    ["innerHeight", "innerHeight"],
    ["outerWidth", "outerWidth"],
    ["outerHeight", "outerHeight"],
    ["document.visibilityState", "document.visibilityState"],
    ["document.hidden", "document.hidden"],
    ["document.fonts", "document.fonts"],
    ["performance.timeOrigin", "performance.timeOrigin"],
    ["navigator.mediaDevices", "navigator.mediaDevices"],
    ["navigator.permissions", "navigator.permissions"],
  ]);
  const deviceGlobals = new Set([
    "AudioContext",
    "OfflineAudioContext",
    "RTCPeerConnection",
    "devicePixelRatio",
    "innerHeight",
    "innerWidth",
    "outerHeight",
    "outerWidth",
  ]);
  const deviceMethods = new Set([
    "convertToBlob",
    "enumerateDevices",
    "getContext",
    "getExtension",
    "getImageData",
    "getParameter",
    "getSupportedExtensions",
    "measureText",
    "query",
    "readPixels",
    "resolvedOptions",
    "toBlob",
    "toDataURL",
  ]);
  const deviceObjects = new Set([
    "AudioContext",
    "CanvasRenderingContext2D",
    "Intl.DateTimeFormat",
    "OfflineAudioContext",
    "RTCPeerConnection",
    "WebGL2RenderingContext",
    "WebGLRenderingContext",
  ]);
  const storagePaths = new Set([
    "indexedDB",
    "localStorage",
    "sessionStorage",
    "window.indexedDB",
    "window.localStorage",
    "window.sessionStorage",
  ]);
  const encodingConstructors = new Set([
    "CompressionStream",
    "TextDecoder",
    "TextEncoder",
    "Uint8Array",
  ]);
  const safeApiStringLiterals = new Set([
    "AudioContext",
    "OfflineAudioContext",
    "RTCPeerConnection",
    "WebGL2RenderingContext",
    "WebGLRenderingContext",
    "availHeight",
    "availWidth",
    "canvas",
    "colorDepth",
    "cookieEnabled",
    "deviceMemory",
    "devicePixelRatio",
    "doNotTrack",
    "enumerateDevices",
    "fonts",
    "getContext",
    "getImageData",
    "getParameter",
    "getSupportedExtensions",
    "hardwareConcurrency",
    "indexedDB",
    "innerHeight",
    "innerWidth",
    "language",
    "languages",
    "localStorage",
    "maxTouchPoints",
    "measureText",
    "mediaDevices",
    "mimeTypes",
    "outerHeight",
    "outerWidth",
    "pdfViewerEnabled",
    "permissions",
    "pixelDepth",
    "platform",
    "plugins",
    "productSub",
    "readPixels",
    "resolvedOptions",
    "screen",
    "sessionStorage",
    "timeOrigin",
    "timeZone",
    "toDataURL",
    "userAgent",
    "vendor",
    "webdriver",
  ]);
  const obfuscationCalls = new Set([
    "eval",
    "Object.defineProperty",
    "Object.getOwnPropertyDescriptor",
    "String.fromCharCode",
    "String.fromCodePoint",
    "decodeURIComponent",
    "escape",
    "setInterval",
    "setTimeout",
    "unescape",
  ]);
  const bitwiseOperators = new Set([
    ts.SyntaxKind.AmpersandToken,
    ts.SyntaxKind.BarToken,
    ts.SyntaxKind.CaretToken,
    ts.SyntaxKind.LessThanLessThanToken,
    ts.SyntaxKind.GreaterThanGreaterThanToken,
    ts.SyntaxKind.GreaterThanGreaterThanGreaterThanToken,
    ts.SyntaxKind.TildeToken,
  ]);

  const visit = (node, depth = 0) => {
    astShapeHash.update(`${node.kind},`);
    stats.nodes += 1;
    stats.maxDepth = Math.max(stats.maxDepth, depth);
    if (ts.isCallExpression(node)) stats.calls += 1;
    if (ts.isNewExpression(node)) stats.newExpressions += 1;
    if (ts.isFunctionLike(node)) stats.functions += 1;
    if (ts.isObjectLiteralExpression(node)) stats.objectLiterals += 1;
    if (ts.isArrayLiteralExpression(node)) stats.arrayLiterals += 1;
    if (ts.isStringLiteralLike(node)) stats.stringLiterals += 1;
    if (ts.isIdentifier(node)) stats.identifiers += 1;
    if (ts.isElementAccessExpression(node)) stats.elementAccesses += 1;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      stats.sequenceExpressions += 1;
    }
    if (ts.isConditionalExpression(node)) stats.conditionalExpressions += 1;
    if (
      (ts.isBinaryExpression(node) && bitwiseOperators.has(node.operatorToken.kind)) ||
      (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.TildeToken)
    ) {
      stats.bitwiseOperators += 1;
    }

    if (ts.isCallExpression(node)) {
      const callPath = expressionPath(node.expression);
      const method = propertyName(node.expression);
      const root = rootIdentifier(node.expression);

      if (
        callPath === "fetch" ||
        callPath === "window.fetch" ||
        callPath === "self.fetch" ||
        callPath === "globalThis.fetch"
      ) {
        hits.add("network", "fetch", node);
      }
      if (callPath === "atob" || callPath === "window.atob" || callPath === "globalThis.atob") {
        hits.add("base64", "atob", node);
      }
      if (callPath === "btoa" || callPath === "window.btoa" || callPath === "globalThis.btoa") {
        hits.add("base64", "btoa", node);
      }
      if (serializationCalls.has(callPath)) {
        hits.add("serialization", callPath, node);
      }
      if (callPath && obfuscationCalls.has(callPath)) {
        hits.add("dynamic-code", callPath, node);
      }
      if (method === "charCodeAt" || method === "codePointAt") {
        hits.add("dynamic-code", method, node);
      }
      if (method && deviceMethods.has(method)) {
        hits.add("device-api-method", method, node);
      }
      if (callPath === "performance.now" || callPath === "window.performance.now") {
        hits.add("timing", "performance.now", node);
      }
      if (callPath === "crypto.getRandomValues" || callPath?.endsWith(".crypto.getRandomValues")) {
        hits.add("crypto", "crypto.getRandomValues", node);
      }
      if (callPath?.startsWith("Reflect.")) {
        hits.add("reflection", callPath, node);
      }
      if (callPath?.startsWith("WebAssembly.")) {
        hits.add("wasm", callPath, node);
      }
      if (callPath === "Buffer.from") {
        hits.add("base64", "Buffer.from", node);
      }
      if (
        method === "toString" &&
        node.arguments.some(
          (argument) => ts.isStringLiteralLike(argument) && /base64/i.test(argument.text),
        )
      ) {
        hits.add("base64", "toString(base64)", node);
      }
      if (
        method &&
        cryptoMethods.has(method) &&
        expressionPath(node.expression.expression)?.includes("subtle")
      ) {
        hits.add("crypto", `subtle.${method}`, node);
      }
      if (method && xhrMethods.has(method) && root && xhrVariables.has(root)) {
        hits.add("network", `XMLHttpRequest.${method}`, node);
      }
    }

    if (ts.isNewExpression(node)) {
      const constructor = expressionPath(node.expression);
      if (constructor === "XMLHttpRequest") hits.add("network", "XMLHttpRequest", node);
      if (constructor === "TextEncoder") hits.add("encoding", "TextEncoder", node);
      if (constructor && encodingConstructors.has(constructor)) {
        hits.add("encoding", constructor, node);
      }
      if (constructor && deviceObjects.has(constructor)) {
        hits.add("device-api-constructor", constructor, node);
      }
      if (constructor === "Function") hits.add("dynamic-code", "Function.constructor", node);
      if (constructor === "Proxy") hits.add("reflection", "Proxy", node);
      if (constructor?.startsWith("WebAssembly.")) hits.add("wasm", constructor, node);
      if (constructor && serializationIdentifiers.has(constructor)) {
        hits.add("serialization", constructor, node);
      }
    }

    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const accessPath = expressionPath(node);
      const normalizedPath = accessPath?.replace(/^(?:globalThis|self|window)\./u, "");
      const devicePath = normalizedPath ? devicePaths.get(normalizedPath) : null;
      if (devicePath) hits.add("device-signal", devicePath, node);
      if (accessPath && storagePaths.has(accessPath))
        hits.add("storage", accessPath.replace(/^window\./u, ""), node);
      if (
        accessPath === "crypto" ||
        accessPath === "window.crypto" ||
        accessPath === "self.crypto" ||
        accessPath === "globalThis.crypto"
      ) {
        hits.add("crypto", "crypto", node);
      }
      if (accessPath?.endsWith(".subtle")) hits.add("crypto", "crypto.subtle", node);
    }

    if (ts.isIdentifier(node) && node.text === "TextEncoder") {
      hits.add("encoding", "TextEncoder.reference", node);
    }
    if (ts.isIdentifier(node) && deviceGlobals.has(node.text)) {
      hits.add("device-global", node.text, node);
    }
    if (ts.isStringLiteralLike(node) && safeApiStringLiterals.has(node.text)) {
      hits.add("device-api-string", node.text, node);
    }

    ts.forEachChild(node, (child) => visit(child, depth + 1));
  };
  visit(sourceFile);

  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed });
  const pretty = printer.printFile(sourceFile);

  return {
    parser: `typescript-${ts.version}`,
    parseDiagnostics: parseDiagnostics(sourceFile),
    ast: { ...stats, shapeSha256: astShapeHash.digest("hex") },
    features: hits.finish(),
    pretty: {
      byteLength: Buffer.byteLength(pretty),
      sha256: sha256(pretty),
    },
    prettySource: pretty,
  };
}

function parseMetadata(metadataText) {
  const records = [];
  for (const [index, line] of metadataText.split(/\r?\n/u).entries()) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      throw new Error(`metadata.ndjson line ${index + 1} is not valid JSON`);
    }
  }
  return records;
}

export async function analyzeCapture(captureDirectory, options = {}) {
  const captureRoot = path.resolve(captureDirectory);
  const metadataPath = path.join(captureRoot, "metadata.ndjson");
  const metadata = parseMetadata(await readFile(metadataPath, "utf8"));
  const turnstileResponses = metadata.filter((record) => {
    if (!record.url) return false;
    try {
      return isTurnstileHost(new URL(record.url).hostname);
    } catch {
      return false;
    }
  });
  const candidates = turnstileResponses.filter(
    (record) => record.bodySaved && record.bodyFile && isJavaScriptResponse(record),
  );
  const excludedResponses = turnstileResponses
    .filter((record) => !candidates.includes(record))
    .map((record) => ({
      url: sanitizeUrl(record.url),
      mimeType: record.mimeType ? String(record.mimeType) : null,
      status: Number.isFinite(record.status) ? record.status : null,
      resourceType: record.type ? String(record.type) : null,
      bodySaved: Boolean(record.bodySaved),
      bodyLength: Number.isFinite(record.bodyLength) ? record.bodyLength : null,
    }));

  const artifacts = new Map();
  for (const record of candidates) {
    const bodyPath = safeBodyPath(captureRoot, record.bodyFile);
    const body = await readFile(bodyPath);
    const digest = sha256(body);
    let artifact = artifacts.get(digest);
    if (!artifact) {
      const source = body.toString("utf8");
      const analysis = analyzeSource(source, `turnstile-${digest.slice(0, 12)}.js`);
      artifact = {
        sha256: digest,
        byteLength: body.byteLength,
        urls: [],
        mimeTypes: [],
        occurrences: 0,
        parser: analysis.parser,
        parseDiagnostics: analysis.parseDiagnostics,
        ast: analysis.ast,
        features: analysis.features,
        pretty: analysis.pretty,
        prettySource: analysis.prettySource,
      };
      artifacts.set(digest, artifact);
    }
    artifact.occurrences += 1;
    artifact.urls.push(sanitizeUrl(record.url));
    if (record.mimeType) artifact.mimeTypes.push(String(record.mimeType));
  }

  const prettyDirectory = options.prettyDirectory ? path.resolve(options.prettyDirectory) : null;
  if (prettyDirectory) {
    if (isWithin(REPOSITORY_ROOT, prettyDirectory)) {
      throw new Error(
        "--pretty-dir must be outside the Git worktree because it contains raw response text",
      );
    }
    await mkdir(prettyDirectory, { recursive: true });
  }

  const serializedArtifacts = [];
  for (const artifact of artifacts.values()) {
    if (prettyDirectory) {
      await writeFile(
        path.join(prettyDirectory, `${artifact.sha256}.pretty.js`),
        artifact.prettySource,
        {
          mode: 0o600,
        },
      );
    }
    const { prettySource: _prettySource, ...safeArtifact } = artifact;
    safeArtifact.urls = [...new Set(safeArtifact.urls)].sort();
    safeArtifact.mimeTypes = [...new Set(safeArtifact.mimeTypes)].sort();
    serializedArtifacts.push(safeArtifact);
  }
  serializedArtifacts.sort((a, b) => a.sha256.localeCompare(b.sha256));

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    source: {
      captureDirectoryBasename: path.basename(captureRoot),
      metadataRecords: metadata.length,
      turnstileResponses: turnstileResponses.length,
      candidateResponses: candidates.length,
      uniqueBodies: serializedArtifacts.length,
      excludedResponses,
    },
    safety: {
      rawResponseIncluded: false,
      queryValuesRedacted: true,
      highEntropyPathSegmentsRedacted: true,
      unknownTurnstileSubdomainsRedacted: true,
      prettyFilesWritten: Boolean(prettyDirectory),
      prettyFilesContainRawResponse: Boolean(prettyDirectory),
    },
    runtime: {
      node: process.version,
      typescript: ts.version,
    },
    artifacts: serializedArtifacts,
  };
}

function usage() {
  return [
    "Usage:",
    "  node scripts/analyze-turnstile-capture.mjs <capture-run-directory>",
    "  node scripts/analyze-turnstile-capture.mjs <capture-run-directory> --pretty-dir <outside-git-directory>",
    "",
    "The JSON report never contains raw response text or URL query values.",
    "--pretty-dir is optional and writes sensitive formatted JavaScript outside the Git worktree.",
  ].join("\n");
}

async function main(argv) {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const captureDirectory = argv[0];
  let prettyDirectory;
  const prettyIndex = argv.indexOf("--pretty-dir");
  if (prettyIndex !== -1) {
    prettyDirectory = argv[prettyIndex + 1];
    if (!prettyDirectory) throw new Error("--pretty-dir requires a directory");
  }
  const report = await analyzeCapture(captureDirectory, { prettyDirectory });
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`Turnstile capture analysis failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
