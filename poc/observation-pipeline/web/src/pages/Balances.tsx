// Balances — a derived view above the record it is derived from.
//
// The first table is the latest observation per
// (source, source_account, metric, instrument), computed by a window function
// on the request that asks for it and stored nowhere. The second is the
// append-only history it was derived from, superseded rows included and
// marked. The order on the page is deliberate: the derived thing never appears
// without the record underneath it.

import type { ReactNode } from "react";
import { useBalances, type BalanceHistoryRow, type BalanceRow } from "../api.ts";
import {
  Amount,
  Badge,
  LineageBadge,
  Nullable,
  Panel,
  QueryBoundary,
} from "../ui.tsx";
import { ObservationLink } from "../ui.tsx";

export function BalancesPage(): ReactNode {
  const query = useBalances();
  return (
    <>
      <div className="page-head">
        <h1>Balances</h1>
        <p className="lede">
          A balance is a measurement, so each metric an institution reports is its
          own row. Nothing is collapsed into one number per account, and no two
          rows are ever added together.
        </p>
      </div>

      <QueryBoundary query={query} label="balances">
        {(data) => (
          <>
            <LatestTable rows={data.latest} />
            <HistoryTable rows={data.history} />
          </>
        )}
      </QueryBoundary>
    </>
  );
}

function LatestTable({ rows }: { rows: BalanceRow[] }): ReactNode {
  return (
    <section className="panel" aria-labelledby="latest-balances">
      <div className="panel-head">
        <h2 id="latest-balances">Latest per (source, account, metric, instrument)</h2>
        <span className="count">{rows.length} rows</span>
      </div>
      <div className="panel-note derived-note">
        <strong>Derived on request, stored nowhere.</strong> This table is a
        <code> ROW_NUMBER()</code> over the current rows in the history below,
        recomputed on every request. There is no “latest balance” row in the
        store, no cache, and no snapshot table — reload the page and it is
        computed again from scratch.
      </div>
      {rows.length === 0 ? (
        <div className="panel-body dim">No current balance observations.</div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">
                  <span className="th-label">obs</span>
                </th>
                <th scope="col">
                  <span className="th-label">source</span>
                </th>
                <th scope="col">
                  <span className="th-label">account</span>
                </th>
                <th scope="col">
                  <span className="th-label">metric</span>
                </th>
                <th scope="col">
                  <span className="th-label">instrument</span>
                </th>
                <th scope="col" className="num">
                  <span className="th-label">amount</span>
                </th>
                <th scope="col">
                  <span className="th-label">as_of</span>
                </th>
                <th scope="col">
                  <span className="th-label">observed_at</span>
                </th>
                <th scope="col">
                  <span className="th-label">parser</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id}>
                  <th scope="row">
                    <ObservationLink kind="balance" id={row.id} />
                  </th>
                  <td>{row.source_id}</td>
                  <td>{row.source_account}</td>
                  <td>{row.metric}</td>
                  <td>
                    <Badge>{row.instrument}</Badge>
                  </td>
                  <td className="num">
                    <Amount
                      minor={row.amount_minor}
                      unit={row.instrument}
                      text={row.amount_text}
                    />
                  </td>
                  <td className="nowrap">
                    <Nullable value={row.as_of} />
                  </td>
                  <td className="nowrap">
                    <Nullable value={row.observed_at} />
                  </td>
                  <td className="nowrap">{row.parser}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="footnote" style={{ padding: "0.5rem 0.75rem" }}>
        “Latest” ranks by <code>COALESCE(as_of, observed_at, &apos;&apos;) DESC</code>,
        then by row id. <code>as_of</code> is the point in time a value describes;{" "}
        <code>observed_at</code> is when the source displayed it. Ranking one
        against the other treats two different kinds of time as the same kind, so
        this ordering is a display convenience, not a claim about which
        measurement is the most recent.
      </p>
    </section>
  );
}

function HistoryTable({ rows }: { rows: BalanceHistoryRow[] }): ReactNode {
  const supersededCount = rows.filter(
    (row) => row.superseded_by_parse_run_id !== null,
  ).length;

  return (
    <Panel
      id="balance-history"
      title="Append-only history"
      count={`${String(rows.length)} rows · ${String(supersededCount)} superseded`}
      note="Every balance observation ever written, in the order the ranking above reads them. Rows from a superseded parse run are kept and marked, never deleted: that is what makes a re-parse auditable."
    >
      {rows.length === 0 ? (
        <div className="panel-body dim">No balance observations.</div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">
                  <span className="th-label">obs</span>
                </th>
                <th scope="col">
                  <span className="th-label">source</span>
                </th>
                <th scope="col">
                  <span className="th-label">account</span>
                </th>
                <th scope="col">
                  <span className="th-label">metric</span>
                </th>
                <th scope="col">
                  <span className="th-label">instrument</span>
                </th>
                <th scope="col" className="num">
                  <span className="th-label">amount</span>
                </th>
                <th scope="col">
                  <span className="th-label">as_of</span>
                </th>
                <th scope="col">
                  <span className="th-label">observed_at</span>
                </th>
                <th scope="col">
                  <span className="th-label">parser</span>
                </th>
                <th scope="col">
                  <span className="th-label">parse status</span>
                </th>
                <th scope="col">
                  <span className="th-label">lineage</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr
                  key={row.id}
                  className={row.superseded_by_parse_run_id === null ? "" : "is-superseded"}
                >
                  <th scope="row">
                    <ObservationLink kind="balance" id={row.id} />
                  </th>
                  <td>{row.source_id}</td>
                  <td>{row.source_account}</td>
                  <td>{row.metric}</td>
                  <td>
                    <Badge>{row.instrument}</Badge>
                  </td>
                  <td className="num">
                    <Amount
                      minor={row.amount_minor}
                      unit={row.instrument}
                      text={row.amount_text}
                    />
                  </td>
                  <td className="nowrap">
                    <Nullable value={row.as_of} />
                  </td>
                  <td className="nowrap">
                    <Nullable value={row.observed_at} />
                  </td>
                  <td className="nowrap">{row.parser}</td>
                  <td>
                    <Badge tone={row.parse_status === "ok" ? "ok" : "bad"}>
                      {row.parse_status}
                    </Badge>
                  </td>
                  <td>
                    <LineageBadge supersededBy={row.superseded_by_parse_run_id} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
