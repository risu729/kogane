// Minimal GitHub REST/GraphQL client for the trusted workflow scripts. No
// dependencies: these scripts run with `node` straight from the base checkout,
// before (and without) any package install.

const API_VERSION = "2022-11-28";

/**
 * @param {Record<string, string | undefined>} env
 * @returns {{apiUrl: string, graphqlUrl: string, token: string, owner: string, repo: string}}
 */
export function clientFromEnv(env) {
  const token = requireEnv(env, "GITHUB_TOKEN");
  const repository = requireEnv(env, "GITHUB_REPOSITORY");
  const [owner, repo] = repository.split("/");
  if (!owner || !repo) throw new Error("GITHUB_REPOSITORY must be owner/repo");
  const apiUrl = env["GITHUB_API_URL"] ?? "https://api.github.com";
  return {
    apiUrl,
    graphqlUrl: env["GITHUB_GRAPHQL_URL"] ?? `${apiUrl}/graphql`,
    token,
    owner,
    repo,
  };
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {string} name
 * @returns {string}
 */
export function requireEnv(env, name) {
  const value = env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

/**
 * @param {string} url
 * @param {{token: string, method?: string, body?: unknown, allowStatuses?: readonly number[]}} options
 * @returns {Promise<{status: number, data: any, next?: string}>}
 */
export async function request(url, { token, method = "GET", body, allowStatuses = [] }) {
  const response = await fetch(url, {
    method,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "user-agent": "kogane-automation",
      "x-github-api-version": API_VERSION,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : undefined;
  if (!response.ok && !allowStatuses.includes(response.status)) {
    const message = typeof data?.message === "string" ? data.message : response.statusText;
    throw new Error(`${method} ${url} failed with ${String(response.status)}: ${message}`);
  }
  return { status: response.status, data, next: nextLink(response.headers.get("link")) };
}

/**
 * @param {string | null} link
 * @returns {string | undefined}
 */
export function nextLink(link) {
  if (!link) return undefined;
  for (const part of link.split(",")) {
    const match = /<(?<url>[^>]+)>;\s*rel="next"/u.exec(part);
    if (match?.groups?.["url"]) return match.groups["url"];
  }
  return undefined;
}

/**
 * Follow `Link: rel="next"` until the collection is exhausted.
 *
 * @param {string} url
 * @param {{token: string, limit?: number}} options
 * @returns {Promise<any[]>}
 */
export async function paginate(url, { token, limit = 20 }) {
  const items = [];
  let next = url;
  for (let page = 0; next && page < limit; page += 1) {
    const response = await request(next, { token });
    if (!Array.isArray(response.data)) break;
    items.push(...response.data);
    next = response.next;
  }
  return items;
}

/**
 * @param {string} graphqlUrl
 * @param {{token: string, query: string, variables?: Record<string, unknown>}} options
 * @returns {Promise<any>}
 */
export async function graphql(graphqlUrl, { token, query, variables = {} }) {
  const response = await request(graphqlUrl, {
    token,
    method: "POST",
    body: { query, variables },
  });
  const errors = response.data?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error(
      `GraphQL request failed: ${errors.map((error) => String(error.message)).join("; ")}`,
    );
  }
  return response.data?.data;
}
