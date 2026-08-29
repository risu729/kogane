// Artifacts — one row per retrieved thing, with the observation counts each
// artifact has produced across all four kinds.
//
// The counts include observations from superseded parse runs, because they
// count what was derived from these bytes, not what is current. The artifact
// detail page is where that distinction is drawn.

import type { ReactNode } from "react";
import { useArtifacts } from "../api.ts";
import { Link } from "../router.tsx";
import { Nullable, Panel, QueryBoundary, RawLink, Sha } from "../ui.tsx";

export function ArtifactsPage(): ReactNode {
  const query = useArtifacts();
  return (
    <>
      <div className="page-head">
        <h1>Artifacts</h1>
        <p className="lede">
          Layer A: the bytes a source actually sent, content-addressed by SHA-256.
          Evidence is immutable — a wrong parser is superseded, an artifact never
          is.
        </p>
      </div>

      <QueryBoundary
        query={query}
        label="artifacts"
        isEmpty={(data) => data.artifacts.length === 0}
        empty="No artifacts ingested. Run bun run demo to populate the store."
      >
        {(data) => (
          <Panel
            id="artifacts"
            title="Fetch artifacts"
            count={`${String(data.artifacts.length)} rows`}
            note="Observation counts are per kind and include every parse run over the bytes, superseded ones included."
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
                      <span className="th-label">dataset</span>
                    </th>
                    <th scope="col">
                      <span className="th-label">url</span>
                    </th>
                    <th scope="col">
                      <span className="th-label">mime</span>
                    </th>
                    <th scope="col">
                      <span className="th-label">fetched_at</span>
                    </th>
                    <th scope="col">
                      <span className="th-label">sha256</span>
                    </th>
                    <th scope="col" className="num">
                      <span className="th-label">parse runs</span>
                    </th>
                    <th scope="col" className="num">
                      <span className="th-label">tx</span>
                    </th>
                    <th scope="col" className="num">
                      <span className="th-label">bal</span>
                    </th>
                    <th scope="col" className="num">
                      <span className="th-label">pos</span>
                    </th>
                    <th scope="col" className="num">
                      <span className="th-label">val</span>
                    </th>
                    <th scope="col">
                      <span className="th-label">bytes</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {data.artifacts.map((artifact) => (
                    <tr key={artifact.id}>
                      <th scope="row" className="num">
                        <Link to={`/artifacts/${String(artifact.id)}`}>#{artifact.id}</Link>
                      </th>
                      <td>{artifact.source_id}</td>
                      <td>
                        <Nullable value={artifact.dataset} />
                      </td>
                      <td className="trunc" title={artifact.url ?? undefined}>
                        <Nullable value={artifact.url} />
                      </td>
                      <td>{artifact.mime}</td>
                      <td className="nowrap">{artifact.fetched_at}</td>
                      <td>
                        <Link to={`/artifacts/${String(artifact.id)}`}>
                          <Sha value={artifact.sha256} />
                        </Link>
                      </td>
                      <td className="num">{artifact.parse_run_count}</td>
                      <td className="num">{artifact.transaction_count}</td>
                      <td className="num">{artifact.balance_count}</td>
                      <td className="num">{artifact.position_count}</td>
                      <td className="num">{artifact.valuation_count}</td>
                      <td>
                        <RawLink sha256={artifact.sha256}>raw ↗</RawLink>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="footnote" style={{ padding: "0.5rem 0.75rem" }}>
              tx / bal / pos / val are the four observation tables this store
              defines: transaction, balance, position, valuation.
            </p>
          </Panel>
        )}
      </QueryBoundary>
    </>
  );
}
