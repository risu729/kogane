import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { collectMoneyForward } from "../src/moneyforward";
import { parseCredential } from "../src/webauthn";

const bwCli = process.env.BW_CLI ?? "/home/risu/.local/share/mise/installs/bitwarden/2026.8.0/bw";
const session = process.env.BW_SESSION;
const outputPath = process.argv[2] ?? "/home/risu/.local/state/kogane/moneyforward-bitwarden-match.json";
if (!session) throw new Error("BW_SESSION is required");

const child = Bun.spawn([bwCli, "list", "items", "--session", session], {
  stdout: "pipe",
  stderr: "pipe",
  env: process.env,
});
const [stdout, stderr, exitCode] = await Promise.all([
  new Response(child.stdout).text(),
  new Response(child.stderr).text(),
  child.exited,
]);
if (exitCode !== 0) {
  throw new Error(`Bitwarden item listing failed: ${stderr.slice(0, 200)}`);
}
const items: unknown = JSON.parse(stdout);
if (!Array.isArray(items)) throw new Error("Bitwarden item listing is invalid");

const candidates: Array<{
  itemId: string;
  credentialIndex: number;
  credential: Record<string, unknown>;
}> = [];
for (const rawItem of items) {
  if (!rawItem || typeof rawItem !== "object" || Array.isArray(rawItem)) continue;
  const item = rawItem as Record<string, unknown>;
  const login = item["login"];
  if (!login || typeof login !== "object" || Array.isArray(login)) continue;
  const credentials = (login as Record<string, unknown>)["fido2Credentials"];
  if (!Array.isArray(credentials)) continue;
  for (const [credentialIndex, rawCredential] of credentials.entries()) {
    if (!rawCredential || typeof rawCredential !== "object" || Array.isArray(rawCredential)) continue;
    const credential = rawCredential as Record<string, unknown>;
    if (credential["rpId"] !== "id.moneyforward.com") continue;
    if (typeof item["id"] !== "string") continue;
    candidates.push({ itemId: item["id"], credentialIndex, credential });
  }
}

const matches: Array<{ itemId: string; credentialIndex: number }> = [];
const outcomes = [];
for (const [candidateIndex, candidate] of candidates.entries()) {
  try {
    const credential = parseCredential(JSON.stringify({
      ...candidate.credential,
      origin: "https://id.moneyforward.com",
    }));
    const collection = await collectMoneyForward({ credential });
    const matchesMeAccount = collection.accountDetailCount > 0;
    outcomes.push({
      candidate: candidateIndex + 1,
      matchesMeAccount,
      accountDetailCount: collection.accountDetailCount,
    });
    if (matchesMeAccount) {
      matches.push({
        itemId: candidate.itemId,
        credentialIndex: candidate.credentialIndex,
      });
    }
  } catch (error) {
    outcomes.push({
      candidate: candidateIndex + 1,
      matchesMeAccount: false,
      errorType: error instanceof Error ? error.name : "UnknownError",
    });
  }
}
if (matches.length !== 1) {
  console.error(JSON.stringify({ candidateCount: candidates.length, matchCount: matches.length, outcomes }));
  throw new Error("Expected exactly one Bitwarden passkey linked to the active Money Forward ME account");
}
await mkdir(dirname(outputPath), { recursive: true, mode: 0o700 });
await writeFile(outputPath, `${JSON.stringify(matches[0])}\n`, { mode: 0o600 });
await chmod(outputPath, 0o600);
console.log(JSON.stringify({
  candidateCount: candidates.length,
  matchCount: matches.length,
  outcomes,
  matchMetadataSaved: true,
}));
