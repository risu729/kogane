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
    if (!isSessionMaterial(parsed)) {
      throw new Error("session file must contain the eight observed session cookies and secureKey");
    }
    return parsed;
  } finally {
    await handle.close();
  }
}

function isSessionMaterial(value: unknown): value is SessionMaterial {
  if (!isRecord(value) || typeof value.secureKey !== "string" || !isRecord(value.cookies)) {
    return false;
  }
  const cookies = value.cookies;
  return typeof cookies.vctBffSid === "string" &&
    typeof cookies.jSessionId === "string" &&
    typeof cookies.awsAlb === "string" &&
    typeof cookies.awsAlbCors === "string" &&
    Array.isArray(cookies.awsAlbApp) &&
    cookies.awsAlbApp.length === 4 &&
    cookies.awsAlbApp.every((part) => typeof part === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
