import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

// Execute the installed pinned SDK methods, with fake allocation/port I/O only.
// This reproduces callback semantics; it does not claim Cloudflare runtime success.
test("pinned SDK 0.3.7 shares allocation but invokes readiness callback for both concurrent callers", () => {
  const workspace = new URL("../", import.meta.url);
  const manifest = JSON.parse(
    readFileSync(
      new URL("../node_modules/@cloudflare/containers/package.json", import.meta.url),
      "utf8",
    ),
  );
  expect(manifest.version).toBe("0.3.7");
  const stdout = execFileSync(
    "bun",
    [
      "-e",
      `
    const { mock } = await import("bun:test");
    mock.module("cloudflare:workers",()=>({DurableObject:class {},WorkerEntrypoint:class {}}));
    const { Container } = await import("@cloudflare/containers");
    let physicalStartCalls=0, readinessCallbacks=0;
    let release;
    const allocation=new Promise(done=>{release=done});
    const state={
      container:{running:false},state:{setHealthy:async()=>{}},
      ctx:{blockConcurrencyWhile:async callback=>callback()},
      getPortsToCheck:async()=>[8080],syncPendingStoppedEvents:async()=>{},
      startContainerIfNotRunning:Container.prototype.startContainerIfNotRunning,
      doStartContainer:async()=>{physicalStartCalls++;await allocation;return 0},
      waitForPort:async()=>0,setupMonitorCallbacks:()=>{},
      onStart:async()=>{readinessCallbacks++},
    };
    const first=Container.prototype.startAndWaitForPorts.call(state);
    const second=Container.prototype.startAndWaitForPorts.call(state);
    await new Promise(done=>setTimeout(done,10));
    release();
    await Promise.all([first,second]);
    process.stdout.write(JSON.stringify({physicalStartCalls,readinessCallbacks}));
  `,
    ],
    { cwd: workspace, encoding: "utf8", timeout: 10_000 },
  );
  expect(JSON.parse(stdout)).toEqual({ physicalStartCalls: 1, readinessCallbacks: 2 });
});
