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

  test("the release syncs after publication, guarded for older rollback targets", () => {
    const step = workflow.indexOf("Sync the non-versioned settings of version-published Workers");
    expect(step).toBeGreaterThan(workflow.indexOf("- name: Deploy the App with cf"));
    expect(step).toBeLessThan(workflow.indexOf("- name: Record what this run deployed"));
    expect(workflow).toContain("CF_SELECTED: ${{ steps.select.outputs.cf-selected }}");
    expect(workflow).toContain(
      "if [[ -f tasks/_lib/ci/cf-script-settings.mjs ]]; then\n            node tasks/_lib/ci/cf-script-settings.mjs sync",
    );
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
  const options = { targets: [target], accountId: "b".repeat(32), token: "test-secret" };
  function mock(live: unknown, status = 200) {
    const calls: { method: string; url: string; body?: string }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ method: init.method ?? "GET", url, body: init.body as string | undefined });
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer test-secret");
      return new Response(JSON.stringify({ success: true, result: live }), { status });
    }) as unknown as typeof fetch;
    return { calls, fetchImpl };
  }

  test("patches then reads the settings back", async () => {
    const { calls, fetchImpl } = mock({
      observability: { enabled: true, head_sampling_rate: 1, issues: { enabled: true } },
    });
    expect(await syncScriptSettings({ ...options, fetchImpl })).toEqual(["mizuho"]);
    expect(calls.map((call) => call.method)).toEqual(["PATCH", "GET"]);
    expect(calls[0]!.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${"b".repeat(32)}/workers/scripts/kogane-mizuho/script-settings`,
    );
    expect(JSON.parse(calls[0]!.body!)).toEqual(target.settings);
  });

  test("a readback without the setting fails with a closed code", async () => {
    const { fetchImpl } = mock({ observability: { enabled: true } });
    await expect(syncScriptSettings({ ...options, fetchImpl })).rejects.toThrow(
      "cf_settings_readback_mismatch_mizuho",
    );
  });

  test("HTTP failures and missing credentials fail closed", async () => {
    await expect(
      syncScriptSettings({ ...options, fetchImpl: mock({}, 403).fetchImpl }),
    ).rejects.toThrow("cf_settings_http_403");
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
