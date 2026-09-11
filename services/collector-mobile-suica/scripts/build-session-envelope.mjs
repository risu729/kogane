import { chmod, readFile, writeFile } from "node:fs/promises";

const [captureDir, outputPath] = process.argv.slice(2);
if (!captureDir || !outputPath) {
  throw new Error("usage: node build-session-envelope.mjs <capture-dir> <output-json>");
}

const lines = (await readFile(`${captureDir}/metadata.ndjson`, "utf8")).split(/\r?\n/u);
let captured;
for (const line of lines) {
  if (!line) continue;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    continue;
  }
  let url;
  try {
    url = new URL(entry.url);
  } catch {
    continue;
  }
  if (
    url.hostname === "www.mobilesuica.com" &&
    url.pathname === "/iq/ir/SuicaDisp.aspx" &&
    entry.requestMethod === "POST" &&
    entry.requestBodySaved &&
    entry.requestBodyFile &&
    entry.rawRequestHeaders?.Cookie
  ) {
    captured = entry;
  }
}
if (!captured) throw new Error("captured Mobile Suica history POST was not found");

const requestBodyFile = captured.requestBodyFile.replaceAll("\\", "/");
const formBody = await readFile(`${captureDir}/${requestBodyFile}`, "utf8");
const envelope = {
  capturedAt: captureTimestamp(captured.requestBodyFile),
  cookieHeader: captured.rawRequestHeaders.Cookie,
  formBody,
  userAgent: captured.rawRequestHeaders["User-Agent"],
};
await writeFile(outputPath, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
await chmod(outputPath, 0o600);

const cookieNames = envelope.cookieHeader
  .split(";")
  .map((part) => part.split("=", 1)[0]?.trim())
  .filter(Boolean)
  .sort();
console.log(JSON.stringify({ outputPath, capturedAt: envelope.capturedAt, cookieNames }));

function captureTimestamp(path) {
  const name = path.replaceAll("\\", "/").split("/").at(-1) ?? "";
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3})Z/u.exec(name);
  return match
    ? `${match[1].replace(/T(\d{2})-(\d{2})-(\d{2})-(\d{3})$/u, "T$1:$2:$3.$4")}Z`
    : undefined;
}
