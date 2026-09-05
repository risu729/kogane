import { collectMoneyForward } from "../src/moneyforward";
import { parseCredential } from "../src/webauthn";
import { safeFailure } from "../src/diagnostics";

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
    ...safeFailure(error),
  }));
  process.exitCode = 1;
}
