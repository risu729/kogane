// Observation detail — the page the rest of this client exists to reach.
//
// Every stored column, extra_json verbatim, and the provenance walk:
//
//   observation -> parse run -> fetch artifact -> raw object -> fetch run
//
// Every link in that chain is load-bearing. Drop the raw locator and the
// operator knows which file but not which part of it. Drop the parser version
// and a wrong value cannot be attributed to a parser generation. Drop the
// artifact and the same bytes cannot be found under a different fetch. Drop
// the raw object and the tool asserts provenance it cannot show. Drop the
// fetch run and there is no answer to "was this from the run that half
// failed". A chain with a gap in it is not evidence; it is a claim — so when
// the API returns no provenance, this page says so loudly rather than
// rendering four cards and implying the fifth.

import type { ReactNode } from "react";
import {
  useObservation,
  type ObservationDetail,
  type Provenance,
} from "../api.ts";
import { Link, type ObservationKind } from "../router.tsx";
import { formatAmount } from "../money.ts";
import {
  Amount,
  Badge,
  CellValue,
  KindBadge,
  LineageBadge,
  Nullable,
  Panel,
  QueryBoundary,
  RawLink,
  Sha,
  StatusBadge,
  WarningList,
} from "../ui.tsx";

function readString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function readInteger(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  return typeof value === "number" ? value : null;
}

export function ObservationDetailPage({
  kind,
  id,
}: {
  kind: ObservationKind;
  id: number;
}): ReactNode {
  const query = useObservation(kind, id);
  return (
    <>
      <div className="page-head">
        <div className="breadcrumb">observations / {kind} / #{id}</div>
        <div className="title-row">
          <h1>
            {kind} observation #{id}
          </h1>
          <KindBadge kind={kind} />
        </div>
        <p className="lede">
          What exactly this row is, and where it came from.
        </p>
      </div>

      <QueryBoundary query={query} label={`${kind} observation #${String(id)}`}>
        {(data) => <ObservationBody detail={data} />}
      </QueryBoundary>
    </>
  );
}

function ObservationBody({ detail }: { detail: ObservationDetail }): ReactNode {
  const { row, provenance } = detail;
  const columns = Object.keys(row);
  const amountMinor = readInteger(row, "amount_minor");
  const amountText = readString(row, "amount_text");
  const unit = readString(row, "currency") ?? readString(row, "instrument");
  const rawLocator = readString(row, "raw_locator");
  const hasAmount = formatAmount(amountMinor, unit, amountText) !== "";

  return (
    <>
      {provenance !== null && provenance !== undefined &&
      provenance.superseded_by_parse_run_id !== null ? (
        <div className="state state-error" role="alert" style={{ marginBottom: "1.25rem" }}>
          <span className="state-title">This observation is retired.</span>
          The parse run that produced it was superseded by parse run #
          {provenance.superseded_by_parse_run_id}. It is reachable by URL and from
          its artifact, but it appears in no current view and must not be read as
          the store&apos;s current answer.
        </div>
      ) : null}

      {hasAmount ? (
        <Panel
          id="amount"
          title="Amount"
          note="Formatted from integer minor units by string and BigInt manipulation. It never passes through floating point, and the unit is printed exactly as the source stated it."
        >
          <div className="panel-body">
            <div className="quantity">
              <Amount minor={amountMinor} unit={unit} text={amountText} />
            </div>
            <div className="figure-metric" style={{ marginTop: "0.3rem" }}>
              amount_minor {amountMinor === null ? "null" : amountMinor} · unit{" "}
              {unit ?? "unknown"} · provider text {amountText ?? "null"}
            </div>
          </div>
        </Panel>
      ) : null}

      <Panel
        id="stored-row"
        title="Stored columns"
        count={`${String(columns.length)} columns`}
        note="Every column of the row as stored, extra_json excluded — it is shown in full below."
      >
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">
                  <span className="th-label">column</span>
                </th>
                <th scope="col">
                  <span className="th-label">value</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {columns.map((column) => (
                <tr key={column}>
                  <th scope="row">{column}</th>
                  <td className="wrap">
                    <CellValue value={row[column]} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      <Panel
        id="extra"
        title="extra_json"
        note={
          detail.extraParsed
            ? "Every provider field the parser did not model, carried by name. Pretty-printed from the stored JSON; the stored bytes are unchanged."
            : "The stored value is not valid JSON, so it is shown exactly as stored rather than reshaped into something the store does not hold."
        }
      >
        <div className="panel-body">
          {detail.extraRaw === "" ? (
            <p className="dim">No extra_json on this row.</p>
          ) : (
            <pre>
              <code>
                {detail.extraParsed
                  ? JSON.stringify(detail.extra, null, 2)
                  : detail.extraRaw}
              </code>
            </pre>
          )}
        </div>
      </Panel>

      <h2 className="section-gap" id="provenance" style={{ marginBottom: "0.6rem" }}>
        Provenance walk
      </h2>
      <p className="footnote" style={{ margin: "0 0 0.9rem" }}>
        From this row down to the bytes a source actually sent. The chain is
        navigable in both directions: every artifact below leads back to every
        observation any parser version ever derived from it.
      </p>

      {provenance === null || provenance === undefined ? (
        <div className="state state-error" role="alert">
          <span className="state-title">The provenance chain is broken.</span>
          No parse run backs this observation, so there is nothing to walk to. A
          chain with a gap in it is not evidence; it is a claim.
        </div>
      ) : (
        <ProvenanceChain
          detail={detail}
          provenance={provenance}
          rawLocator={rawLocator}
        />
      )}
    </>
  );
}

function ChainStep({
  index,
  stage,
  title,
  badges,
  children,
  relation,
}: {
  index: number;
  stage: string;
  title: ReactNode;
  badges?: ReactNode;
  children: ReactNode;
  relation?: string;
}): ReactNode {
  return (
    <li className="chain-step">
      <span className="chain-marker" aria-hidden="true">
        {index}
      </span>
      <div className="chain-card">
        <div className="chain-card-head">
          <span className="chain-stage">{stage}</span>
          <span className="chain-title">{title}</span>
          {badges}
        </div>
        <div className="chain-body">{children}</div>
      </div>
      {relation === undefined ? null : (
        <span className="chain-arrow">↓ {relation}</span>
      )}
    </li>
  );
}

function ProvenanceChain({
  detail,
  provenance,
  rawLocator,
}: {
  detail: ObservationDetail;
  provenance: Provenance;
  rawLocator: string | null;
}): ReactNode {
  const observationId = readInteger(detail.row, "id");
  const account = readString(detail.row, "source_account");

  return (
    <ol className="chain">
      <ChainStep
        index={1}
        stage="observation"
        title={
          <>
            {detail.kind} #{observationId ?? "?"}
          </>
        }
        badges={<KindBadge kind={detail.kind} />}
        relation="produced by"
      >
        <dl className="kv">
          <dt>raw_locator</dt>
          <dd>
            <Nullable value={rawLocator} placeholder="no raw locator" />
          </dd>
          <dt>source_account</dt>
          <dd>
            <Nullable value={account} />
          </dd>
        </dl>
        <p className="footnote">
          The raw locator points at the part of the artifact this value was read
          from, so the claim can be checked against the bytes and not just the
          file.
        </p>
      </ChainStep>

      <ChainStep
        index={2}
        stage="parse run"
        title={
          <>
            #{provenance.parse_run_id} · {provenance.parser_name}
            <span className="dim">@</span>
            {provenance.parser_version}
          </>
        }
        badges={
          <>
            <StatusBadge status={provenance.parse_status} />
            <LineageBadge supersededBy={provenance.superseded_by_parse_run_id} />
          </>
        }
        relation="ran over"
      >
        <dl className="kv">
          <dt>parsed_at</dt>
          <dd>{provenance.parsed_at}</dd>
          <dt>status</dt>
          <dd>{provenance.parse_status}</dd>
          <dt>error</dt>
          <dd>
            <Nullable value={provenance.error} placeholder="none" />
          </dd>
          <dt>warnings</dt>
          <dd>
            {provenance.warnings.length === 0 ? (
              <span className="dim">none</span>
            ) : (
              <>
                <Badge tone="warn">
                  {provenance.warnings.length} warning
                  {provenance.warnings.length === 1 ? "" : "s"}
                </Badge>
                <WarningList warnings={provenance.warnings} />
              </>
            )}
          </dd>
        </dl>
      </ChainStep>

      <ChainStep
        index={3}
        stage="fetch artifact"
        title={<>#{provenance.artifact_id}</>}
        badges={<Badge>{provenance.source_id}</Badge>}
        relation="whose bytes are"
      >
        <dl className="kv">
          <dt>dataset</dt>
          <dd>
            <Nullable value={provenance.dataset} />
          </dd>
          <dt>url</dt>
          <dd>
            <Nullable value={provenance.url} />
          </dd>
          <dt>mime</dt>
          <dd>{provenance.mime}</dd>
          <dt>fetched_at</dt>
          <dd>{provenance.fetched_at}</dd>
          <dt>every parse run</dt>
          <dd>
            <Link to={`/artifacts/${String(provenance.artifact_id)}`}>
              artifact #{provenance.artifact_id} ↗
            </Link>
          </dd>
        </dl>
      </ChainStep>

      <ChainStep
        index={4}
        stage="raw object"
        title={<Sha value={provenance.sha256} />}
        relation="retrieved by"
      >
        <dl className="kv">
          <dt>sha256</dt>
          <dd>
            <Sha value={provenance.sha256} full />
          </dd>
          <dt>size</dt>
          <dd>{provenance.size} bytes</dd>
          <dt>content_type</dt>
          <dd>{provenance.content_type}</dd>
          <dt>bytes</dt>
          <dd>
            <RawLink sha256={provenance.sha256}>
              open the exact bytes this value came from ↗
            </RawLink>
          </dd>
        </dl>
      </ChainStep>

      <ChainStep
        index={5}
        stage="fetch run"
        title={
          <>
            #{provenance.fetch_run_id} · {provenance.tool}
          </>
        }
        badges={<StatusBadge status={provenance.fetch_status} />}
      >
        <dl className="kv">
          <dt>external_run_id</dt>
          <dd>
            <Nullable value={provenance.external_run_id} />
          </dd>
          <dt>started_at</dt>
          <dd>{provenance.started_at}</dd>
          <dt>completed_at</dt>
          <dd>
            <Nullable value={provenance.completed_at} placeholder="not completed" />
          </dd>
        </dl>
      </ChainStep>
    </ol>
  );
}
