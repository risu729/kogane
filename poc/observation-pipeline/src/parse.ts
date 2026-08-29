// Run every registered parser over every artifact it accepts.
//
// Idempotent per (artifact, parser_name, parser_version): an identical
// re-invocation does nothing. A parser with a bumped version re-parses the
// same artifacts and supersedes its own earlier parse runs — observations are
// never updated or deleted, the old parse run is simply marked superseded.
// This is the "re-parse everything with a newer parser" first-class operation
// from docs/roadmap.md phase 3.

import type { Parser } from "./types.ts";
import {
  findParseRun,
  insertObservation,
  insertParseRun,
  listArtifacts,
  openStore,
  readRawObject,
  supersedeOlderParseRuns,
  type Store,
} from "./store.ts";
import { PARSERS } from "./parsers/registry.ts";

export interface ParseSummary {
  parsed: number;
  skipped: number;
  superseded: number;
  observations: number;
  errors: number;
}

export function runParsers(
  store: Store,
  parsers: readonly Parser[] = PARSERS,
  now: () => string = () => new Date().toISOString(),
): ParseSummary {
  const summary: ParseSummary = {
    parsed: 0,
    skipped: 0,
    superseded: 0,
    observations: 0,
    errors: 0,
  };
  const artifacts = listArtifacts(store);
  for (const artifact of artifacts) {
    for (const parser of parsers) {
      if (!parser.accepts(artifact)) continue;
      if (findParseRun(store, artifact.id, parser.name, parser.version) !== undefined) {
        summary.skipped += 1;
        continue;
      }
      try {
        // The blob read is inside the try so that one missing object produces
        // an error parse run for that artifact instead of aborting the sweep.
        const bytes = readRawObject(store, artifact.sha256);
        const result = parser.parse(bytes, artifact);
        // The parse run and all of its observations commit together: a partial
        // observation set under a run marked "ok" would be indistinguishable
        // from a source that really said less.
        const parseRunId = store.db.transaction(() => {
          const runId = insertParseRun(store, {
            artifactId: artifact.id,
            parserName: parser.name,
            parserVersion: parser.version,
            parsedAt: now(),
            status: "ok",
            warnings: result.warnings,
          });
          for (const observation of result.observations) {
            insertObservation(store, runId, observation);
          }
          return runId;
        })();
        summary.observations += result.observations.length;
        summary.parsed += 1;
        // Only a successful run changes what is current. An error run never
        // supersedes anything, so a transient failure cannot empty the
        // current view.
        summary.superseded += supersedeOlderParseRuns(
          store,
          artifact.id,
          parser.name,
          parseRunId,
        );
      } catch (error) {
        insertParseRun(store, {
          artifactId: artifact.id,
          parserName: parser.name,
          parserVersion: parser.version,
          parsedAt: now(),
          status: "error",
          error: error instanceof Error ? error.message : String(error),
          warnings: [],
        });
        summary.errors += 1;
      }
    }
  }
  return summary;
}

if (import.meta.main) {
  const store = openStore();
  const summary = runParsers(store);
  console.log(
    `parse: ${summary.parsed} parsed, ${summary.skipped} already current, ` +
      `${summary.superseded} superseded, ${summary.observations} observations, ` +
      `${summary.errors} errors`,
  );
}
