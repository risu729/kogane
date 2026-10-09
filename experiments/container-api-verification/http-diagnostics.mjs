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
  "/stream-error": ["stream_error", "GET"],
  "/hold": ["hold", "GET"],
  "/destroy": ["destroy", "POST"],
  "/signal": ["signal", "POST"],
  "/exit": ["exit", "POST"],
});
const onceStages = Object.freeze([
  "concurrency",
  "idle_restart",
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
export function createSyntheticRequest({ origin, key, fetchImpl = fetch }) {
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
    if (response.status !== 200)
      throw new Error(syntheticHttpFailure(path, method, response, substage));
    return response;
  };
}
