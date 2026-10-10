// Only project-owned route/status labels may cross the driver's closed output boundary.
const routes = Object.freeze({
  "/initialize": ["initialize", "POST"],
  "/state": ["state", "GET"],
  "/once": ["once", "POST"],
  "/stats": ["stats", "GET"],
  "/delay": ["delay", "GET"],
  "/stream": ["stream", "GET"],
  "/backpressure": ["backpressure", "GET"],
  "/backpressure-check": ["backpressure_check", "GET"],
  "/reader-resume-check": ["reader_resume_check", "GET"],
  "/reader-cancel-check": ["reader_cancel_check", "GET"],
  "/backpressure-compare": ["backpressure_compare", "GET"],
  "/stream-error-compare": ["stream_error_compare", "GET"],
  "/stream-error-check": ["stream_error_check", "GET"],
  "/stream-error": ["stream_error", "GET"],
  "/hold": ["hold", "GET"],
  "/destroy": ["destroy", "POST"],
  "/signal": ["signal", "POST"],
  "/exit": ["exit", "POST"],
});
const onceStages = Object.freeze([
  "concurrency",
  "idle_restart",
  "reader_cancel_restart",
  "destroy_restart",
  "signal_restart",
  "exit_restart",
]);
const statuses = new Map([
  [400, "bad_request"],
  [401, "unauthorized"],
  [403, "forbidden"],
  [404, "not_found"],
  [408, "request_timeout"],
  [409, "conflict"],
  [429, "rate_limited"],
  [500, "server_error"],
  [502, "bad_gateway"],
  [503, "unavailable"],
  [504, "gateway_timeout"],
]);
const categories = [
  ...statuses.values(),
  "unexpected_success",
  "redirect",
  "client_error",
  "other_server",
  "invalid_status",
];
const codes = [
  "verification_http_route",
  "verification_state_inputs",
  "verification_state_timeout",
  "verification_state_transport",
  "verification_state_response",
  "verification_state_schema",
];
const routeLabels = Object.values(routes).flatMap(([route]) =>
  route === "once" ? onceStages.map((stage) => `once_${stage}`) : [route],
);
for (const route of routeLabels) {
  for (const origin of ["outer", "upstream"])
    for (const category of categories)
      codes.push(`verification_http_${route}_${origin}_${category}`);
  codes.push(
    `verification_http_${route}_worker_exception`,
    `verification_http_${route}_worker_unauthorized`,
    `verification_http_${route}_worker_revision_invalid`,
    `verification_http_${route}_worker_route_missing`,
    `verification_http_${route}_metadata_invalid`,
  );
}
const workerErrors = new Map([
  ["worker_unauthorized", 401],
  ["worker_revision_invalid", 503],
  ["worker_route_missing", 404],
]);
const canonicalCodes = Object.freeze(codes);
/** Return the owned entry, never an untrusted string merely matching a pattern. */
export function canonicalDriverHttpCode(value) {
  return canonicalCodes.find((entry) => entry === value);
}
export function syntheticRoute(path, method, substage) {
  if (typeof path !== "string" || !Object.hasOwn(routes, path) || routes[path][1] !== method)
    throw new Error("verification_http_route");
  if (path === "/once") {
    if (!onceStages.includes(substage)) throw new Error("verification_http_route");
    return `once_${substage}`;
  }
  if (substage !== undefined) throw new Error("verification_http_route");
  return routes[path][0];
}
function statusCategory(status) {
  if (!Number.isInteger(status) || status < 100 || status > 599) return "invalid_status";
  if (statuses.has(status)) return statuses.get(status);
  if (status >= 500) return "other_server";
  if (status >= 400) return "client_error";
  if (status >= 300) return "redirect";
  if (status >= 200) return "unexpected_success";
  return "invalid_status";
}
export function syntheticHttpFailure(path, method, response, substage) {
  const route = syntheticRoute(path, method, substage);
  const failure = response.headers.get("x-verification-failure");
  const upstream = response.headers.get("x-verification-upstream-status");
  let suffix;
  if (failure === null && upstream === null) suffix = `outer_${statusCategory(response.status)}`;
  else if (response.status === 502 && failure === "worker_exception" && upstream === null)
    suffix = "worker_exception";
  else if (upstream === null && workerErrors.get(failure) === response.status) suffix = failure;
  else if (
    response.status === 502 &&
    failure === "upstream_http" &&
    /^[1-5][0-9]{2}$/u.test(upstream ?? "") &&
    upstream !== "200"
  )
    suffix = `upstream_${statusCategory(Number(upstream))}`;
  else suffix = "metadata_invalid";
  return canonicalDriverHttpCode(`verification_http_${route}_${suffix}`);
}
/** The same bounded, single request used by phase verification, with no error-body reads. */
const sdkStartupCategories = Object.freeze([
  "sdk_no_instance_response",
  "other_503_response",
  "unavailable",
]);
export function sdkStartupCategory(response) {
  if (
    response.status !== 502 ||
    response.headers.get("x-verification-failure") !== "upstream_http" ||
    response.headers.get("x-verification-upstream-status") !== "503"
  )
    return undefined;
  const value = response.headers.get("x-verification-sdk-startup");
  return sdkStartupCategories.find((category) => category === value);
}
const initializeOuterCode = "verification_http_initialize_outer_not_found";
const cfErrorTypes = Object.freeze([
  "1000",
  "1016",
  "1101",
  "1102",
  "521",
  "522",
  "523",
  "524",
  "525",
  "526",
]);
const contentTypes = Object.freeze([
  "application/json",
  "text/html",
  "text/plain",
  "application/octet-stream",
]);
/** Closed header evidence from the existing unmarked initial POST failure; never reads its body. */
export function initializeOuterFailureObservation({
  phase,
  path,
  method,
  code,
  response,
  requestUrl,
}) {
  if (
    phase !== "baseline_sdk" ||
    path !== "/initialize" ||
    method !== "POST" ||
    code !== initializeOuterCode ||
    response.status !== 404 ||
    response.headers.get("x-verification-failure") !== null ||
    response.headers.get("x-verification-upstream-status") !== null
  )
    return undefined;
  const errorType = response.headers.get("cf-error-type");
  const contentType = response.headers.get("content-type");
  const mime =
    typeof contentType === "string" && contentType.length <= 128
      ? contentType.split(";", 1)[0].trim().toLowerCase()
      : undefined;
  const responseUrl = response.url;
  return {
    code: "initialize_outer_failure_observation",
    phase: "baseline_sdk",
    cfErrorType:
      errorType === null
        ? "missing"
        : (cfErrorTypes.find((value) => value === errorType) ?? "other"),
    cfErrorOriginPresent: response.headers.has("cf-error-origin"),
    cfRayPresent: response.headers.has("cf-ray"),
    contentType:
      contentType === null ? "missing" : (contentTypes.find((value) => value === mime) ?? "other"),
    responseUrl:
      typeof responseUrl !== "string" || responseUrl === ""
        ? "absent"
        : responseUrl === requestUrl
          ? "expected"
          : "other",
    redirected: response.redirected === true,
  };
}
async function settleDiagnostic(promise, deadline) {
  // Attach a rejection handler before racing so a late rejection cannot escape.
  const pending = Promise.resolve(promise).catch(() => {});
  const remaining = Math.max(0, deadline - performance.now());
  if (remaining === 0) return;
  let timer;
  try {
    await Promise.race([
      pending,
      new Promise((done) => {
        timer = setTimeout(done, remaining);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
export function createSyntheticRequest({ origin, key, phase, fetchImpl = fetch, onFailure }) {
  return async function request(path, method = "GET", substage) {
    syntheticRoute(path, method, substage);
    let response;
    try {
      response = await fetchImpl(`${origin}${path}`, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(120_000),
        headers: {
          authorization: `Bearer ${key}`,
          ...(path === "/backpressure" ? { "accept-encoding": "identity" } : {}),
        },
      });
    } catch {
      throw new Error("verification_transport");
    }
    if (response.status !== 200) {
      const code = syntheticHttpFailure(path, method, response, substage);
      const category = sdkStartupCategory(response);
      if (path === "/once" && method === "POST" && substage === "concurrency" && category) {
        try {
          void Promise.resolve(onFailure?.({ code, category })).catch(() => {});
        } catch {
          // Closed observations cannot alter the canonical primary error.
        }
      }
      if (phase === "baseline_sdk" && code === initializeOuterCode) {
        const deadline = performance.now() + 1000;
        try {
          const observation = initializeOuterFailureObservation({
            phase,
            path,
            method,
            code,
            response,
            requestUrl: `${origin}${path}`,
          });
          // The phase writer uses synchronous O_EXCL persistence before this primary error.
          if (observation) await settleDiagnostic(onFailure?.({ code, observation }), deadline);
        } catch {
          // Header observation/persistence cannot replace the original HTTP failure.
        }
        try {
          await settleDiagnostic(response.body?.cancel(), deadline);
        } catch {
          // No body reads; failed, blocked or late cancellation preserves the primary error.
        }
      }
      throw new Error(code);
    }
    return response;
  };
}
