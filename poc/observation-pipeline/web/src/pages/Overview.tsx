// Overview — what is in the store, where it came from, and which parser
// versions are live. Row counts are the only aggregate this client computes at
// all, and counting rows is not a claim about money.

import type { ReactNode } from "react";
import { useOverview } from "../api.ts";
import { Link } from "../router.tsx";
import {
  Badge,
  LineageBadge,
  Nullable,
  Panel,
  QueryBoundary,
  StatusBadge,
  WarningBadge,
} from "../ui.tsx";

export function OverviewPage(): ReactNode {
  const query = useOverview();
  return (
    <>
      <div className="page-head">
        <h1>Overview</h1>
        <p className="lede">
          Layer A evidence and layer B observations, as the store holds them. Every
          figure below is counted on request and stored nowhere.
        </p>
      </div>

      <QueryBoundary query={query} label="the overview">
        {(data) => (
          <>
            <Panel
              id="counts"
              title="Row counts"
              count={`${String(data.counts.length)} tables`}
            >
              <div className="tiles">
                {data.counts.map((entry) => (
                  <div className="tile" key={entry.table}>
                    <div className="tile-value">{entry.rows}</div>
                    <div className="tile-label">{entry.table}</div>
                  </div>
                ))}
              </div>
            </Panel>

            <Panel
              id="sources"
              title="Sources"
              count={`${String(data.sources.length)} rows`}
              note="source_account labels are the provider's own and carry no institution identity, so the source is part of every key in this client."
            >
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">
                        <span className="th-label">id</span>
                      </th>
                      <th scope="col">
                        <span className="th-label">provider</span>
                      </th>
                      <th scope="col">
                        <span className="th-label">ingestion</span>
                      </th>
                      <th scope="col" className="num">
                        <span className="th-label">artifacts</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.sources.map((source) => (
                      <tr key={source.id}>
                        <th scope="row">{source.id}</th>
                        <td>{source.provider}</td>
                        <td>
                          <Badge>{source.ingestion}</Badge>
                        </td>
                        <td className="num">{source.artifact_count}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>

            <Panel
              id="fetch-runs"
              title="Fetch runs"
              count={`${String(data.fetchRuns.length)} rows`}
            >
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col" className="num">
                        <span className="th-label">#</span>
                      </th>
                      <th scope="col">
                        <span className="th-label">source</span>
                      </th>
                      <th scope="col">
                        <span className="th-label">tool</span>
                      </th>
                      <th scope="col">
                        <span className="th-label">external run id</span>
                      </th>
                      <th scope="col">
                        <span className="th-label">status</span>
                      </th>
                      <th scope="col">
                        <span className="th-label">started_at</span>
                      </th>
                      <th scope="col">
                        <span className="th-label">completed_at</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.fetchRuns.map((run) => (
                      <tr key={run.id}>
                        <th scope="row" className="num">
                          {run.id}
                        </th>
                        <td>{run.source_id}</td>
                        <td>{run.tool}</td>
                        <td>
                          <Nullable value={run.external_run_id} />
                        </td>
                        <td>
                          <StatusBadge status={run.status} />
                        </td>
                        <td className="nowrap">{run.started_at}</td>
                        <td className="nowrap">
                          <Nullable value={run.completed_at} placeholder="not completed" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>

            <Panel
              id="parse-runs"
              title="Parse runs"
              count={`${String(data.parseRuns.length)} rows`}
              note="Every parse run ever recorded, superseded ones included. A superseded run's observations are still reachable through its artifact; nothing is ever deleted."
            >
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col" className="num">
                        <span className="th-label">#</span>
                      </th>
                      <th scope="col">
                        <span className="th-label">artifact</span>
                      </th>
                      <th scope="col">
                        <span className="th-label">parser@version</span>
                      </th>
                      <th scope="col">
                        <span className="th-label">parsed_at</span>
                      </th>
                      <th scope="col">
                        <span className="th-label">status</span>
                      </th>
                      <th scope="col">
                        <span className="th-label">warnings</span>
                      </th>
                      <th scope="col">
                        <span className="th-label">lineage</span>
                      </th>
                      <th scope="col">
                        <span className="th-label">error</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.parseRuns.map((run) => (
                      <tr
                        key={run.id}
                        className={run.superseded_by_parse_run_id === null ? "" : "is-superseded"}
                      >
                        <th scope="row" className="num">
                          {run.id}
                        </th>
                        <td>
                          <Link to={`/artifacts/${String(run.fetch_artifact_id)}`}>
                            #{run.fetch_artifact_id}
                          </Link>
                        </td>
                        <td className="nowrap">
                          {run.parser_name}
                          <span className="dim">@</span>
                          {run.parser_version}
                        </td>
                        <td className="nowrap">{run.parsed_at}</td>
                        <td>
                          <StatusBadge status={run.status} />
                        </td>
                        <td>
                          <WarningBadge count={run.warnings.list.length} />
                        </td>
                        <td>
                          <LineageBadge supersededBy={run.superseded_by_parse_run_id} />
                        </td>
                        <td className="wrap">
                          <Nullable value={run.error} placeholder="—" />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Panel>
          </>
        )}
      </QueryBoundary>
    </>
  );
}
