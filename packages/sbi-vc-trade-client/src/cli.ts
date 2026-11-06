import { runCli } from "./run-cli";

process.exitCode = await runCli(Bun.argv.slice(2));
