// Unknown route. The URL space is small and mirrors the API's, so the honest
// response is to say what exists rather than to guess where the operator meant
// to go.

import type { ReactNode } from "react";
import { Link } from "../router.tsx";

const ROUTES: { path: string; description: string }[] = [
  { path: "/", description: "row counts, sources, fetch runs, parse runs" },
  { path: "/transactions", description: "current transaction observations" },
  { path: "/balances", description: "latest per key, then the full history" },
  { path: "/positions", description: "positions with provider-reported valuations" },
  { path: "/artifacts", description: "every artifact and its observation counts" },
];

export function NotFoundPage({ path }: { path: string }): ReactNode {
  return (
    <>
      <div className="page-head">
        <h1>404 — no such view</h1>
        <p className="lede">
          Nothing in this client is served at <code>{path}</code>.
        </p>
      </div>

      <section className="panel" aria-labelledby="routes">
        <div className="panel-head">
          <h2 id="routes">Views this client serves</h2>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">
                  <span className="th-label">path</span>
                </th>
                <th scope="col">
                  <span className="th-label">what it shows</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {ROUTES.map((route) => (
                <tr key={route.path}>
                  <th scope="row">
                    <Link to={route.path}>{route.path}</Link>
                  </th>
                  <td>{route.description}</td>
                </tr>
              ))}
              <tr>
                <th scope="row" className="dim">
                  /artifacts/:id
                </th>
                <td>one artifact and every parse run over it, superseded included</td>
              </tr>
              <tr>
                <th scope="row" className="dim">
                  /observations/:kind/:id
                </th>
                <td>
                  one observation and its provenance walk; kind is transaction,
                  balance, position or valuation
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
