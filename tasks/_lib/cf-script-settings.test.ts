import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  containsSettings,
  scriptSettingsFailureCode,
  scriptSettingsTargets,
  syncScriptSettings,
} from "./ci/cf-script-settings.mjs";
import { REPO_ROOT } from "./repo-root.ts";

const order = JSON.parse(readFileSync(`${REPO_ROOT}/infra/deploy-order.json`, "utf8"));
const cfWorkers = order.workers.filter((worker: any) => worker.deployBackend === "cf");
const workflow = readFileSync(`${REPO_ROOT}/.github/workflows/_deploy-workers.yml`, "utf8");

describe("scriptSettingsTargets", () => {
  const targets = scriptSettingsTargets({
    root: REPO_ROOT,
    order,
    selected: cfWorkers.map((worker: any) => worker.name),
  });

  test("covers every version-published cf Worker and none on cf deploy", () => {
    expect(targets.map((target: any) => target.name).sort()).toEqual(
      cfWorkers
        .filter((worker: any) => worker.productionStrategy !== "deploy")
        .map((worker: any) => worker.name)
        .sort(),
    );
    expect(targets.length).toBeGreaterThan(0);
  });

  test("the Container Workers' cf deploy config turns Workers Issues on", async () => {
    const containers = cfWorkers.filter((worker: any) => worker.productionStrategy === "deploy");
    expect(containers.length).toBe(3);
    for (const worker of containers) {
      const config = (await import(`${REPO_ROOT}/${worker.path}/cloudflare.config.ts`)).default;
      expect(config.worker.observability.issues).toEqual({ enabled: true });
    }
  });

  test("every production cf Worker turns Workers Issues on", () => {
    for (const worker of cfWorkers) {
      const [target] = scriptSettingsTargets({
        root: REPO_ROOT,
        order: { workers: [{ ...worker, productionStrategy: undefined }] },
        selected: [worker.name],
      });
      expect(target.settings.observability.enabled).toBe(true);
      expect(target.settings.observability.issues).toEqual({ enabled: true });
    }
  });

  test("only selected Workers are synced", () => {
    const one = targets[0]!;
    expect(
      scriptSettingsTargets({ root: REPO_ROOT, order, selected: [one.name] }).map(
        (target: any) => target.name,
      ),
    ).toEqual([one.name]);
  });

  test("the release runs the trusted helper on the run's plan after the alarm reconcile", () => {
    const step = workflow.indexOf(
      "- name: Sync the non-versioned settings of version-published Workers",
    );
    expect(step).toBeGreaterThan(workflow.indexOf("- name: Reconcile future schedule alarms"));
    expect(step).toBeLessThan(workflow.indexOf("- name: Record what this run deployed"));
    const body = workflow.slice(step, workflow.indexOf("- name: Record what this run deployed"));
    // The plan, not every cf Worker: a partial rollback must not touch the rest.
    expect(body).toContain("SELECTED: ${{ steps.select.outputs.selected }}");
    expect(body).not.toContain("cf-selected");
    expect(body).toContain('run: node "${SCRIPT_SETTINGS}" sync');
    expect(workflow).toMatch(
      /for path in [^\n]*tasks\/_lib\/ci\/cf-script-settings\.mjs[^\n]*; do/u,
    );
    expect(workflow).toContain(
      "printf 'SCRIPT_SETTINGS=%s\\n' \"${guard}/tasks/_lib/ci/cf-script-settings.mjs\"",
    );
  });

  test("a config without observability keeps the live settings", () => {
    const worker = cfWorkers.find((entry: any) => entry.productionStrategy !== "deploy");
    expect(
      scriptSettingsTargets({
        root: REPO_ROOT,
        order: { workers: [{ ...worker, config: "package.json" }] },
        selected: [worker.name],
      }),
    ).toEqual([]);
  });
});

test("containsSettings compares only the declared values", () => {
  expect(
    containsSettings(
      { observability: { enabled: true, issues: { enabled: true } } },
      { observability: { enabled: true, head_sampling_rate: 1, issues: { enabled: true } } },
    ),
  ).toBe(true);
  expect(
    containsSettings(
      { observability: { issues: { enabled: true } } },
      { observability: { enabled: true } },
    ),
  ).toBe(false);
  expect(containsSettings({ a: 1 }, null)).toBe(false);
});

describe("syncScriptSettings", () => {
  const target = {
    name: "mizuho",
    worker: "kogane-mizuho",
    settings: { observability: { enabled: true, issues: { enabled: true } } },
  };
  const options = {
    targets: [target],
    accountId: "b".repeat(32),
    token: "test-secret",
    backoffMs: 0,
  };
  function mock(live: unknown, statuses: number[] = [200]) {
    const calls: { method: string; url: string; body?: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ method: init.method ?? "GET", url, body: init.body as string | undefined });
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-secret");
      const status = statuses[Math.min(calls.length - 1, statuses.length - 1)]!;
      return new Response(JSON.stringify({ success: true, result: live }), { status });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  test("patches then reads the settings back", async () => {
    const { calls, fetchImpl } = mock({
      observability: { enabled: true, head_sampling_rate: 1, issues: { enabled: true } },
    });
    expect(await syncScriptSettings({ ...options, fetchImpl })).toEqual({
      synced: ["mizuho"],
      unconfirmed: [],
    });
    expect(calls.map((call) => call.method)).toEqual(["PATCH", "GET"]);
    expect(calls[0]!.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${"b".repeat(32)}/workers/scripts/kogane-mizuho/script-settings`,
    );
    expect(JSON.parse(calls[0]!.body!)).toEqual(target.settings);
  });

  test("an accepted PATCH whose readback lacks the setting is reported, not failed", async () => {
    const { fetchImpl } = mock({ observability: { enabled: true } });
    expect(await syncScriptSettings({ ...options, fetchImpl })).toEqual({
      synced: [],
      unconfirmed: ["mizuho"],
    });
  });

  test("429 and 5xx are retried a bounded number of times", async () => {
    const live = { observability: { enabled: true, issues: { enabled: true } } };
    const retried = mock(live, [503, 429, 200, 200]);
    expect((await syncScriptSettings({ ...options, fetchImpl: retried.fetchImpl })).synced).toEqual(
      ["mizuho"],
    );
    expect(retried.calls.map((call) => call.method)).toEqual(["PATCH", "PATCH", "PATCH", "GET"]);
    const down = mock(live, [503]);
    await expect(syncScriptSettings({ ...options, fetchImpl: down.fetchImpl })).rejects.toThrow(
      "cf_settings_unavailable",
    );
    expect(down.calls).toHaveLength(3);
  });

  test("other HTTP failures and missing credentials fail closed without retry", async () => {
    const forbidden = mock({}, [403]);
    await expect(
      syncScriptSettings({ ...options, fetchImpl: forbidden.fetchImpl }),
    ).rejects.toThrow("cf_settings_http_403");
    expect(forbidden.calls).toHaveLength(1);
    await expect(syncScriptSettings({ ...options, accountId: "x" })).rejects.toThrow(
      "cf_settings_credentials_missing",
    );
  });

  test("unknown errors never print their message", () => {
    expect(scriptSettingsFailureCode(new Error("/home/runner/secret path"))).toBe(
      "cf_settings_internal_error",
    );
    expect(scriptSettingsFailureCode(new Error("cf_settings_http_500"))).toBe(
      "cf_settings_http_500",
    );
  });
});
