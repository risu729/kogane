import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const root = fileURLToPath(new URL("../../../", import.meta.url));
export const CHROME_SERVICES = ["collector-globalpass", "collector-sbi-shinsei"];
export async function syncChrome({ write = false } = {}) {
  for (const [source, target] of [
    ["manifest.json", "chrome-manifest.json"],
    ["chrome-install.mjs", "chrome-install.mjs"],
  ]) {
    const canonical = await readFile(new URL(source, import.meta.url));
    for (const service of CHROME_SERVICES) {
      const path = resolve(root, "services", service, "container", target);
      if (write) await writeFile(path, canonical);
      else if (!canonical.equals(await readFile(path)))
        throw new Error(`pinned_chrome_copy_mismatch:${service}:${target}`);
    }
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some((arg) => arg !== "--write"))
    throw new Error("pinned_chrome_sync_command");
  await syncChrome({ write: process.argv.includes("--write") });
}
