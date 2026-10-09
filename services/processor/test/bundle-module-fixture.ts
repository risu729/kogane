// Test-only bundled modules need short file URLs: Bun 1.4.2 coverage panics
// on long data URLs. The generated *.test.mjs file uses Bun's default test-file
// coverage exclusion; no production source or original bundle input is excluded.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export async function loadBundleFixture<T>(source: string): Promise<{
  module: T;
  dispose(): Promise<void>;
}> {
  const directory = await mkdtemp(join(tmpdir(), "kogane-alarm-bundle-"));
  try {
    const path = join(directory, "schedule-alarm.test.mjs");
    await writeFile(path, source, { flag: "wx" });
    const module = (await import(pathToFileURL(path).href)) as T;
    return {
      module,
      dispose: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
