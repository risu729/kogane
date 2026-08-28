// Artifact detail — the only page where a retired observation stays visible.
//
// Every parse run over these bytes is listed, superseded ones included and
// marked, each with the observations it produced. This is what makes
// "re-parse everything" a button someone will actually press: the old parse
// run's rows sit next to the new one's, and the difference is readable.

import type { ReactNode } from "react";
import { useArtifact, type ParseRunDetail } from "../api.ts";
import { Link } from "../router.tsx";
import {
  Badge,
  KindBadge,
  LineageBadge,
  Nullable,
  ObservationLink,
  Panel,
  QueryBoundary,
  RawLink,
  Sha,
  StatusBadge,
  WarningList,
} from "../ui.tsx";

export function ArtifactDetailPage({ id }: { id: number }): ReactNode {
  const query = useArtifact(id);
  return (
    <>
      <div className="page-head">
        <div className="breadcrumb">
          <Link to="/artifacts">artifacts</Link> / #{id}
        </div>
        <h1>Artifact #{id}</h1>
        <p className="lede">
          The layer A record for these bytes, then every parse run over them.
        </p>
      </div>

      <QueryBoundary query={query} label={`artifact #${String(id)}`}>
        {(data) => {
          const artifact = data.artifact;
          const superseded = data.parseRuns.filter(
            (run) => run.superseded_by_parse_run_id !== null,
          ).length;
          return (
            <>
              <Panel id="artifact-record" title="Layer A record">
                <div className="panel-body">
                  <dl className="kv">
                    <dt>artifact id</dt>
                    <dd>{artifact.id}</dd>
                    <dt>source</dt>
                    <dd>{artifact.source_id}</dd>
                    <dt>dataset</dt>
                    <dd>
                      <Nullable value={artifact.dataset} />
                    </dd>
                    <dt>url</dt>
                    <dd>
                      <Nullable value={artifact.url} />
                    </dd>
                    <dt>method</dt>
                    <dd>
                      <Nullable value={artifact.method} />
                    </dd>
                    <dt>http_status</dt>
                    <dd>
                      <Nullable value={artifact.http_status} />
                    </dd>
                    <dt>mime</dt>
                    <dd>{artifact.mime}</dd>
                    <dt>fetched_at</dt>
                    <dd>{artifact.fetched_at}</dd>
                  </dl>
                </div>
              </Panel>

              <Panel
                id="raw-object"
                title="Raw object"
                note="The bytes are served verbatim, but never as an active document: the API sends them with Content-Security-Policy: sandbox and X-Content-Type-Options: nosniff, because captured evidence can be attacker-authored HTML."
              >
                <div className="panel-body">
                  <dl className="kv">
                    <dt>sha256</dt>
                    <dd>
                      <Sha value={artifact.sha256} full />
                    </dd>
                    <dt>size</dt>
                    <dd>{artifact.size} bytes</dd>
                    <dt>content_type</dt>
                    <dd>{artifact.content_type}</dd>
                    <dt>bytes</dt>
                    <dd>
                      <RawLink sha256={artifact.sha256}>
                        /api/raw/{artifact.sha256.slice(0, 12)}… ↗
                      </RawLink>
                    </dd>
                  </dl>
                </div>
              </Panel>

              <Panel id="fetch-run" title="Fetch run">
                <div className="panel-body">
                  <dl className="kv">
                    <dt>fetch run id</dt>
                    <dd>{artifact.fetch_run_id}</dd>
                    <dt>tool</dt>
                    <dd>{artifact.tool}</dd>
                    <dt>external_run_id</dt>
                    <dd>
                      <Nullable value={artifact.external_run_id} />
                    </dd>
                    <dt>status</dt>
                    <dd>
                      <StatusBadge status={artifact.fetch_status} />
                    </dd>
                    <dt>started_at</dt>
                    <dd>{artifact.started_at}</dd>
                    <dt>completed_at</dt>
                    <dd>
                      <Nullable value={artifact.completed_at} placeholder="not completed" />
                    </dd>
                  </dl>
                </div>
              </Panel>

              <Panel
                id="parse-runs"
                title="Every parse run over these bytes"
                count={`${String(data.parseRuns.length)} runs · ${String(superseded)} superseded`}
                note="Superseded runs are shown here and nowhere else. No observation row is ever updated or deleted, so a retired parse run's output remains readable next to what replaced it."
              >
                {data.parseRuns.length === 0 ? (
                  <div className="panel-body dim">
                    No parser has run over this artifact yet.
                  </div>
                ) : (
                  <div className="panel-body">
                    {data.parseRuns.map((run) => (
                      <ParseRunCard key={run.id} run={run} />
                    ))}
                  </div>
                )}
              </Panel>
            </>
          );
        }}
      </QueryBoundary>
    </>
  );
}

function ParseRunCard({ run }: { run: ParseRunDetail }): ReactNode {
  const isSuperseded = run.superseded_by_parse_run_id !== null;
  return (
    <section
      className={isSuperseded ? "chain-card is-superseded" : "chain-card"}
      aria-label={`parse run ${String(run.id)}${isSuperseded ? ", superseded" : ""}`}
    >
      <div className="chain-card-head">
        <span className="chain-stage">parse run</span>
        <span className="chain-title">
          #{run.id} · {run.parser_name}
          <span className="dim">@</span>
          {run.parser_version}
        </span>
        <StatusBadge status={run.status} />
        <LineageBadge supersededBy={run.superseded_by_parse_run_id} />
        <span className="count">{run.parsed_at}</span>
      </div>
      <div className="chain-body">
        {run.error === null ? null : (
          <p className="state state-error" style={{ marginBottom: "0.5rem" }}>
            {run.error}
          </p>
        )}
        <WarningList warnings={run.warnings} />

        <h3 style={{ marginTop: run.warnings.length > 0 ? "0.6rem" : 0 }}>
          Observations{" "}
          <span className="count dim">
            ({run.observations.length}
            {isSuperseded ? ", retired" : ""})
          </span>
        </h3>
        {run.observations.length === 0 ? (
          <p className="footnote">
            This parse run produced no observations. An error run is written on its
            own, with none.
          </p>
        ) : (
          <ul className="obs-list">
            {run.observations.map((observation) => (
              <li key={`${observation.kind}:${String(observation.id)}`}>
                <KindBadge kind={observation.kind} />
                <ObservationLink kind={observation.kind} id={observation.id} />
                <span className="obs-summary">{observation.summary}</span>
              </li>
            ))}
          </ul>
        )}
        {isSuperseded ? (
          <p className="footnote">
            These observations are retired: they never appear in the transactions,
            balances or positions views, and are reachable only from this page.
            They were replaced by parse run #{run.superseded_by_parse_run_id}{" "}
            <Badge tone="superseded">over the same bytes</Badge>.
          </p>
        ) : null}
      </div>
    </section>
  );
}
