import { fileURLToPath } from "node:url";
import { JscAcquisitionError } from "../errors";
import type { JscMaterial, JscProvider } from "../types";

const EXPECTED_ORIGIN = "https://bk.web.sbishinseibank.co.jp" as const;
const MAX_HELPER_OUTPUT_BYTES = 32 * 1024;

export class WindowsChromeCdpJscProvider implements JscProvider {
  readonly name = "windows-chrome-cdp";

  async acquire(): Promise<JscMaterial> {
    if (process.platform !== "linux" || !process.env.WSL_DISTRO_NAME) {
      throw new JscAcquisitionError(
        "Windows Chrome CDP handoff requires WSL",
      );
    }
    const scriptPath = fileURLToPath(
      new URL("../../scripts/windows-cdp-jsc.ps1", import.meta.url),
    );
    const converted = Bun.spawnSync(["wslpath", "-w", scriptPath], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (converted.exitCode !== 0) {
      throw new JscAcquisitionError("Could not resolve the CDP helper path");
    }
    const windowsScriptPath = converted.stdout.toString().trim();
    if (!windowsScriptPath) {
      throw new JscAcquisitionError("CDP helper path was empty");
    }

    const child = Bun.spawn([
      "powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-File",
      windowsScriptPath,
    ], {
      stdout: "pipe",
      stderr: "pipe",
      env: process.env,
    });
    const timeout = setTimeout(() => child.kill(), 55_000);
    try {
      const [exitCode, stdout] = await Promise.all([
        child.exited,
        new Response(child.stdout).arrayBuffer(),
        new Response(child.stderr).arrayBuffer(),
      ]).then(([code, output]) => [code, new Uint8Array(output)] as const);
      if (exitCode !== 0) {
        throw new JscAcquisitionError(
          `Chrome CDP helper failed with exit code ${exitCode}`,
        );
      }
      if (stdout.byteLength === 0 || stdout.byteLength > MAX_HELPER_OUTPUT_BYTES) {
        throw new JscAcquisitionError("Chrome CDP helper output was invalid");
      }
      return parseMaterial(new TextDecoder().decode(stdout));
    } finally {
      clearTimeout(timeout);
    }
  }
}

export class PureHttpJscProvider implements JscProvider {
  readonly name = "pure-http-unavailable";

  async acquire(): Promise<JscMaterial> {
    throw new JscAcquisitionError(
      "Pure HTTP CAFIS generation is not validated; use the normal Chrome provider",
    );
  }
}

function parseMaterial(value: string): JscMaterial {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new JscAcquisitionError("Chrome CDP helper returned invalid JSON");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new JscAcquisitionError("Chrome CDP helper returned an invalid shape");
  }
  const record = parsed as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !== "jsc,sourceOrigin,userAgent" ||
    record.sourceOrigin !== EXPECTED_ORIGIN ||
    typeof record.jsc !== "string" ||
    record.jsc.length < 64 ||
    record.jsc.length > 16_384 ||
    typeof record.userAgent !== "string" ||
    record.userAgent.length < 20 ||
    record.userAgent.length > 1_024
  ) {
    throw new JscAcquisitionError("Chrome CDP helper returned invalid material");
  }
  return {
    sourceOrigin: EXPECTED_ORIGIN,
    jsc: record.jsc,
    userAgent: record.userAgent,
  };
}
