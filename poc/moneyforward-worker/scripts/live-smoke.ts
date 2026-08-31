import { collectMoneyForward } from "../src/moneyforward";
import { parseCredential } from "../src/webauthn";

const input = await Bun.stdin.text();
const startedAt = new Date().toISOString();
try {
  const result = await collectMoneyForward({ credential: parseCredential(input) });
  console.log(JSON.stringify({
    ok: true,
    startedAt,
    completedAt: new Date().toISOString(),
    accountDetailCount: result.accountDetailCount,
    monthlyFragmentCount: result.monthlyFragmentCount,
    artifactCount: result.artifacts.length,
    artifactDatasets: result.artifacts.map(({ dataset }) => dataset),
  }));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    startedAt,
    completedAt: new Date().toISOString(),
    errorType: error instanceof Error ? error.name : "UnknownError",
    message: error instanceof Error ? redact(error.message) : "Unknown error",
  }));
  process.exitCode = 1;
}

function redact(value: string): string {
  return value
    .replace(/Bearer\s+[^\s,;]+/giu, "Bearer [redacted]")
    .replace(/(cookie|csrf|token|challenge|credential)=?[^\s,;]+/giu, "$1=[redacted]")
    .slice(0, 2000);
}
