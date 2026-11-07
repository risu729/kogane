import { describe, expect, test } from "bun:test";
import { SbiVcTradeClient } from "../src/client";
import { runCli, type CliDependencies } from "../src/run-cli";

// Synthetic values only; the marker stands in for whatever the gateway says.
const MARKER = "PRIVATE_GATEWAY_STATUS_MARKER_51c2";
const session = {
  cookies: {
    vctBffSid: "synthetic-vct",
    jSessionId: "synthetic-jsession",
    awsAlbApp: ["synthetic-0", "synthetic-1", "synthetic-2", "synthetic-3"] as [
      string,
      string,
      string,
      string,
    ],
    awsAlb: "synthetic-alb",
    awsAlbCors: "synthetic-alb-cors",
  },
  secureKey: "synthetic-key",
};
const ARGS = ["--session-file", "/synthetic/session.json", "--output", "/synthetic/out"];

function harness(gateway: () => Response) {
  const out: string[] = [];
  const err: string[] = [];
  let written = 0;
  const deps: Partial<CliDependencies> = {
    readSessionFile: async () => session,
    createClient: (material) => new SbiVcTradeClient(material, async () => gateway()),
    writeArtifacts: async (_dir, artifacts) => {
      written = artifacts.length;
    },
    log: (line) => out.push(line),
    logError: (line) => err.push(line),
  };
  return { deps, out, err, written: () => written };
}

describe("local CLI output", () => {
  test("a rejected gateway status reaches neither output stream", async () => {
    const run = harness(() => Response.json({ meta: { status: MARKER }, body: {} }));
    expect(await runCli(ARGS, run.deps)).toBe(1);
    expect(run.out).toEqual([]);
    expect(run.err.map((line) => JSON.parse(line))).toEqual([
      { status: "failed", stage: "collection", errorType: "GatewayError", httpStatus: 200 },
    ]);
    expect([...run.out, ...run.err].join("\n")).not.toContain(MARKER);
  });

  test("an HTML error page's text is not printed", async () => {
    const run = harness(
      () =>
        new Response(`<html>${MARKER}</html>`, {
          status: 503,
          headers: { "content-type": "text/html" },
        }),
    );
    expect(await runCli(ARGS, run.deps)).toBe(1);
    expect(JSON.parse(run.err[0]!)).toEqual({
      status: "failed",
      stage: "collection",
      errorType: "GatewayError",
      httpStatus: 503,
    });
    expect(run.err.join("\n")).not.toContain(MARKER);
  });

  test("an argument error names the stage, not the argument", async () => {
    const run = harness(() => Response.json({ meta: { status: "OK" }, body: {} }));
    expect(await runCli(["--unknown", MARKER], run.deps)).toBe(1);
    expect(JSON.parse(run.err[0]!)).toEqual({
      status: "failed",
      stage: "arguments",
      errorType: "Error",
    });
    expect(run.err.join("\n")).not.toContain(MARKER);
  });

  test("a successful run prints counts only", async () => {
    const run = harness(() =>
      Response.json({ meta: { status: "OK" }, body: { list: [], totalSize: 0 } }),
    );
    expect(await runCli(ARGS, run.deps)).toBe(0);
    expect(run.err).toEqual([]);
    expect(run.out.map((line) => JSON.parse(line))).toEqual([
      { status: "success", artifactCount: run.written() },
    ]);
  });
});
