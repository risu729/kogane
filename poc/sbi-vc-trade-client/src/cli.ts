import { chmod, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { collectSbiVcTrade } from "./collect";
import { SbiVcTradeClient } from "./client";
import { readSessionFile } from "./session";

const args = parseArgs(Bun.argv.slice(2));
const session = await readSessionFile(args.sessionFile);
const output = resolve(args.output);
await mkdir(output, { recursive: true, mode: 0o700 });
await chmod(output, 0o700);

const artifacts = await collectSbiVcTrade(new SbiVcTradeClient(session));
for (const artifact of artifacts) {
  const path = resolve(output, artifact.name);
  await Bun.write(path, JSON.stringify(artifact.response));
  await chmod(path, 0o600);
}
console.log(JSON.stringify({ status: "success", artifactCount: artifacts.length }));

interface Args {
  sessionFile: string;
  output: string;
}

function parseArgs(values: string[]): Args {
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
