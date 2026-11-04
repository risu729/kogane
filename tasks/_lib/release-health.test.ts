import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { assessReleaseHealth, HEALTH_POLICY, pollReleaseHealth } from "./ci/release-health.mjs";
import { REPO_ROOT } from "./repo-root.ts";

const sha = "a".repeat(40),
  old = "b".repeat(40),
  migration = "0077_synthetic.sql";
const healthy = (app = sha, processor = sha) => ({
  status: "ok",
  releaseSha: app,
  core: { bound: true, ok: true, migrationsApplied: [migration] },
  read: { required: true, bound: true, ok: true },
  data: { bound: true, ok: true, markerPresent: false },
  grants: { usable: true },
  capabilities: {},
  processor: { ok: true, releaseSha: processor },
});
const input = {
  url: "http://127.0.0.1/api/ops/v1/health",
  expectedSha: sha,
  expectedMigration: migration,
  clientId: "synthetic-client",
  clientSecret: "synthetic-private",
};
const short = { totalMs: 1000, requestMs: 200, delayMs: 1 };
async function withServer(handler: any, run: any) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    return await run(`http://127.0.0.1:${address.port}/api/ops/v1/health`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("authenticated release readiness keeps exact target and health checks", () => {
  test("six attempts share the existing ceiling, not nested curl retries", () => {
    expect(HEALTH_POLICY).toEqual({
      totalMs: 6 * 30000 + 5 * 5000,
      requestMs: 30000,
      delayMs: 5000,
      maxAttempts: 6,
    });
    const workflow = readFileSync(`${REPO_ROOT}/.github/workflows/_deploy-workers.yml`, "utf8");
    const step = workflow.slice(
      workflow.indexOf("      - name: Postcheck the App and the Processor"),
      workflow.indexOf("      - name: Reconcile future schedule alarms"),
    );
    expect(step).toContain('run: node "${RELEASE_HEALTH}"');
    expect(step).not.toContain("curl");
    expect(workflow).toContain("tasks/_lib/ci/release-health.mjs tasks/_lib/ci/github-api.mjs");
    expect(workflow.indexOf("tasks/_lib/ci/release-health.mjs")).toBeLessThan(
      workflow.indexOf("      - name: Checkout the exact commit"),
    );
  });
  test("real authenticated HTTP old App/Processor -> exact pair recovers with only GETs", async () => {
    let attempts = 0;
    await withServer(
      (request: any, response: any) => {
        expect(request.method).toBe("GET");
        expect(request.url).toBe("/api/ops/v1/health");
        expect(request.headers["cf-access-client-id"] === input.clientId).toBe(true);
        expect(request.headers["cf-access-client-secret"] === input.clientSecret).toBe(true);
        attempts++;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify(attempts === 1 ? healthy(old, old) : healthy()));
      },
      async (url: string) => {
        const proof = await pollReleaseHealth({ ...input, url, policy: short });
        expect(proof.status).toBe("verified");
        expect(proof.releaseSha).toBe(sha);
        expect(proof.attempts).toBe(2);
        expect(JSON.stringify(proof)).not.toContain(input.clientSecret);
      },
    );
    expect(attempts).toBe(2);
  });
  test("native Node fetch proves real HTTP recovery, cap, redirect and body deadline", async () => {
    const helper = pathToFileURL(`${REPO_ROOT}/tasks/_lib/ci/release-health.mjs`).href;
    const script = `
      import { createServer } from "node:http";
      import assert from "node:assert/strict";
      import { pollReleaseHealth } from ${JSON.stringify(helper)};
      const input = ${JSON.stringify(input)};
      const healthy = ${JSON.stringify(healthy())};
      const old = ${JSON.stringify(old)};
      const policy = { totalMs: 2000, requestMs: 500, delayMs: 1 };
      let reads = 0, mode = "recover", accepted = false;
      const server = createServer((request, response) => {
        reads++;
        assert.equal(request.method, "GET");
        assert.equal(request.url, "/api/ops/v1/health");
        assert.equal(request.headers["cf-access-client-id"], input.clientId);
        assert.equal(request.headers["cf-access-client-secret"], input.clientSecret);
        if (mode === "redirect") {
          response.writeHead(302, { location: "/login" }); response.end(); return;
        }
        if (mode === "stall") {
          response.writeHead(200); response.write("{"); return;
        }
        const body = mode === "pending" || reads === 1
          ? { ...healthy, releaseSha: old } : healthy;
        response.end(JSON.stringify(body));
      });
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      const url = "http://127.0.0.1:" + server.address().port + "/api/ops/v1/health";
      try {
        assert.equal((await pollReleaseHealth({ ...input, url, policy })).attempts, 2);
        assert.equal(reads, 2);
        mode = "pending"; reads = 0;
        await assert.rejects(pollReleaseHealth({ ...input, url, policy }), /health_identity_pending/);
        assert.equal(reads, 6);
        mode = "redirect"; reads = 0;
        await assert.rejects(pollReleaseHealth({ ...input, url, policy }), /health_http_rejected/);
        assert.equal(reads, 1);
        mode = "stall"; reads = 0;
        await assert.rejects(pollReleaseHealth({ ...input, url,
          policy: { totalMs: 60, requestMs: 500, delayMs: 1 }
        }).then(() => { accepted = true; }), /health_deadline_exceeded/);
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(reads, 1); assert.equal(accepted, false);
        console.log("native_node_health_checks_passed");
      } finally {
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
      }
    `;
    const result = await new Promise<{ code: number | null; stdout: string; stderr: string }>(
      (resolve, reject) => {
        const child = spawn("node", ["--input-type=module"], { stdio: ["pipe", "pipe", "pipe"] });
        let stdout = "",
          stderr = "";
        child.stdout.on("data", (chunk) => {
          stdout += chunk;
        });
        child.stderr.on("data", (chunk) => {
          stderr += chunk;
        });
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout, stderr }));
        child.stdin.end(script);
      },
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("native_node_health_checks_passed");
  });
  test("healthy stale App or Processor exhausts exactly six single reads", async () => {
    for (const body of [healthy(old), healthy(sha, old)]) {
      let reads = 0;
      await expect(
        pollReleaseHealth({
          ...input,
          policy: short,
          fetchImpl: async () => {
            reads++;
            return Response.json(body);
          },
        }),
      ).rejects.toThrow("health_identity_pending");
      expect(reads).toBe(6);
    }
  });
  test("real transport interruption retries inside the same six-read budget", async () => {
    let reads = 0;
    await withServer(
      (request: any, response: any) => {
        reads++;
        if (reads === 1) request.socket.destroy();
        else response.end(JSON.stringify(healthy()));
      },
      async (url: string) => {
        expect((await pollReleaseHealth({ ...input, url, policy: short })).attempts).toBe(2);
      },
    );
    expect(reads).toBe(2);
  });
  test("malformed JSON/HTML, auth rejection, redirect and every HTTP failure fail once", async () => {
    for (const [status, body] of [
      [200, "<html>login</html>"],
      [200, "{} {}"],
      [200, "null"],
      [302, ""],
      [401, "private rejection"],
      [403, "private rejection"],
      [429, ""],
      [500, ""],
      [503, ""],
    ] as const) {
      let reads = 0;
      await withServer(
        (_request: any, response: any) => {
          reads++;
          response.statusCode = status;
          if (status === 302) response.setHeader("location", "/login");
          response.end(body);
        },
        async (url: string) => {
          await expect(pollReleaseHealth({ ...input, url, policy: short })).rejects.toThrow(
            status === 200 ? "health_response_invalid" : "health_http_rejected",
          );
        },
      );
      expect(reads).toBe(1);
    }
  });
  test("malformed identities and actual health/schema failure never become pending", async () => {
    const cases = [
      { ...healthy(old), releaseSha: "" },
      { ...healthy(old), releaseSha: "latest" },
      { ...healthy(old), releaseSha: [old] },
      { ...healthy(old), processor: { ok: true, releaseSha: [old] } },
      { ...healthy(old), processor: { ok: true, releaseSha: 42 } },
      { ...healthy(old), status: "degraded" },
      { ...healthy(old), core: { bound: true, ok: false, migrationsApplied: [migration] } },
      { ...healthy(old), core: { bound: true, ok: true, migrationsApplied: [] } },
      { ...healthy(old), core: { bound: true, ok: true, migrationsApplied: [42] } },
      { ...healthy(old), read: { required: true, bound: true, ok: false } },
      { ...healthy(old), read: { required: "true", bound: true, ok: true } },
      { ...healthy(old), processor: { ok: false, releaseSha: old } },
      { ...healthy(old), data: { bound: true, ok: false, markerPresent: false } },
      { ...healthy(old), grants: { usable: false } },
      { ...healthy(old), capabilities: null },
    ];
    for (const body of cases) {
      let reads = 0;
      await expect(
        pollReleaseHealth({
          ...input,
          policy: short,
          fetchImpl: async () => {
            reads++;
            return Response.json(body);
          },
        }),
      ).rejects.toThrow(/^health_(response_invalid|unhealthy|core_migration_missing)$/u);
      expect(reads).toBe(1);
    }
  });
  test("real response body stall is bounded by request timer and retries are capped", async () => {
    let reads = 0;
    await withServer(
      (_request: any, response: any) => {
        reads++;
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"status":');
      },
      async (url: string) => {
        const started = performance.now();
        await expect(
          pollReleaseHealth({
            ...input,
            url,
            policy: { totalMs: 1000, requestMs: 40, delayMs: 1, maxAttempts: 2 },
          }),
        ).rejects.toThrow("health_transport_unavailable");
        expect(performance.now() - started).toBeLessThan(800);
      },
    );
    expect(reads).toBe(2);
  });
  test("real total deadline includes stalled headers/body and sleep, with no later acceptance", async () => {
    for (const headers of [true, false]) {
      let accepted = false;
      await withServer(
        (_request: any, response: any) => {
          if (headers) {
            response.writeHead(200);
            response.write('{"status":');
          }
          setTimeout(() => {
            if (!response.destroyed) response.end(JSON.stringify(healthy()));
          }, 150);
        },
        async (url: string) => {
          const started = performance.now();
          await expect(
            pollReleaseHealth({
              ...input,
              url,
              policy: { totalMs: 60, requestMs: 200, delayMs: 1 },
            }).then(() => {
              accepted = true;
            }),
          ).rejects.toThrow("health_deadline_exceeded");
          expect(performance.now() - started).toBeLessThan(800);
          await new Promise((resolve) => setTimeout(resolve, 180));
          expect(accepted).toBe(false);
        },
      );
    }
    let reads = 0;
    await expect(
      pollReleaseHealth({
        ...input,
        policy: { totalMs: 30, requestMs: 100, delayMs: 100 },
        fetchImpl: async () => {
          reads++;
          return Response.json(healthy(old));
        },
      }),
    ).rejects.toThrow("health_deadline_exceeded");
    expect(reads).toBe(1);
  });
  test("target captured before awaiting; a late complete body cannot publish proof", async () => {
    const parameters: any = {
      ...input,
      policy: short,
      fetchImpl: async () => {
        parameters.expectedSha = old;
        return Response.json(healthy(old));
      },
    };
    await expect(pollReleaseHealth(parameters)).rejects.toThrow("health_identity_pending");
    let clock = 0,
      accepted = false;
    await expect(
      pollReleaseHealth({
        ...input,
        now: () => clock,
        policy: short,
        fetchImpl: async () => {
          clock = short.totalMs;
          return Response.json(healthy());
        },
      }).then(() => {
        accepted = true;
      }),
    ).rejects.toThrow("health_deadline_exceeded");
    expect(accepted).toBe(false);
  });
  test("oversized/redirected body, invalid target/credentials and wider policy are refused", async () => {
    await expect(
      pollReleaseHealth({ ...input, fetchImpl: async () => new Response("x".repeat(65537)) }),
    ).rejects.toThrow("health_response_invalid");
    await expect(
      pollReleaseHealth({ ...input, fetchImpl: async () => ({ status: 200, redirected: true }) }),
    ).rejects.toThrow("health_http_rejected");
    for (const change of [
      { expectedSha: "main" },
      { expectedSha: [sha] },
      { expectedMigration: "../migration.sql" },
      { clientSecret: "" },
      { url: "https://synthetic.test/login" },
      { url: "not a URL" },
      { policy: { maxAttempts: 7 } },
      { policy: { constructor: 1 } },
      { policy: { totalMs: 205001 } },
    ])
      await expect(pollReleaseHealth({ ...input, ...change })).rejects.toThrow(/^health_[a-z_]+$/u);
    expect(assessReleaseHealth(healthy(), sha, migration)).toBe("ready");
  });
});
