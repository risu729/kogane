import { probePublicLogin } from "./probe.mjs";

if (process.argv.length > 2) {
  console.error("This public GET probe accepts no arguments or authentication input.");
  process.exitCode = 2;
} else {
  console.log(JSON.stringify(await probePublicLogin(), null, 2));
}
