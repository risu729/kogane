import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readSessionFile } from "../src/session";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("SBI VC Trade session file", () => {
  test("reads permission-checked data from one open descriptor", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "session.json");
    await writeFile(path, JSON.stringify({
      cookieHeader: "session=synthetic",
      secureKey: "synthetic-key",
    }), { mode: 0o600 });

    expect(await readSessionFile(path)).toEqual({
      cookieHeader: "session=synthetic",
      secureKey: "synthetic-key",
    });
  });

  test("rejects group-readable files", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "session.json");
    await writeFile(path, JSON.stringify({
      cookieHeader: "session=synthetic",
      secureKey: "synthetic-key",
    }), { mode: 0o600 });
    await chmod(path, 0o640);

    await expect(readSessionFile(path)).rejects.toThrow("chmod 600");
  });

  test("does not follow a session-file symlink", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "target.json");
    const link = join(directory, "session.json");
    await writeFile(target, JSON.stringify({
      cookieHeader: "session=synthetic",
      secureKey: "synthetic-key",
    }), { mode: 0o600 });
    await symlink(target, link);

    await expect(readSessionFile(link)).rejects.toThrow();
  });
});

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "kogane-sbi-vc-session-"));
  temporaryDirectories.push(directory);
  return directory;
}
