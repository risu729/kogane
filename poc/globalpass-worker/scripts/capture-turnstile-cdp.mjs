import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const port = Number(process.argv[2] || 9225);
const outputPath = process.argv[3];
if (!outputPath) {
  throw new Error("usage: node capture-turnstile-cdp.mjs <port> <output.json>");
}

const loginUrl =
  "https://www.debit.vpass.ne.jp/p/login/RW1312010001?cc=01006";
const relevantHost = (rawUrl) => {
  try {
    const hostname = new URL(rawUrl).hostname;
    return (
      hostname === "challenges.cloudflare.com" ||
      hostname === "brunhild.challenges.cloudflare.com"
    );
  } catch {
    return false;
  }
};

const version = await fetch(`http://127.0.0.1:${port}/json/version`).then(
  (response) => response.json(),
);
const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(
  (response) => response.json(),
);
const page = targets.find(
  (target) => target.type === "page" && target.url === "about:blank",
);
if (!page) throw new Error("about:blank page target not found");

const socket = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let commandId = 0;
const pending = new Map();
const requests = new Map();
const sessions = new Map();
const sessionSetup = new Map();
const scripts = [];
const scriptTasks = new Set();
const runtimeTraces = [];
const traceTasks = new Set();
const breakpointSessions = new Set();
const senderBreakpointIds = new Set();
const vmBreakpointIds = new Map();
const vmScriptsProcessed = new Set();
const instrumentationBreakpointBySession = new Map();
let vmPauseCount = 0;

function send(method, params = {}, sessionId) {
  const id = ++commandId;
  socket.send(JSON.stringify({ id, method, params, sessionId }));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP command timeout: ${method}`));
    }, 15_000);
    pending.set(id, { resolve, reject, timer, method });
  });
}

function requestRecord(sessionId, requestId) {
  const key = `${sessionId || "browser"}:${requestId}`;
  let record = requests.get(key);
  if (!record) {
    record = { requestId, sessionId };
    requests.set(key, record);
  }
  return record;
}

function configureSession(sessionId, targetInfo, waitingForDebugger = false) {
  if (sessionSetup.has(sessionId)) return sessionSetup.get(sessionId);
  sessions.set(sessionId, targetInfo);
  const setup = (async () => {
    await Promise.allSettled([
      send(
        "Network.enable",
        {
          maxPostDataSize: 256 * 1024,
          maxResourceBufferSize: 32 * 1024 * 1024,
          maxTotalBufferSize: 128 * 1024 * 1024,
        },
        sessionId,
      ),
      send("Page.enable", {}, sessionId),
      send("Runtime.enable", {}, sessionId),
      send("Debugger.enable", { maxScriptsCacheSize: 128 * 1024 * 1024 }, sessionId),
      send("Log.enable", {}, sessionId),
      send(
        "Target.setAutoAttach",
        {
          autoAttach: true,
          waitForDebuggerOnStart: true,
          flatten: true,
        },
        sessionId,
      ),
    ]);
    try {
      const instrumentation = await send(
        "Debugger.setInstrumentationBreakpoint",
        { instrumentation: "beforeScriptExecution" },
        sessionId,
      );
      instrumentationBreakpointBySession.set(
        sessionId,
        instrumentation.breakpointId,
      );
    } catch {
      // Older protocol builds can omit instrumentation breakpoints.
    }
    if (waitingForDebugger) {
      await send("Runtime.runIfWaitingForDebugger", {}, sessionId).catch(
        () => {},
      );
    }
  })();
  sessionSetup.set(sessionId, setup);
  return setup;
}

function scheduleScriptSource(sessionId, params) {
  const targetInfo = sessions.get(sessionId);
  if (!relevantHost(params.url) && !relevantHost(targetInfo?.url)) return;
  const task = send(
    "Debugger.getScriptSource",
    { scriptId: params.scriptId },
    sessionId,
  )
    .then((result) => {
      void scheduleVmBreakpoints(
        sessionId,
        params.scriptId,
        result.scriptSource,
      );
      scripts.push({
        sessionId,
        targetType: targetInfo?.type,
        targetUrl: targetInfo?.url,
        url: params.url,
        hash: params.hash,
        sourceMapURL: params.sourceMapURL,
        scriptSource: result.scriptSource,
        bytecode: result.bytecode,
      });
    })
    .catch((error) => {
      scripts.push({
        sessionId,
        targetType: targetInfo?.type,
        targetUrl: targetInfo?.url,
        url: params.url,
        hash: params.hash,
        sourceMapURL: params.sourceMapURL,
        sourceError: String(error.message || error),
      });
    })
    .finally(() => scriptTasks.delete(task));
  scriptTasks.add(task);
}

async function scheduleVmBreakpoints(sessionId, scriptId, source) {
  const scriptKey = `${sessionId}:${scriptId}`;
  if (
    vmScriptsProcessed.has(scriptKey) ||
    typeof source !== "string" ||
    source.length < 100_000
  ) {
    return 0;
  }
  const pattern = /([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)===void 0\?([A-Za-z_$][\w$]*):\2\[\3\]/g;
  const candidates = [...source.matchAll(pattern)].slice(0, 16);
  if (candidates.length === 0) return 0;
  vmScriptsProcessed.add(scriptKey);
  await Promise.allSettled(
    candidates.map(async (match, candidateIndex) => {
      const result = await send(
        "Debugger.setBreakpoint",
        {
          location: {
            scriptId,
            lineNumber: 0,
            columnNumber: match.index,
          },
        },
        sessionId,
      );
      vmBreakpointIds.set(result.breakpointId, {
        sessionId,
        scriptId,
        candidateIndex,
        requestedColumn: match.index,
        actualLocation: result.actualLocation,
      });
    }),
  );
  return candidates.length;
}

function scheduleSenderBreakpoint(sessionId, initiator) {
  if (breakpointSessions.has(sessionId)) return;
  const frame = initiator?.stack?.callFrames?.[0];
  if (!frame?.url || !relevantHost(frame.url)) return;
  breakpointSessions.add(sessionId);
  void send(
    "Debugger.setBreakpointByUrl",
    {
      lineNumber: frame.lineNumber,
      columnNumber: frame.columnNumber,
      url: frame.url,
    },
    sessionId,
  )
    .then((result) => {
      senderBreakpointIds.add(result.breakpointId);
      runtimeTraces.push({
        kind: "sender-breakpoint",
        sessionId,
        requestedLocation: {
          url: frame.url,
          lineNumber: frame.lineNumber,
          columnNumber: frame.columnNumber,
        },
        breakpointId: result.breakpointId,
        actualLocations: result.locations,
      });
    })
    .catch((error) => {
      runtimeTraces.push({
        kind: "sender-breakpoint-error",
        sessionId,
        requestedLocation: {
          url: frame.url,
          lineNumber: frame.lineNumber,
          columnNumber: frame.columnNumber,
        },
        error: String(error.message || error),
      });
    });
}

function schedulePauseTrace(sessionId, params) {
  const task = (async () => {
    if (params.reason === "instrumentation") {
      const topFrame = params.callFrames[0];
      let breakpointCount = 0;
      if (topFrame?.location?.scriptId) {
        try {
          const source = await send(
            "Debugger.getScriptSource",
            { scriptId: topFrame.location.scriptId },
            sessionId,
          );
          breakpointCount = await scheduleVmBreakpoints(
            sessionId,
            topFrame.location.scriptId,
            source.scriptSource,
          );
        } catch {
          // Resume even if an ephemeral script disappears.
        }
      }
      if (breakpointCount > 0) {
        const instrumentationBreakpointId =
          instrumentationBreakpointBySession.get(sessionId);
        if (instrumentationBreakpointId) {
          await send(
            "Debugger.removeBreakpoint",
            { breakpointId: instrumentationBreakpointId },
            sessionId,
          ).catch(() => {});
          instrumentationBreakpointBySession.delete(sessionId);
        }
      }
      await send("Debugger.resume", {}, sessionId).catch(() => {});
      return;
    }

    const vmBreakpointId = params.hitBreakpoints?.find((breakpointId) =>
      vmBreakpointIds.has(breakpointId),
    );
    if (vmBreakpointId && vmPauseCount < 512) {
      vmPauseCount += 1;
      const safeStrings = new Set();
      const topFrame = params.callFrames[0];
      for (const scope of topFrame?.scopeChain || []) {
        if (!scope.object?.objectId) continue;
        try {
          const properties = await send(
            "Runtime.getProperties",
            {
              objectId: scope.object.objectId,
              ownProperties: true,
              accessorPropertiesOnly: false,
              generatePreview: false,
            },
            sessionId,
          );
          for (const property of properties.result || []) {
            const value = property.value?.value;
            if (
              typeof value === "string" &&
              /^[A-Za-z_$][A-Za-z0-9_$.-]{0,80}$/.test(value)
            ) {
              safeStrings.add(value);
            }
          }
        } catch {
          // Some optimized scopes disappear before CDP can enumerate them.
        }
      }
      const breakpoint = vmBreakpointIds.get(vmBreakpointId);
      runtimeTraces.push({
        kind: "vm-property-pause",
        sessionId,
        breakpoint,
        safeStrings: [...safeStrings].sort(),
      });
      await send("Debugger.resume", {}, sessionId).catch(() => {});
      return;
    }

    const hitSender = params.hitBreakpoints?.some((breakpointId) =>
      senderBreakpointIds.has(breakpointId),
    );
    if (!hitSender) {
      await send("Debugger.resume", {}, sessionId).catch(() => {});
      return;
    }

    const frames = [];
    const expression = `(() => {
      const shape = (value) => {
        const result = { type: typeof value };
        if (value === null) return { type: 'object', subtype: 'null' };
        if (typeof value === 'string') {
          result.length = value.length;
          return result;
        }
        if (typeof value === 'number') {
          result.finite = Number.isFinite(value);
          return result;
        }
        if (typeof value === 'object' || typeof value === 'function') {
          try { result.constructor = value.constructor?.name || null; } catch {}
          try { result.arrayLength = Array.isArray(value) ? value.length : null; } catch {}
          try { result.keys = Object.keys(value).slice(0, 128); } catch { result.keysError = true; }
        }
        return result;
      };
      let args = [];
      try { args = Array.from(arguments, shape); } catch {}
      let receiver = null;
      try { receiver = shape(this); } catch {}
      return { args, receiver };
    })()`;
    for (const callFrame of params.callFrames.slice(0, 12)) {
      let evaluation;
      try {
        const result = await send(
          "Debugger.evaluateOnCallFrame",
          {
            callFrameId: callFrame.callFrameId,
            expression,
            returnByValue: true,
            silent: true,
          },
          sessionId,
        );
        evaluation = result.result?.value || null;
      } catch (error) {
        evaluation = { error: String(error.message || error) };
      }
      frames.push({
        functionName: callFrame.functionName,
        url: callFrame.url,
        location: callFrame.location,
        evaluation,
      });
    }
    runtimeTraces.push({
      kind: "sender-pause",
      sessionId,
      reason: params.reason,
      hitBreakpoints: params.hitBreakpoints,
      frames,
    });
    await send("Debugger.resume", {}, sessionId).catch(() => {});
  })().finally(() => traceTasks.delete(task));
  traceTasks.add(task);
}

async function collectBodies(record) {
  if (record.method === "POST" && record.requestPostData === undefined) {
    try {
      const result = await send("Network.getRequestPostData", {
        requestId: record.requestId,
      }, record.sessionId);
      record.requestPostData = result.postData;
    } catch (error) {
      record.requestPostDataError = String(error.message || error);
    }
  }
  if (
    record.responseBody === undefined &&
    ["Document", "Script", "Fetch", "XHR"].includes(record.resourceType)
  ) {
    try {
      const result = await send("Network.getResponseBody", {
        requestId: record.requestId,
      }, record.sessionId);
      record.responseBody = result.body;
      record.responseBodyBase64Encoded = result.base64Encoded;
    } catch (error) {
      record.responseBodyError = String(error.message || error);
    }
  }
}

socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    pending.delete(message.id);
    if (message.error) {
      waiter.reject(
        new Error(`${waiter.method}: ${message.error.message || "failed"}`),
      );
    } else {
      waiter.resolve(message.result || {});
    }
    return;
  }

  const { method, params, sessionId } = message;
  if (method === "Target.attachedToTarget") {
    configureSession(
      params.sessionId,
      params.targetInfo,
      params.waitingForDebugger,
    );
    return;
  }
  if (method === "Target.targetInfoChanged") {
    for (const [attachedSessionId, targetInfo] of sessions.entries()) {
      if (targetInfo.targetId === params.targetInfo.targetId) {
        sessions.set(attachedSessionId, params.targetInfo);
      }
    }
    return;
  }
  if (method === "Debugger.scriptParsed") {
    scheduleScriptSource(sessionId, params);
    return;
  }
  if (method === "Debugger.paused") {
    schedulePauseTrace(sessionId, params);
    return;
  }
  if (method === "Network.requestWillBeSent") {
    const record = requestRecord(sessionId, params.requestId);
    Object.assign(record, {
      url: params.request.url,
      relevant: relevantHost(params.request.url),
      method: params.request.method,
      resourceType: params.type,
      initiator: params.initiator,
      requestHeaders: params.request.headers,
      hasPostData: params.request.hasPostData || false,
      requestPostData: params.request.postData,
      wallTime: params.wallTime,
    });
    if (record.relevant && record.method === "POST") {
      scheduleSenderBreakpoint(sessionId, params.initiator);
    }
    return;
  }
  if (method === "Network.requestWillBeSentExtraInfo") {
    const record = requestRecord(sessionId, params.requestId);
    record.requestHeadersExtra = params.headers;
    record.associatedCookies = params.associatedCookies?.map((cookie) => ({
      name: cookie.cookie?.name,
      domain: cookie.cookie?.domain,
      blockedReasons: cookie.blockedReasons,
    }));
    return;
  }
  if (method === "Network.responseReceived") {
    const record = requestRecord(sessionId, params.requestId);
    Object.assign(record, {
      url: params.response.url,
      relevant: relevantHost(params.response.url),
      resourceType: params.type,
      status: params.response.status,
      protocol: params.response.protocol,
      remoteIPAddress: params.response.remoteIPAddress,
      responseHeaders: params.response.headers,
      securityDetails: params.response.securityDetails,
    });
    return;
  }
  if (method === "Network.loadingFinished") {
    const record = requestRecord(sessionId, params.requestId);
    record.encodedDataLength = params.encodedDataLength;
    if (record.relevant) void collectBodies(record);
    return;
  }
  if (method === "Network.loadingFailed") {
    const record = requestRecord(sessionId, params.requestId);
    record.loadingFailed = {
      errorText: params.errorText,
      blockedReason: params.blockedReason,
      canceled: params.canceled,
    };
  }
});

await send("Target.setDiscoverTargets", { discover: true });
await send("Target.setAutoAttach", {
  autoAttach: true,
  waitForDebuggerOnStart: true,
  flatten: true,
});

await new Promise((resolve) => setTimeout(resolve, 500));
let pageSessionId = [...sessions.entries()].find(
  ([, targetInfo]) => targetInfo.targetId === page.id,
)?.[0];
if (!pageSessionId) {
  pageSessionId = (
    await send("Target.attachToTarget", {
      targetId: page.id,
      flatten: true,
    })
  ).sessionId;
  await configureSession(pageSessionId, page);
}
await sessionSetup.get(pageSessionId);
await send("Page.navigate", { url: loginUrl }, pageSessionId);

let pageState = null;
for (let attempt = 0; attempt < 450; attempt += 1) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  try {
    const result = await send("Runtime.evaluate", {
      expression: `(() => ({
        title: document.title,
        tokenLength: String(document.querySelector('input[name="cf-turnstile-response"]')?.value || '').length,
        widgetPresent: Boolean(document.querySelector('.cf-turnstile')),
        loginFormVisible: Boolean(document.querySelector('#usrId')),
        accessDenied: /Access Denied|アクセスが拒否/i.test(document.body?.innerText || ''),
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        language: navigator.language,
        languages: navigator.languages,
        webdriver: navigator.webdriver,
        screen: {
          width: screen.width,
          height: screen.height,
          colorDepth: screen.colorDepth,
          devicePixelRatio
        }
      }))()`,
      returnByValue: true,
    }, pageSessionId);
    pageState = result.result?.value || null;
    if (pageState?.tokenLength > 20) break;
  } catch {
    // Navigation can replace the execution context while the page loads.
  }
}

await new Promise((resolve) => setTimeout(resolve, 2_000));
await Promise.allSettled([...traceTasks]);
await Promise.allSettled([...scriptTasks]);
for (const record of requests.values()) {
  if (!record.relevant) continue;
  await collectBodies(record);
}

const relevantRequests = [...requests.values()].filter(
  (request) => request.relevant,
);

const capture = {
  capturedAt: new Date().toISOString(),
  browser: version.Browser,
  userAgent: version["User-Agent"],
  pageState,
  targets: [...sessions.entries()].map(([sessionId, targetInfo]) => ({
    sessionId,
    targetInfo,
  })),
  scripts,
  runtimeTraces,
  requests: relevantRequests,
};
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(capture, null, 2), { mode: 0o600 });
await chmod(outputPath, 0o600);
socket.close();

console.log(
  JSON.stringify({
    outputPath,
    tokenLength: pageState?.tokenLength || 0,
    relevantRequests: capture.requests.length,
    postBodies: capture.requests.filter(
      (request) => request.method === "POST" && request.requestPostData,
    ).length,
    responseBodies: capture.requests.filter(
      (request) => request.responseBody !== undefined,
    ).length,
    scriptSources: capture.scripts.filter(
      (script) => script.scriptSource !== undefined,
    ).length,
    senderPauses: capture.runtimeTraces.filter(
      (trace) => trace.kind === "sender-pause",
    ).length,
    vmPropertyPauses: capture.runtimeTraces.filter(
      (trace) => trace.kind === "vm-property-pause",
    ).length,
  }),
);
