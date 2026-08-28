// Positions — what the broker says we hold, and what the broker says it is
// worth, side by side.
//
// The single most important rule on this page is that valuations are never
// summed and never converted. A JPY figure and a USD figure for the same
// holding are two separate claims by the source, and the layout says so: each
// valuation is its own labelled figure with its own currency chip, and there
// is no total anywhere, per position or per page.
//
// The pairing of a position with its valuations is this client's one
// interpretive act. It is an exact string match on the provider's own
// (source, account, subject) labels, made by the API at display time and
// stored nowhere. It is stated on the page rather than presented as a fact the
// data carries.

import type { ReactNode } from "react";
import {
  usePositions,
  type PositionWithValuations,
  type ValuationRow,
} from "../api.ts";
import { Amount, Badge, Nullable, ObservationLink, QueryBoundary } from "../ui.tsx";

export function PositionsPage(): ReactNode {
  const query = usePositions();
  return (
    <>
      <div className="page-head">
        <h1>Positions</h1>
        <p className="lede">
          Current position observations with the provider-reported valuations that
          describe them. Kogane computes no valuation of its own; everything here
          is what the source stated.
        </p>
      </div>

      <div className="panel">
        <div className="panel-note derived-note">
          <strong>No figure below is added to any other.</strong> Each valuation
          keeps the currency the provider stated, and a JPY figure and a USD figure
          for the same holding are two separate claims — not two views of one
          number. There is no total on this page, per position or overall, and no
          conversion between currencies anywhere in this client.
        </div>
        <div className="panel-note">
          Positions and valuations are paired by an exact match on the provider&apos;s
          own <code>(source, account, subject)</code> labels, made at display time
          and stored nowhere. It is a decision the data does not carry: a recorded
          link with a relation, method and confidence is a later phase.
        </div>
      </div>

      <QueryBoundary
        query={query}
        label="positions"
        isEmpty={(data) => data.positions.length === 0}
        empty="No current position observations."
      >
        {(data) => (
          <>
            {data.positions.map((entry) => (
              <PositionCard key={entry.position.id} entry={entry} />
            ))}
          </>
        )}
      </QueryBoundary>
    </>
  );
}

/**
 * Bucket valuations by the currency the provider stated, keeping first-seen
 * order. The grouping is what stops the page from reading as one set of
 * figures waiting to be added up: two currencies are two blocks, always.
 */
function groupByCurrency(valuations: ValuationRow[]): [string, ValuationRow[]][] {
  const groups = new Map<string, ValuationRow[]>();
  for (const valuation of valuations) {
    const bucket = groups.get(valuation.currency);
    if (bucket) bucket.push(valuation);
    else groups.set(valuation.currency, [valuation]);
  }
  return [...groups.entries()];
}

function PositionCard({ entry }: { entry: PositionWithValuations }): ReactNode {
  const { position, valuations } = entry;
  const groups = groupByCurrency(valuations);
  const currencies = groups.map(([currency]) => currency);

  return (
    <article className="position-card">
      <div className="position-facts">
        <div className="position-title">
          <span className="security-code">{position.security_code}</span>
          <Badge>{position.source_id}</Badge>
        </div>
        <div className="security-name">
          <Nullable value={position.security_name} placeholder="no security name" />
        </div>

        <div style={{ margin: "0.6rem 0" }}>
          <div className="quantity">{position.quantity_text}</div>
          <div className="figure-metric">
            quantity · scale {position.quantity_scale} · verbatim decimal string
          </div>
        </div>

        <dl className="kv">
          <dt>account</dt>
          <dd>{position.source_account}</dd>
          <dt>market</dt>
          <dd>
            <Nullable value={position.market} />
          </dd>
          <dt>currency</dt>
          <dd>
            <Nullable value={position.currency} />
          </dd>
          <dt>as_of</dt>
          <dd>
            <Nullable value={position.as_of} />
          </dd>
          <dt>parser</dt>
          <dd>{position.parser}</dd>
          <dt>observation</dt>
          <dd>
            <ObservationLink kind="position" id={position.id} />
          </dd>
        </dl>
      </div>

      <div className="position-valuations">
        <div className="position-title">
          <h3>Provider-reported valuations</h3>
          <span className="count dim">
            {valuations.length} figure{valuations.length === 1 ? "" : "s"}
            {currencies.length > 0
              ? ` in ${String(currencies.length)} currenc${currencies.length === 1 ? "y" : "ies"}: ${currencies.join(", ")}`
              : ""}
          </span>
        </div>

        {valuations.length === 0 ? (
          <p className="footnote">
            No provider-reported valuation observation matches this position. That
            is an assertion about the match rule above, not about the provider:
            the source may well have reported one under a label that does not
            match this security code.
          </p>
        ) : (
          <>
            {groups.map(([currency, group]) => (
              <div className="currency-group" key={currency}>
                <div className="currency-group-head">
                  <span className="currency-label">{currency}</span>
                  <span className="count">
                    {group.length} figure{group.length === 1 ? "" : "s"} stated in{" "}
                    {currency}
                  </span>
                </div>
                <div className="currency-group-body">
                  <div className="figures">
                    {group.map((valuation) => (
                      <Figure key={valuation.id} valuation={valuation} />
                    ))}
                  </div>
                </div>
              </div>
            ))}
            {currencies.length > 1 ? (
              <p className="footnote">
                These {valuations.length} figures span {currencies.length} currencies
                ({currencies.join(", ")}), so they sit in {currencies.length} separate
                blocks. They are not commensurable: adding them, or converting one
                into the other, would invent a number the source never reported.
              </p>
            ) : null}
          </>
        )}
      </div>
    </article>
  );
}

function Figure({ valuation }: { valuation: ValuationRow }): ReactNode {
  return (
    <div className="figure">
      <div className="figure-metric">{valuation.metric}</div>
      <div className="figure-amount">
        <Amount
          minor={valuation.amount_minor}
          unit={valuation.currency}
          text={valuation.amount_text}
        />
      </div>
      <div className="figure-foot">
        <span className="figure-currency" title={`stated in ${valuation.currency}`}>
          {valuation.currency}
        </span>
        {/* The pairing above is made on labels alone, with no time alignment,
            so the date each figure describes is the thing most worth showing:
            a valuation from another day is not a view of today's position. */}
        <span className="figure-asof" title="the date this figure describes">
          {valuation.as_of ?? "no as_of"}
        </span>
        <ObservationLink kind="valuation" id={valuation.id} />
      </div>
    </div>
  );
}
