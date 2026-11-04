import { describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { BOOTSTRAP_POLICY, bootstrapReleaseSchedules } from "./ci/alarm-bootstrap.mjs";
import { REPO_ROOT } from "./repo-root.ts";

const sha = "a".repeat(40),
  old = "b".repeat(40);
const input = {
  url: "http://127.0.0.1/api/ops/v1/schedules/bootstrap",
  expectedSha: sha,
  jobs: [{ id: "synthetic-armed" }, { id: "synthetic-disabled" }],
  clientId: "synthetic-client",
  clientSecret: "synthetic-private",
};
const short = { totalMs: 1000, delayMs: 1 };
const armed = () => ({
  status: "armed",
  releaseSha: sha,
  processorReleaseSha: sha,
  reservations: [
    {
      id: "synthetic-armed",
      enabled: true,
      actualAlarmAt: new Date(Date.now() + 1800000).toISOString(),
    },
    { id: "synthetic-disabled", enabled: false, actualAlarmAt: null },
  ],
});
async function withServer(handler: any, run: any) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address() as { port: number };
    return await run(`http://127.0.0.1:${address.port}/api/ops/v1/schedules/bootstrap`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("bootstrap retries only proved prewrite release mismatch", () => {
  test("120-second total is unchanged and trusted workflow pins immutable target", () => {
    expect(BOOTSTRAP_POLICY).toEqual({ totalMs: 120000, maxAttempts: 6, delayMs: 5000 });
    const workflow = readFileSync(`${REPO_ROOT}/.github/workflows/_deploy-workers.yml`, "utf8");
    const step = workflow.slice(
      workflow.indexOf("      - name: Reconcile future schedule alarms"),
      workflow.indexOf("      - name: Record what this run deployed"),
    );
    expect(step).toContain('release) node "${ALARM_BOOTSTRAP}" ;;');
    expect(step).toContain("rollback) mise run --no-deps automation:alarm-bootstrap ;;");
    expect(step).toContain("MODE: ${{ inputs.mode }}");
    expect(step).toContain("SHA: ${{ inputs.sha }}");
    expect(step).not.toContain("curl");
    expect(
      workflow.indexOf("tasks/_lib/ci/alarm-bootstrap.mjs tasks/_lib/ci/alarm-cron-readback.mjs"),
    ).toBeLessThan(workflow.indexOf("      - name: Checkout the exact commit"));
  });
  test("real authenticated prewrite 503 -> target armed performs exactly one mutation", async () => {
    let reads = 0,
      writes = 0;
    await withServer(
      (request: any, response: any) => {
        reads++;
        expect(request.method).toBe("POST");
        expect(request.headers["x-kogane-release-sha"]).toBe(sha);
        expect(request.headers["cf-access-client-id"] === input.clientId).toBe(true);
        expect(request.headers["cf-access-client-secret"] === input.clientSecret).toBe(true);
        expect(request.headers["content-length"] ?? "0").toBe("0");
        if (reads === 1) {
          response.statusCode = 503;
          response.end(
            '{"error":"release_mismatch","requestId":"00000000-0000-4000-8000-000000000001"}',
          );
        } else {
          writes++;
          response.end(JSON.stringify(armed()));
        }
      },
      async (url: string) => {
        const proof = await bootstrapReleaseSchedules({ ...input, url, policy: short });
        expect(proof).toMatchObject({
          status: "verified",
          releaseSha: sha,
          attempts: 2,
          armed: 1,
          disabled: 1,
        });
        expect(JSON.stringify(proof)).not.toContain(input.clientSecret);
      },
    );
    expect(reads).toBe(2);
    expect(writes).toBe(1);
  });
  test("six exact prewrite refusals exhaust the cap", async () => {
    let posts = 0;
    await withServer(
      (_request: any, response: any) => {
        posts++;
        response.statusCode = 503;
        response.end('{"error":"release_mismatch"}');
      },
      async (url: string) => {
        await expect(bootstrapReleaseSchedules({ ...input, url, policy: short })).rejects.toThrow(
          "schedule_bootstrap_release_mismatch",
        );
      },
    );
    expect(posts).toBe(6);
  });
  test("auth/redirect/generic503/malformed and invalid200 are never replayed", async () => {
    for (const [status, body] of [
      [302, ""],
      [401, ""],
      [403, ""],
      [429, ""],
      [500, ""],
      [503, '{"error":"scheduling_unavailable"}'],
      [503, '{"error":"release_mismatch","extra":true}'],
      [503, '{"error":"release_mismatch","requestId":"bad"}'],
      [503, '{"error":"release_mismatch","requestId":null}'],
      [503, '{"error":"release_mismatch","requestId":42}'],
      [503, '{"error":"release_mismatch","requestId":"00000000-0000-1000-8000-000000000001"}'],
      [503, '{"error":"release_mismatch","requestId":"00000000-0000-4000-7000-000000000001"}'],
      [
        503,
        '{"error":"release_mismatch","requestId":"00000000-0000-4000-8000-000000000001","refs":[]}',
      ],
      [503, '{"error":"release_mismatch"} {}'],
      [503, "<html>login</html>"],
      [503, "null"],
      [200, "<html>login</html>"],
      [200, '{"status":"armed","reservations":[]}'],
      [200, JSON.stringify({ ...armed(), releaseSha: old, processorReleaseSha: old })],
      [200, JSON.stringify({ ...armed(), processorReleaseSha: old })],
      [200, JSON.stringify({ ...armed(), processorReleaseSha: undefined })],
    ] as const) {
      let posts = 0;
      await withServer(
        (_request: any, response: any) => {
          posts++;
          response.statusCode = status;
          if (status === 302) response.setHeader("location", "/login");
          response.end(body);
        },
        async (url: string) => {
          await expect(bootstrapReleaseSchedules({ ...input, url, policy: short })).rejects.toThrow(
            /^schedule_bootstrap_[a-z_]+$/u,
          );
        },
      );
      expect(posts).toBe(1);
    }
  });
  test("real network failure and total body/header deadline never replay uncertain POST", async () => {
    for (const mode of ["network", "body", "headers"]) {
      let posts = 0,
        accepted = false;
      await withServer(
        (request: any, response: any) => {
          posts++;
          if (mode === "network") {
            request.socket.destroy();
            return;
          }
          if (mode === "body") {
            response.writeHead(200);
            response.write("{");
          }
          setTimeout(() => {
            if (!response.destroyed) response.end(JSON.stringify(armed()));
          }, 150);
        },
        async (url: string) => {
          await expect(
            bootstrapReleaseSchedules({ ...input, url, policy: { totalMs: 60, delayMs: 1 } }).then(
              () => {
                accepted = true;
              },
            ),
          ).rejects.toThrow(
            mode === "network"
              ? "schedule_bootstrap_uncertain"
              : "schedule_bootstrap_deadline_exceeded",
          );
          await new Promise((resolve) => setTimeout(resolve, 170));
          expect(accepted).toBe(false);
        },
      );
      expect(posts).toBe(1);
    }
  });
  test("backoff and final acceptance share original deadline; expected target cannot change", async () => {
    let posts = 0;
    await expect(
      bootstrapReleaseSchedules({
        ...input,
        policy: { totalMs: 30, delayMs: 100 },
        fetchImpl: async () => {
          posts++;
          return Response.json({ error: "release_mismatch" }, { status: 503 });
        },
      }),
    ).rejects.toThrow("schedule_bootstrap_deadline_exceeded");
    expect(posts).toBe(1);
    const parameters: any = {
      ...input,
      policy: short,
      fetchImpl: async (_url: string, options: any) => {
        parameters.expectedSha = old;
        expect(options.headers["x-kogane-release-sha"]).toBe(sha);
        return Response.json({ ...armed(), releaseSha: old, processorReleaseSha: old });
      },
    };
    await expect(bootstrapReleaseSchedules(parameters)).rejects.toThrow(
      "schedule_bootstrap_release_unverified",
    );
    let clock = 0;
    await expect(
      bootstrapReleaseSchedules({
        ...input,
        now: () => clock,
        policy: short,
        fetchImpl: async () => {
          clock = 1000;
          return Response.json(armed());
        },
      }),
    ).rejects.toThrow("schedule_bootstrap_deadline_exceeded");
  });
  test("bounded UTF8/schema, reservation guards and wider budget all refuse without retry", async () => {
    const responseFactories = [
      () => new Response("x".repeat(65537)),
      () => new Response(new Uint8Array([0xff])),
      () =>
        Response.json({
          ...armed(),
          reservations: [armed().reservations[0], armed().reservations[0]],
        }),
      () =>
        Response.json({
          ...armed(),
          reservations: [
            { id: "synthetic-armed", enabled: true, actualAlarmAt: null },
            armed().reservations[1],
          ],
        }),
      () =>
        Response.json({
          ...armed(),
          reservations: [
            armed().reservations[0],
            { id: "synthetic-disabled", enabled: false, actualAlarmAt: new Date().toISOString() },
          ],
        }),
    ];
    for (const makeResponse of responseFactories) {
      let posts = 0;
      await expect(
        bootstrapReleaseSchedules({
          ...input,
          policy: short,
          fetchImpl: async () => {
            posts++;
            return makeResponse();
          },
        }),
      ).rejects.toThrow(/^schedule_bootstrap_[a-z_]+$/u);
      expect(posts).toBe(1);
    }
    for (const change of [
      { expectedSha: "main" },
      { expectedSha: [sha] },
      { clientSecret: "" },
      { policy: { totalMs: 120001 } },
      { policy: { maxAttempts: 7 } },
      { url: "https://synthetic.test/login" },
      { jobs: [input.jobs[0], input.jobs[0]] },
    ])
      await expect(bootstrapReleaseSchedules({ ...input, ...change })).rejects.toThrow(
        /^schedule_bootstrap_[a-z_]+$/u,
      );
  });
  test("native Node real HTTP proves prewrite recovery and rejects uncertain replay", async () => {
    const helper = pathToFileURL(`${REPO_ROOT}/tasks/_lib/ci/alarm-bootstrap.mjs`).href;
    const script = `
      import { createServer } from "node:http";
      import assert from "node:assert/strict";
      import { bootstrapReleaseSchedules } from ${JSON.stringify(helper)};
      const input = ${JSON.stringify(input)}, armed = ${JSON.stringify(armed())};
      let posts = 0, writes = 0, mode = "recover";
      const server = createServer((request, response) => {
        posts++; assert.equal(request.method, "POST");
        assert.equal(request.headers["x-kogane-release-sha"], input.expectedSha);
        if (mode === "network") { request.socket.destroy(); return; }
        if (mode === "body") { response.writeHead(200); response.write("{"); return; }
        if (mode === "recover" && posts === 1) {
          response.writeHead(503); response.end('{"error":"release_mismatch","requestId":"00000000-0000-4000-8000-000000000001"}'); return;
        }
        writes++; response.end(JSON.stringify(mode === "old200" ? { ...armed, releaseSha: "b".repeat(40) } : armed));
      });
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      const url = "http://127.0.0.1:" + server.address().port + "/api/ops/v1/schedules/bootstrap";
      try {
        const policy = { totalMs: 2000, delayMs: 1 };
        assert.equal((await bootstrapReleaseSchedules({ ...input, url, policy })).attempts, 2);
        assert.equal(posts, 2); assert.equal(writes, 1);
        mode = "old200"; posts = 0;
        await assert.rejects(bootstrapReleaseSchedules({ ...input, url, policy }), /schedule_bootstrap_release_unverified/);
        assert.equal(posts, 1);
        mode = "network"; posts = 0;
        await assert.rejects(bootstrapReleaseSchedules({ ...input, url, policy }), /schedule_bootstrap_uncertain/);
        assert.equal(posts, 1);
        mode = "body"; posts = 0;
        await assert.rejects(bootstrapReleaseSchedules({ ...input, url,
          policy: { totalMs: 60, delayMs: 1 } }), /schedule_bootstrap_deadline_exceeded/);
        assert.equal(posts, 1);
        console.log("native_node_bootstrap_checks_passed");
      } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
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
    expect(result.stdout.trim()).toBe("native_node_bootstrap_checks_passed");
  });
});
