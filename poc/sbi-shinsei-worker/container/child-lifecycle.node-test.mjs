import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { observeChildProcess } from "./child-lifecycle.mjs";

async function withLogs(action) {
  const records = [];
  const previous = { log: console.log, error: console.error };
  console.log = console.error = (value) => records.push(JSON.parse(value));
  try {
    await action(records);
  } finally {
    Object.assign(console, previous);
  }
}
const closed = (child) => new Promise((resolve) => child.once("close", resolve));

test("missing binary is owned without an unhandled event and fails the startup check", async () => {
  await withLogs(async (records) => {
    const child = spawn("kogane-synthetic-missing-executable", [], {
      stdio: "ignore",
      windowsHide: true,
    });
    const lifecycle = observeChildProcess(child, "chrome", {
      relayUrl:
        "wss://example.invalid/tcp?token=synthetic-private&runId=00000000-0000-4000-8000-000000000001",
    });
    await closed(child);
    assert.equal(lifecycle.isStopped(), true);
    assert.throws(() => lifecycle.assertRunning(), /child_process_unavailable/u);
    assert.ok(
      records.some(
        (record) =>
          record.child === "chrome" && record.errorCode === "ENOENT" && record.outcome === "failed",
      ),
    );
    assert.ok(records.every((record) => record.runId === "00000000-0000-4000-8000-000000000001"));
    assert.doesNotMatch(
      JSON.stringify(records),
      /synthetic-private|missing-executable|wss:|stack/u,
    );
  });
});

test("early nonzero child exit fails startup and logs only bounded exit data", async () => {
  await withLogs(async (records) => {
    const child = spawn(process.execPath, ["-e", "process.exit(23)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const lifecycle = observeChildProcess(child, "xvfb");
    await closed(child);
    assert.throws(() => lifecycle.assertRunning(), /child_process_unavailable/u);
    assert.ok(
      records.some(
        (record) =>
          record.child === "xvfb" && record.exitCode === 23 && record.outcome === "failed",
      ),
    );
  });
});

test("expected stop is separate from an early exit", async () => {
  await withLogs(async (records) => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    const lifecycle = observeChildProcess(child, "chrome");
    lifecycle.stopping();
    child.kill("SIGTERM");
    await closed(child);
    assert.ok(
      records.some((record) => record.outcome === "stopped" && record.phase === "teardown"),
    );
    assert.equal(
      records.some((record) => record.outcome === "failed"),
      false,
    );
  });
});

test("throwing logger and error getter cannot release error ownership", () => {
  const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null });
  const lifecycle = observeChildProcess(child, "chrome");
  const previous = console.error;
  console.error = () => {
    throw new Error("synthetic-private");
  };
  try {
    child.emit("error", {
      get code() {
        throw new Error("synthetic-private");
      },
    });
    child.emit("error", { code: "synthetic-private" });
    assert.throws(() => lifecycle.assertRunning(), /child_process_unavailable/u);
  } finally {
    console.error = previous;
  }
});
