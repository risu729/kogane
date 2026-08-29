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
  "addEventListener",
  "atob",
  "btoa",
  "decodeURIComponent",
  "decrypt",
  "digest",
  "encodeURIComponent",
  "encrypt",
  "eval",
  "fetch",
  "fromCharCode",
  "getRandomValues",
  "importKey",
  "open",
  "parse",
  "send",
  "setRequestHeader",
  "stringify",
]);
const SAFE_TOKENS = [
  "ArrayBuffer",
  "AudioContext",
  "CanvasRenderingContext2D",
  "DataView",
  "DateTimeFormat",
  "Function",
  "Intl",
  "JSON",
  "OfflineAudioContext",
  "RTCPeerConnection",
  "TextDecoder",
  "TextEncoder",
  "Uint8Array",
  "URLSearchParams",
  "WebAssembly",
  "WebGL2RenderingContext",
  "WebGLRenderingContext",
  "XMLHttpRequest",
  "addEventListener",
  "atob",
  "availHeight",
  "availWidth",
  "btoa",
  "canvas",
  "colorDepth",
  "cookieEnabled",
  "crypto",
  "decodeURIComponent",
  "decrypt",
  "deviceMemory",
  "devicePixelRatio",
  "digest",
  "doNotTrack",
  "encodeURIComponent",
  "encrypt",
  "enumerateDevices",
  "eval",
  "fetch",
  "fonts",
  "fromCharCode",
  "getContext",
  "getImageData",
  "getParameter",
  "getRandomValues",
  "getSupportedExtensions",
  "hardwareConcurrency",
  "height",
  "importKey",
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
  "navigator",
  "open",
  "outerHeight",
  "outerWidth",
  "pdfViewerEnabled",
  "performance",
  "permissions",
  "pixelDepth",
  "platform",
  "plugins",
  "productSub",
  "query",
  "readPixels",
  "readyState",
  "resolvedOptions",
  "response",
  "responseText",
  "screen",
  "send",
  "sessionStorage",
  "setRequestHeader",
  "speechSynthesis",
  "status",
  "stringify",
  "subtle",
  "timeOrigin",
  "timeZone",
  "toDataURL",
  "userAgent",
  "vendor",
  "webdriver",
  "width",
];

function isTurnstileUrl(rawUrl) {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    return host === TURNSTILE_HOST || host.endsWith(`.${TURNSTILE_HOST}`);
  } catch {
    return false;
  }
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

function propertyName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (
    ts.isElementAccessExpression(expression) &&
    expression.argumentExpression &&
    ts.isStringLiteralLike(expression.argumentExpression)
  ) return expression.argumentExpression.text;
  return null;
}

function safeName(name) {
  if (!name) return null;
  return SAFE_CALLEES.has(name)
    ? { known: name }
    : { nameSha256: sha256(name), nameLength: name.length };
}

function unwrapParentheses(node) {
  let current = node;
  while (ts.isParenthesizedExpression(current)) current = current.expression;
  return current;
}

function identifierName(node) {
  const current = unwrapParentheses(node);
  return ts.isIdentifier(current) ? current.text : null;
}

function isVoidLike(node) {
  const current = unwrapParentheses(node);
  return ts.isVoidExpression(current) ||
    (ts.isIdentifier(current) && current.text === "undefined");
}

function enclosingFunctionOf(node) {
  let current = node.parent;
  while (current && !ts.isFunctionLike(current)) current = current.parent;
  return current ?? null;
}

export function detectVmPropertyResolvers(source) {
  const sourceFile = ts.createSourceFile("rch-vm.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const sites = [];
  const visit = (node) => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const targetName = identifierName(node.left);
      const conditional = unwrapParentheses(node.right);
      if (targetName && ts.isConditionalExpression(conditional)) {
        const condition = unwrapParentheses(conditional.condition);
        const whenTrue = identifierName(conditional.whenTrue);
        const whenFalse = unwrapParentheses(conditional.whenFalse);
        if (
          ts.isBinaryExpression(condition) &&
          [ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.EqualsEqualsEqualsToken].includes(condition.operatorToken.kind) &&
          whenTrue &&
          ts.isElementAccessExpression(whenFalse)
        ) {
          const hostName = isVoidLike(condition.right)
            ? identifierName(condition.left)
            : isVoidLike(condition.left)
              ? identifierName(condition.right)
              : null;
          const elementHostName = identifierName(whenFalse.expression);
          const propertyNameIdentifier = whenFalse.argumentExpression
            ? identifierName(whenFalse.argumentExpression)
            : null;
          if (hostName && hostName === elementHostName && whenTrue === propertyNameIdentifier) {
            const enclosingFunction = enclosingFunctionOf(node);
            let directCalls = 0;
            let callApplyCalls = 0;
            if (enclosingFunction) {
              const inspectUse = (candidate) => {
                if (ts.isCallExpression(candidate)) {
                  if (identifierName(candidate.expression) === targetName) directCalls += 1;
                  if (
                    (ts.isPropertyAccessExpression(candidate.expression) || ts.isElementAccessExpression(candidate.expression)) &&
                    ["call", "apply"].includes(propertyName(candidate.expression)) &&
                    identifierName(candidate.expression.expression) === targetName
                  ) callApplyCalls += 1;
                }
                ts.forEachChild(candidate, inspectUse);
              };
              inspectUse(enclosingFunction);
            }
            const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile, false));
            sites.push({
              position: { line: position.line + 1, column: position.character + 1 },
              hostVoidFallback: true,
              propertyNameFlowsToElementAccess: true,
              resolvedTarget: safeName(targetName),
              enclosingFunction: enclosingFunction ? subtreeShape(enclosingFunction) : null,
              directResolvedTargetCalls: directCalls,
              callApplyResolvedTargetCalls: callApplyCalls,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

function countToken(source, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const pattern = new RegExp(`(^|[^A-Za-z0-9_$])${escaped}(?=$|[^A-Za-z0-9_$])`, "gu");
  let count = 0;
  for (const _match of source.matchAll(pattern)) count += 1;
  return count;
}

export function knownTokenCounts(source) {
  return Object.fromEntries(
    SAFE_TOKENS.map((token) => [token, countToken(source, token)]).filter(([, count]) => count > 0),
  );
}

export function positionAnalysis(source, frame) {
  const sourceFile = ts.createSourceFile("rch-source.js", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (!Number.isInteger(frame.lineNumber) || !Number.isInteger(frame.columnNumber)) return null;
  if (frame.lineNumber >= sourceFile.getLineStarts().length) return null;
  const position = sourceFile.getPositionOfLineAndCharacter(frame.lineNumber, frame.columnNumber);
  const chain = [];
  let deepestCall = null;
  let deepestFunction = null;
  const functionAncestors = [];
  const visit = (node) => {
    if (position < node.getFullStart() || position > node.end) return;
    chain.push(ts.SyntaxKind[node.kind]);
    if (ts.isCallExpression(node)) deepestCall = node;
    if (ts.isFunctionLike(node)) {
      deepestFunction = node;
      functionAncestors.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  const call = deepestCall
    ? {
        callee: safeName(propertyName(deepestCall.expression)),
        argumentCount: deepestCall.arguments.length,
        argumentKinds: deepestCall.arguments.map((argument) => ts.SyntaxKind[argument.kind]),
        argumentShapes: deepestCall.arguments.map(subtreeShape),
        subtree: subtreeShape(deepestCall),
      }
    : null;
  const enclosingFunction = deepestFunction
    ? {
        kind: ts.SyntaxKind[deepestFunction.kind],
        parameterCount: deepestFunction.parameters?.length ?? 0,
        subtree: subtreeShape(deepestFunction),
        lexicalKnownTokens: knownTokenCounts(deepestFunction.getText(sourceFile)),
        features: analyzeSource(deepestFunction.getText(sourceFile), "rch-frame-function.js").features,
      }
    : null;
  return {
    position: { line: frame.lineNumber + 1, column: frame.columnNumber + 1 },
    nodePath: chain.slice(-16),
    call,
    enclosingFunction,
    functionAncestorShapes: functionAncestors.map(subtreeShape),
  };
}

function entropy(text) {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length === 0) return 0;
  const counts = new Uint32Array(256);
  for (const byte of bytes) counts[byte] += 1;
  let value = 0;
  for (const count of counts) {
    if (!count) continue;
    const probability = count / bytes.length;
    value -= probability * Math.log2(probability);
  }
  return Number(value.toFixed(4));
}

function bodySummary(text) {
  const compact = text.replace(/\s/gu, "");
  return {
    sha256: sha256(text),
    byteLength: Buffer.byteLength(text),
    entropyBitsPerByte: entropy(text),
    base64Like: compact.length > 0 && compact.length % 4 === 0 && /^[A-Za-z0-9+/_=-]+$/u.test(compact),
  };
}

async function loadWebcrack() {
  const modulePath = process.env.WEBCRACK_MODULE;
  if (!modulePath) return null;
  const module = await import(pathToFileURL(path.resolve(modulePath)).href);
  if (typeof module.webcrack !== "function") throw new Error("WEBCRACK_MODULE does not export webcrack()");
  return module.webcrack;
}

async function inspectCapture(filename, webcrack) {
  const raw = await readFile(filename);
  const capture = JSON.parse(raw.toString("utf8"));
  const scripts = Array.isArray(capture.scripts) ? capture.scripts : [];
  const posts = Array.isArray(capture.requests)
    ? capture.requests.filter((request) => request.method === "POST" && isTurnstileUrl(request.url))
    : [];
  const deobfuscatedBySha256 = new Map();

  async function inspectScript(script) {
    const source = script.scriptSource;
    const digest = sha256(source);
    let deobfuscated = null;
    if (webcrack && !deobfuscatedBySha256.has(digest)) {
      const result = await webcrack(source, { deobfuscate: true, unpack: false, jsx: false });
      deobfuscatedBySha256.set(digest, result.code);
    }
    if (webcrack) deobfuscated = deobfuscatedBySha256.get(digest);
    const rawAnalysis = analyzeSource(source, `rch-${digest.slice(0, 12)}.js`);
    const deobfuscatedAnalysis = deobfuscated
      ? analyzeSource(deobfuscated, `rch-${digest.slice(0, 12)}.webcrack.js`)
      : null;
    return {
      sha256: digest,
      byteLength: Buffer.byteLength(source),
      nonWhitespaceCharacters: source.replace(/\s/gu, "").length,
      astShapeSha256: rawAnalysis.ast.shapeSha256,
      ast: rawAnalysis.ast,
      lexicalKnownTokens: knownTokenCounts(source),
      features: rawAnalysis.features,
      vmPropertyResolvers: detectVmPropertyResolvers(source),
      deobfuscated: deobfuscated
        ? {
            byteLength: Buffer.byteLength(deobfuscated),
            sha256: sha256(deobfuscated),
            astShapeSha256: deobfuscatedAnalysis.ast.shapeSha256,
            lexicalKnownTokens: knownTokenCounts(deobfuscated),
            features: deobfuscatedAnalysis.features,
          }
        : null,
    };
  }

  const stages = [];
  for (const [index, request] of posts.entries()) {
    const topFrame = request.initiator?.stack?.callFrames?.[0] ?? null;
    const script = topFrame
      ? scripts.find((candidate) => candidate.sessionId === request.sessionId && candidate.url === topFrame.url)
      : null;
    const inspectedScript = script ? await inspectScript(script) : null;
    const responseText = typeof request.responseBody === "string" ? request.responseBody : "";
    const postText = typeof request.requestPostData === "string" ? request.requestPostData : "";
    const responseDigest = sha256(responseText);
    const exactResponseScriptMatches = scripts.filter(
      (candidate) => typeof candidate.scriptSource === "string" && sha256(candidate.scriptSource) === responseDigest,
    ).length;
    const frameAnalyses = (request.initiator?.stack?.callFrames ?? []).map((frame) => {
      const frameScript = scripts.find(
        (candidate) => candidate.sessionId === request.sessionId && candidate.url === frame.url,
      );
      return frameScript ? positionAnalysis(frameScript.scriptSource, frame) : null;
    });
    const vmFunctionShapes = new Set(
      inspectedScript?.vmPropertyResolvers
        .map((site) => site.enclosingFunction?.shapeSha256)
        .filter(Boolean) ?? [],
    );
    stages.push({
      stage: index + 1,
      endpoint: sanitizeUrl(request.url),
      status: Number.isFinite(request.status) ? request.status : null,
      requestBody: bodySummary(postText),
      responseBody: bodySummary(responseText),
      initiatorFrameCount: request.initiator?.stack?.callFrames?.length ?? 0,
      topFrameMapped: Boolean(script),
      topFrame: topFrame && script ? positionAnalysis(script.scriptSource, topFrame) : null,
      frames: frameAnalyses.map((frame) => frame && ({
        ...frame,
        inVmPropertyResolverFunction: Boolean(
          frame.functionAncestorShapes.some((shape) => vmFunctionShapes.has(shape.shapeSha256)),
        ),
      })),
      senderScript: inspectedScript,
      exactResponseScriptMatches,
    });
  }

  const uniqueSubstantiveScripts = new Map();
  for (const script of scripts) {
    if (
      typeof script.scriptSource !== "string" ||
      (!isTurnstileUrl(script.url) && !isTurnstileUrl(script.targetUrl))
    ) continue;
    const nonWhitespaceCharacters = script.scriptSource.replace(/\s/gu, "").length;
    if (nonWhitespaceCharacters <= 100) continue;
    const digest = sha256(script.scriptSource);
    const summary = uniqueSubstantiveScripts.get(digest) ?? {
      sha256: digest,
      byteLength: Buffer.byteLength(script.scriptSource),
      nonWhitespaceCharacters,
      occurrences: 0,
      urlPresent: false,
    };
    summary.occurrences += 1;
    summary.urlPresent ||= Boolean(script.url);
    uniqueSubstantiveScripts.set(digest, summary);
  }

  return {
    fileBasename: path.basename(filename),
    fileSha256: sha256(raw),
    debuggerScriptCount: scripts.length,
    uniqueSubstantiveScripts: [...uniqueSubstantiveScripts.values()].sort(
      (left, right) => right.byteLength - left.byteLength,
    ),
    stages,
  };
}

function compare(left, right) {
  const leftSources = new Set(left.uniqueSubstantiveScripts.map((script) => script.sha256));
  const rightSources = new Set(right.uniqueSubstantiveScripts.map((script) => script.sha256));
  const sharedSources = [...leftSources].filter((digest) => rightSources.has(digest));
  const stageCount = Math.max(left.stages.length, right.stages.length);
  return {
    sharedSubstantiveSourceCount: sharedSources.length,
    onlyLeftSubstantiveSourceCount: leftSources.size - sharedSources.length,
    onlyRightSubstantiveSourceCount: rightSources.size - sharedSources.length,
    stages: Array.from({ length: stageCount }, (_, index) => {
      const leftStage = left.stages[index];
      const rightStage = right.stages[index];
      return {
        stage: index + 1,
        bothPresent: Boolean(leftStage && rightStage),
        sameSenderSource: Boolean(
          leftStage?.senderScript?.sha256 && leftStage.senderScript.sha256 === rightStage?.senderScript?.sha256,
        ),
        sameSenderAstShape: Boolean(
          leftStage?.senderScript?.astShapeSha256 &&
          leftStage.senderScript.astShapeSha256 === rightStage?.senderScript?.astShapeSha256,
        ),
        sameTopFrameLocation: Boolean(
          leftStage?.topFrame &&
          rightStage?.topFrame &&
          JSON.stringify(leftStage.topFrame.position) === JSON.stringify(rightStage.topFrame.position),
        ),
        sameTopCallShape: Boolean(
          leftStage?.topFrame?.call?.subtree?.shapeSha256 &&
          leftStage.topFrame.call.subtree.shapeSha256 === rightStage?.topFrame?.call?.subtree?.shapeSha256,
        ),
        requestBodyByteLengthDelta:
          leftStage && rightStage ? rightStage.requestBody.byteLength - leftStage.requestBody.byteLength : null,
        responseBodyByteLengthDelta:
          leftStage && rightStage ? rightStage.responseBody.byteLength - leftStage.responseBody.byteLength : null,
      };
    }),
  };
}

async function main(argv) {
  if (argv.length < 1 || argv.length > 2 || argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(
      "Usage: node scripts/analyze-turnstile-debugger-capture.mjs <capture.json> [comparison-capture.json]\n",
    );
    return;
  }
  const webcrack = await loadWebcrack();
  const captures = [];
  for (const filename of argv) captures.push(await inspectCapture(filename, webcrack));
  process.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    safety: {
      rawSourcesIncluded: false,
      rawBodiesIncluded: false,
      rawHeadersIncluded: false,
      arbitraryIdentifiersIncluded: false,
      challengeIdentifiersRedacted: true,
      webcrackUsed: Boolean(webcrack),
    },
    captures,
    comparison: captures.length === 2 ? compare(captures[0], captures[1]) : null,
  }, null, 2)}\n`);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : null;
if (invokedPath === import.meta.url) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`Turnstile debugger capture analysis failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
