import { writeArtifacts } from "./artifacts";
import { collectSbiVcTrade } from "./collect";
import { GatewayError, SbiVcTradeClient } from "./client";
import { readSessionFile } from "./session";

interface Args {
  sessionFile: string;
  output: string;
}

export interface CliDependencies {
  readSessionFile: typeof readSessionFile;
  createClient: (session: Awaited<ReturnType<typeof readSessionFile>>) => SbiVcTradeClient;
  writeArtifacts: typeof writeArtifacts;
  /** One JSON line on stdout (success) or stderr (failure). */
  log: (line: string) => void;
  logError: (line: string) => void;
}

const DEFAULTS: CliDependencies = {
  readSessionFile,
  createClient: (session) => new SbiVcTradeClient(session),
  writeArtifacts,
  log: (line) => console.log(line),
  logError: (line) => console.error(line),
};

const ERROR_TYPES = new Set(["Error", "TypeError", "SyntaxError", "RangeError", "GatewayError"]);

/**
 * Runs the local read-only collection. Its output is one JSON line of counts
 * and closed codes: an exception's message is never printed, because a
 * gateway error carries what the provider said (`GatewayError` names the
 * gateway's status) and the output is not the place to learn it. Returns the
 * process exit code.
 */
export async function runCli(
  argv: readonly string[],
  overrides: Partial<CliDependencies> = {},
): Promise<number> {
  const deps = { ...DEFAULTS, ...overrides };
  let stage: "arguments" | "session" | "collection" | "output" = "arguments";
  try {
    const args = parseArgs(argv);
    stage = "session";
    const session = await deps.readSessionFile(args.sessionFile);
    stage = "collection";
    const artifacts = await collectSbiVcTrade(deps.createClient(session));
    stage = "output";
    await deps.writeArtifacts(args.output, artifacts);
    deps.log(JSON.stringify({ status: "success", artifactCount: artifacts.length }));
    return 0;
  } catch (error) {
    deps.logError(JSON.stringify({ status: "failed", stage, ...safeFailure(error) }));
    return 1;
  }
}

function safeFailure(error: unknown): { errorType: string; httpStatus?: number } {
  const name = error instanceof Error ? error.name : "UnknownError";
  const status = error instanceof GatewayError ? error.httpStatus : undefined;
  return {
    errorType: ERROR_TYPES.has(name) ? name : "UnknownError",
    ...(typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
      ? { httpStatus: status }
      : {}),
  };
}

function parseArgs(values: readonly string[]): Args {
  const result: Partial<Args> = {};
  for (let index = 0; index < values.length; index += 1) {
    const key = values[index];
    const value = values[index + 1];
    if (!value) throw new Error(`missing value for ${key}`);
    if (key === "--session-file") result.sessionFile = value;
    else if (key === "--output") result.output = value;
    else throw new Error(`unknown argument: ${key}`);
    index += 1;
  }
  if (!result.sessionFile || !result.output) {
    throw new Error("usage: --session-file PATH --output DIR");
  }
  return result as Args;
}
