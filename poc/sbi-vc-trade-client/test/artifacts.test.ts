import { describe, expect, test } from "bun:test";
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeArtifacts } from "../src/artifacts";

describe("private artifact writer", () => {
  test("creates response files privately in a private directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sbi-vc-artifacts-"));
    try {
      await chmod(directory, 0o755);
      await writeArtifacts(directory, [
        {
          name: "result.json",
          response: { meta: { status: "OK" }, body: { synthetic: true } },
        },
      ]);

      expect((await lstat(directory)).mode & 0o777).toBe(0o700);
      expect((await lstat(join(directory, "result.json"))).mode & 0o777).toBe(0o600);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("refuses an existing artifact symlink without changing its target", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sbi-vc-artifacts-"));
    const target = join(directory, "outside.json");
    try {
      await writeFile(target, "unchanged", { mode: 0o600 });
      await symlink(target, join(directory, "result.json"));

      await expect(
        writeArtifacts(directory, [
          { name: "result.json", response: { meta: { status: "OK" }, body: { synthetic: true } } },
        ]),
      ).rejects.toMatchObject({ code: "EEXIST" });
      expect(await readFile(target, "utf8")).toBe("unchanged");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  test("rejects artifact names that escape the output directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "sbi-vc-artifacts-"));
    try {
      await expect(
        writeArtifacts(directory, [
          {
            name: "../outside.json",
            response: { meta: { status: "OK" }, body: {} },
          },
        ]),
      ).rejects.toThrow("invalid artifact name");
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});
