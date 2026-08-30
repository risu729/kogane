import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readSessionFile } from "../src/session";
import type { SessionMaterial } from "../src/types";

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
    await writeFile(path, JSON.stringify(session()), { mode: 0o600 });

    expect(await readSessionFile(path)).toEqual(session());
  });

  test("rejects group-readable files", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "session.json");
    await writeFile(path, JSON.stringify(session()), { mode: 0o600 });
    await chmod(path, 0o640);

    await expect(readSessionFile(path)).rejects.toThrow("chmod 600");
  });

  test("rejects a session missing an observed routing cookie", async () => {
    const directory = await temporaryDirectory();
    const path = join(directory, "session.json");
    const incomplete = structuredClone(session()) as unknown as {
      cookies: Record<string, unknown>;
      secureKey: string;
    };
    delete incomplete.cookies.awsAlbCors;
    await writeFile(path, JSON.stringify(incomplete), { mode: 0o600 });

    await expect(readSessionFile(path)).rejects.toThrow("eight observed session cookies");
  });

  test("does not follow a session-file symlink", async () => {
    const directory = await temporaryDirectory();
    const target = join(directory, "target.json");
    const link = join(directory, "session.json");
    await writeFile(target, JSON.stringify(session()), { mode: 0o600 });
    await symlink(target, link);

    await expect(readSessionFile(link)).rejects.toThrow();
  });
});

function session(): SessionMaterial {
  return {
    cookies: {
      vctBffSid: "synthetic-vct",
      jSessionId: "synthetic-jsession",
      awsAlbApp: ["synthetic-0", "synthetic-1", "synthetic-2", "synthetic-3"],
      awsAlb: "synthetic-alb",
      awsAlbCors: "synthetic-alb-cors",
    },
    secureKey: "synthetic-key",
  };
}

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "kogane-sbi-vc-session-"));
  temporaryDirectories.push(directory);
  return directory;
}
