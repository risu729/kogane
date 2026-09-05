import { chmod, mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Artifact } from "./types";

export async function writeArtifacts(
  outputDirectory: string,
  artifacts: Artifact[],
): Promise<void> {
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true, mode: 0o700 });
  await chmod(output, 0o700);

  for (const artifact of artifacts) {
    if (!/^[a-z0-9][a-z0-9-]*\.json$/u.test(artifact.name)) {
      throw new Error("invalid artifact name");
    }
    await writeFile(resolve(output, artifact.name), JSON.stringify(artifact.response), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  }
}
