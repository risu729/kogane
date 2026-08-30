import { collectSonyBank, parseCredential } from "../src/sony-bank";

const rawCredential = process.env.SONY_BANK_CREDENTIAL_FILE
  ? await Bun.file(process.env.SONY_BANK_CREDENTIAL_FILE).text()
  : process.env.SONY_BANK_CREDENTIAL_JSON;
if (!rawCredential) throw new Error("SONY_BANK_CREDENTIAL_JSON is missing");

const from = process.argv[2] ?? new Date().toISOString().slice(0, 8) + "01";
const to = process.argv[3] ?? new Date().toISOString().slice(0, 10);
const result = await collectSonyBank({
  credential: parseCredential(rawCredential),
  from,
  to,
});
const wallet = result.artifacts.filter((artifact) =>
  artifact.dataset.startsWith("wallet-history-"),
);
const foreign = result.artifacts.filter((artifact) =>
  artifact.dataset.startsWith("foreign-history-"),
);
const unsafeWallet = wallet.filter(
  (artifact) =>
    typeof artifact.body === "string" &&
    (/;jsessionid=/iu.test(artifact.body) ||
      /<input\b[^>]*\btype=["']hidden["'][^>]*\bvalue=["'][^"']+/iu.test(
        artifact.body,
      )),
);

console.log(JSON.stringify({
  window: { from, to },
  artifactCount: result.artifacts.length,
  yenTransactionCount: result.transactionCount,
  foreignArtifactCount: foreign.length,
  walletMonthCount: wallet.length,
  unsafeWalletArtifactCount: unsafeWallet.length,
}));
