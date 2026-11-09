import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonc } from "../../../scripts/jsonc.ts";

/**
 * Workers whose production publication is `cf workers versions create` plus
 * `cf workers deployments create`. Neither call carries the non-versioned
 * script settings (`observability` among them), so after publication this
 * module applies them the way `wrangler versions deploy` does. Workers on the
 * `deploy` strategy get them from `cf deploy` itself. A Worker whose config
 * declares no `observability` keeps its live settings.
 */
export function scriptSettingsTargets({ root, order, selected }) {
  return order.workers
    .filter(
      (worker) =>
        worker.deployBackend === "cf" &&
        worker.productionStrategy !== "deploy" &&
        selected.includes(worker.name),
    )
    .flatMap((worker) => {
      const config = parseJsonc(
        readFileSync(resolve(root, worker.path, worker.config), "utf8"),
        worker.config,
      );
      const observability = config.observability;
      if (observability === undefined) return [];
      if (
        observability === null ||
        typeof observability !== "object" ||
        Array.isArray(observability)
      )
        throw new Error(`cf_settings_invalid_observability_${worker.name}`);
      if (!/^[a-z0-9-]{1,63}$/u.test(worker.worker ?? ""))
        throw new Error(`cf_settings_invalid_worker_${worker.name}`);
      return [{ name: worker.name, worker: worker.worker, settings: { observability } }];
    });
}

/** Whether every value `expected` declares is present and equal in `actual`. */
export function containsSettings(expected, actual) {
  if (expected === null || typeof expected !== "object") return Object.is(expected, actual);
  if (
    actual === null ||
    typeof actual !== "object" ||
    Array.isArray(expected) !== Array.isArray(actual)
  )
    return false;
  return Object.entries(expected).every(([key, value]) => containsSettings(value, actual[key]));
}

/** Transient answers worth one more try; every call here is idempotent. */
const RETRYABLE = new Set(["cf_settings_unavailable", "cf_settings_http_429"]);

export async function syncScriptSettings({
  targets,
  accountId,
  token,
  fetchImpl = fetch,
  attempts = 3,
  backoffMs = 2000,
}) {
  if (!/^[a-f0-9]{32}$/u.test(accountId ?? "") || !token)
    throw new Error("cf_settings_credentials_missing");
  const once = async (worker, init) => {
    let response;
    try {
      response = await fetchImpl(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/${worker}/script-settings`,
        {
          ...init,
          redirect: "manual",
          signal: AbortSignal.timeout(30000),
          headers: {
            Authorization: `Bearer ${token}`,
            ...(init.body ? { "Content-Type": "application/json" } : {}),
          },
        },
      );
    } catch {
      throw new Error("cf_settings_unavailable");
    }
    if (response.status !== 200)
      throw new Error(
        response.status >= 500 ? "cf_settings_unavailable" : `cf_settings_http_${response.status}`,
      );
    let envelope;
    try {
      envelope = await response.json();
    } catch {
      throw new Error("cf_settings_invalid_response");
    }
    if (envelope?.success !== true || !envelope.result)
      throw new Error("cf_settings_invalid_response");
    return envelope.result;
  };
  const api = async (worker, init) => {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await once(worker, init);
      } catch (error) {
        if (attempt >= attempts || !RETRYABLE.has(error.message)) throw error;
        await new Promise((done) => setTimeout(done, backoffMs * attempt));
      }
    }
  };
  const synced = [];
  const unconfirmed = [];
  for (const target of targets) {
    await api(target.worker, { method: "PATCH", body: JSON.stringify(target.settings) });
    const live = await api(target.worker, { method: "GET" });
    // The PATCH was accepted; a readback that does not echo every declared
    // value is reported, not failed, because the GET shape is not documented.
    (containsSettings(target.settings, live) ? synced : unconfirmed).push(target.name);
  }
  return { synced, unconfirmed };
}

/**
 * The one line the command prints when it fails: its own closed code, or
 * `cf_settings_internal_error`, so a path or parser excerpt never reaches the
 * release log.
 *
 * @param {unknown} error
 * @returns {string}
 */
export function scriptSettingsFailureCode(error) {
  return error instanceof Error && /^cf_settings_[A-Za-z0-9_-]+$/u.test(error.message)
    ? error.message
    : "cf_settings_internal_error";
}

/** Compared by real path, as in cf-do-identity.mjs. */
function invokedDirectly() {
  try {
    return (
      process.argv[1] !== undefined &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}
if (invokedDirectly()) {
  try {
    const [mode] = process.argv.slice(2);
    if (mode !== "sync") throw new Error("cf_settings_invalid_command");
    let selected;
    try {
      selected = JSON.parse(process.env.SELECTED ?? "");
    } catch {
      throw new Error("cf_settings_invalid_selection");
    }
    if (!Array.isArray(selected) || selected.some((name) => typeof name !== "string"))
      throw new Error("cf_settings_invalid_selection");
    const root = process.cwd();
    const order = JSON.parse(readFileSync(resolve(root, "infra/deploy-order.json"), "utf8"));
    const targets = scriptSettingsTargets({ root, order, selected });
    const { synced, unconfirmed } = await syncScriptSettings({
      targets,
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      token: process.env.CLOUDFLARE_API_TOKEN,
    });
    const lines = [`cf_settings_synced ${synced.length === 0 ? "none" : synced.join(",")}`];
    if (unconfirmed.length > 0) {
      lines.push(`cf_settings_readback_unconfirmed ${unconfirmed.join(",")}`);
      console.log(`::warning::cf_settings_readback_unconfirmed ${unconfirmed.join(",")}`);
    }
    for (const line of lines) console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join("\n")}\n`);
  } catch (error) {
    const code = scriptSettingsFailureCode(error);
    console.error(code);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${code}\n`);
    process.exitCode = 1;
  }
}
