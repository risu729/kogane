import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { SessionMaterial } from "./types";

export async function readSessionFile(path: string): Promise<SessionMaterial> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error("session path must be a regular file");
    }
    if ((metadata.mode & 0o077) !== 0) {
      throw new Error("session file must not be accessible by group or others (chmod 600)");
    }
    const parsed = JSON.parse(await handle.readFile("utf8")) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("cookieHeader" in parsed) ||
      !("secureKey" in parsed) ||
      typeof parsed.cookieHeader !== "string" ||
      typeof parsed.secureKey !== "string"
    ) {
      throw new Error("session file must contain cookieHeader and secureKey strings");
    }
    return { cookieHeader: parsed.cookieHeader, secureKey: parsed.secureKey };
  } finally {
    await handle.close();
  }
}
