// The ホーム page's 最近の変化 panel (ADR 0127 amendment of 2026-11-20): what
// was recorded in the store since an instant, per source, read from
// `GET /api/v2/changes` (the same service as `kogane.changes.since`, ADR 0081).
// `getJson` checks every answer against the wire contract before it renders.
// The panel counts nothing itself: each figure is the digest's, a count the
// digest cut is shown as a lower bound (以上, INV05), and a section the grant
// cannot read is said to be uncounted, never shown as zero. A caller the
// route refuses, and a deployment without the route, see no panel.
import { useState, type ReactNode } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ApiError, getJson, type Overview, useFeatures } from "./api.ts";
import {
  CHANGES_SINCE_NOT_COVERED,
  CHANGES_SINCE_OBSERVATION_KINDS,
  CHANGES_SINCE_PARSE_STATES,
  CHANGES_SINCE_RUN_STATUSES,
  CHANGES_SINCE_UNAVAILABLE,
  ECONOMIC_EVENT_KINDS,
  type ChangesSince,
  type ChangesSinceSection,
  type ChangesSinceSourceLine,
} from "../../../packages/domain/src/changes-since.ts";
import { CHANGES_SINCE_PATH } from "../../../packages/observation-shared/src/changes-since-contract.ts";
import { OUTCOMES } from "./evidence-ui.tsx";
import { Link } from "./router.tsx";
import {
  ArtifactLink,
  Badge,
  EmptyState,
  ErrorState,
  Kv,
  KvRow,
  Loading,
  OBSERVATION_KIND_LABELS,
  Panel,
  type Tone,
} from "./ui.tsx";

/** The route's answer: the digest with the API version the route adds. */
type ChangesSinceAnswer = ChangesSince & { apiVersion: 2 };

/**
 * The windows the panel offers. The default is the last 24 hours: it answers
 * "what changed since yesterday?" (ADR 0127's question) the same way at any
 * hour, where "since midnight in Asia/Tokyo" would show only minutes just
 * after midnight. The longest is 30 days, a day inside the digest's 31-day
 * bound, so a client clock a little behind the server's is not refused as
 * `since:too_old`.
 */
const WINDOWS = [
  { key: "day", label: "24時間", hours: 24 },
  { key: "week", label: "7日間", hours: 24 * 7 },
  { key: "month", label: "30日間", hours: 24 * 30 },
] as const;
type WindowKey = (typeof WINDOWS)[number]["key"];

/** The instant `hours` before `now`, in the canonical form the digest echoes. */
function changesSinceInstant(hours: number, now: number = Date.now()): string {
  return new Date(now - hours * 3_600_000).toISOString();
}

function changesPath(since: string, after: string | null): string {
  const query = new URLSearchParams({ since });
  if (after !== null) query.set("after", after);
  return `${CHANGES_SINCE_PATH}?${query.toString()}`;
}

/**
 * Where a continuation starts: the `since` its first page was answered for and
 * the source the byte bound stopped after. A first page has none.
 */
type ChangesPageParam = { since: string; after: string } | null;

/**
 * The digest for a window. A first page asks from `hours` before the browser's
 * clock when it is read, so a refetch (a refocused tab, a retry) keeps the
 * window it names instead of drifting past the digest's bound
 * (`since:too_old`); a continuation asks with its first page's `since`, so
 * the pages of one answer never mix two instants.
 */
function useChangesSince(key: WindowKey, hours: number, advertised: boolean) {
  return useInfiniteQuery({
    queryKey: ["changes-since", key],
    // Read only where `/api/meta` advertises the route (`changesSince`), so a
    // store without it (the local one) is never asked and logs no 404.
    enabled: advertised,
    initialPageParam: null as ChangesPageParam,
    // getJson checks the shape (`validChangesSince`) before anything renders.
    queryFn: ({ pageParam, signal }) =>
      getJson<ChangesSinceAnswer>(
        changesPath(pageParam?.since ?? changesSinceInstant(hours), pageParam?.after ?? null),
        signal,
      ),
    // The same request with `after` continues an answer the byte bound cut.
    getNextPageParam: (last): ChangesPageParam =>
      last.next === null ? null : { since: last.since, after: last.next.after },
  });
}

// ── labels, typed by the digest's closed lists ──────────────────────────

const RUN_LABELS: Record<(typeof CHANGES_SINCE_RUN_STATUSES)[number], string> = {
  ...OUTCOMES,
  open: "結果未確定",
};
const RUN_TONES: Partial<Record<(typeof CHANGES_SINCE_RUN_STATUSES)[number], Tone>> = {
  success: "ok",
  partial: "warn",
  human_required: "warn",
  failed: "bad",
};
const PARSE_LABELS: Record<(typeof CHANGES_SINCE_PARSE_STATES)[number], string> = {
  published: "現行の解析",
  superseded: "旧解析（置換済み）",
  unadopted: "未採用の解析",
  failed: "解析失敗",
  pending: "解析待ち",
};
const PARSE_TONES: Partial<Record<(typeof CHANGES_SINCE_PARSE_STATES)[number], Tone>> = {
  published: "ok",
  superseded: "superseded",
  failed: "bad",
};
const EVENT_LABELS: Record<(typeof ECONOMIC_EVENT_KINDS)[number], string> = {
  purchase: "購入",
  charge: "請求",
  refund: "返金",
  transfer: "振替",
  card_settlement: "カードの引落",
  fee: "手数料",
  platform_payout: "売上の払い出し",
  unknown: "種類不明",
};
const UNAVAILABLE_LABELS: Record<(typeof CHANGES_SINCE_UNAVAILABLE)[number], string> = {
  unauthorized: "この権限では数えられません",
  not_served: "この環境では提供されていません",
};
type NotCovered = (typeof CHANGES_SINCE_NOT_COVERED)[number];
const NOT_COVERED_LABELS: Record<NotCovered["kind"], string> = {
  "collection.unregistered-terminal": "収集の実行として登録されなかった終了記録",
  "observation.other-kinds": "支払予定・名寄せ・価格の保存記録",
  "value.change": "値がどう変わったか",
};
const NOT_COVERED_REASONS: Record<NotCovered["reason"], string> = {
  no_time_index:
    "記録時刻で引ける索引がないため数えていません（収集の状況で取得元ごとに確認できます）",
  not_counted: "この一覧では数えていません",
  amounts_not_compared: "金額は比べていません（保有の変化は報告値の変化で確認できます）",
};

const number = (value: number): string => value.toLocaleString("ja-JP");
/** A count the digest cut is a lower bound, never an exact figure (INV05). */
const counted = (value: number, cut: boolean): string => `${number(value)}件${cut ? "以上" : ""}`;
const tokyoTime = (value: string): string =>
  new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));

function Time({ value }: { value: string }): ReactNode {
  return (
    <time className="cell-time" dateTime={value}>
      {tokyoTime(value)}
    </time>
  );
}

/** One positional section: its non-zero states, or none; a cut one says so. */
function StateCounts<S extends string>({
  values,
  order,
  labels,
  tones,
  cut,
}: {
  values: readonly number[];
  order: readonly S[];
  labels: Record<S, string>;
  tones: Partial<Record<S, Tone>>;
  cut: boolean;
}): ReactNode {
  const shown = order.flatMap((state, index) => {
    const value = values[index] ?? 0;
    return value > 0 ? [{ state, value }] : [];
  });
  return (
    <span className="changes-counts">
      {shown.length === 0 ? (
        cut ? (
          <span>{counted(0, true)}</span>
        ) : (
          <span className="dim">なし</span>
        )
      ) : (
        shown.map(({ state, value }) => (
          <Badge key={state} tone={tones[state] ?? "neutral"} title={state}>
            {labels[state]} {counted(value, cut)}
          </Badge>
        ))
      )}
      {/* In a cut section a state read as 0 may still have new records past
          the bound: the states not listed are lower bounds too (INV05). */}
      {cut && shown.length > 0 && shown.length < order.length ? (
        <span>そのほか {counted(0, true)}</span>
      ) : null}
      {cut ? <CutBadge /> : null}
    </span>
  );
}

function CutBadge(): ReactNode {
  return (
    <Badge
      tone="warn"
      title="読み取りの上限に達したため、実際の件数はこれより多い可能性があります。"
    >
      上限で打ち切り
    </Badge>
  );
}

function SourceLine({
  line,
  provider,
}: {
  line: ChangesSinceSourceLine;
  provider: string | undefined;
}): ReactNode {
  const cut = (section: ChangesSinceSection) => line.cut.includes(section);
  return (
    <li className="changes-source">
      <h3>
        {provider ?? line.source}
        {provider === undefined ? null : <span className="dim"> · {line.source}</span>}
      </h3>
      <Kv>
        {line.runs === null ? null : (
          <KvRow label="収集の実行">
            <StateCounts
              values={line.runs}
              order={CHANGES_SINCE_RUN_STATUSES}
              labels={RUN_LABELS}
              tones={RUN_TONES}
              cut={cut("runs")}
            />
          </KvRow>
        )}
        {line.captures === null ? null : (
          <KvRow label="取得した原本">
            <span className="changes-counts">
              {line.captures > 0 || cut("captures") ? (
                <span>{counted(line.captures, cut("captures"))}</span>
              ) : (
                <span className="dim">なし</span>
              )}
              {cut("captures") ? <CutBadge /> : null}
            </span>
          </KvRow>
        )}
        <KvRow label="解析の実行">
          <StateCounts
            values={line.parses}
            order={CHANGES_SINCE_PARSE_STATES}
            labels={PARSE_LABELS}
            tones={PARSE_TONES}
            cut={cut("parses")}
          />
        </KvRow>
        <KvRow label="保存記録">
          <StateCounts
            values={line.observations}
            order={CHANGES_SINCE_OBSERVATION_KINDS}
            labels={OBSERVATION_KIND_LABELS}
            tones={{}}
            cut={cut("observations")}
          />
        </KvRow>
        {line.newestRunAt === null ? null : (
          <KvRow label="最新の収集の記録">
            <Time value={line.newestRunAt} />
          </KvRow>
        )}
        {line.newestParsedAt === null ? null : (
          <KvRow label="最新の解析">
            <Time value={line.newestParsedAt} />
            {line.newestParsedArtifactId === null ? null : (
              <>
                {" "}
                <ArtifactLink id={line.newestParsedArtifactId} />
              </>
            )}
          </KvRow>
        )}
      </Kv>
    </li>
  );
}

function Events({ events }: { events: ChangesSinceAnswer["events"] }): ReactNode {
  if (events.state === "unavailable")
    return (
      <p>
        <Badge tone="warn">
          {events.reason === null ? "数えられません" : UNAVAILABLE_LABELS[events.reason]}
        </Badge>
      </p>
    );
  const cut = !events.complete;
  const rows = ECONOMIC_EVENT_KINDS.flatMap((kind, index) => {
    const created = events.new?.[index] ?? 0;
    const revised = events.revised?.[index] ?? 0;
    return created > 0 || revised > 0 ? [{ kind, created, revised }] : [];
  });
  return (
    <>
      {rows.length === 0 ? (
        <p>{cut ? counted(0, true) : <span className="dim">新しい記録はありません</span>}</p>
      ) : (
        <ul className="plain-list">
          {rows.map(({ kind, created, revised }) => (
            <li key={kind}>
              {EVENT_LABELS[kind]}: 新規 {counted(created, cut)} · 更新 {counted(revised, cut)}
            </li>
          ))}
          {/* Past the walk, a kind read as 0 may have new revisions too (INV05). */}
          {cut && rows.length < ECONOMIC_EVENT_KINDS.length ? (
            <li>そのほかの種類: {counted(0, true)}</li>
          ) : null}
        </ul>
      )}
      {cut ? (
        <p className="footnote">
          <CutBadge /> 新しい記録が読み取りの上限を超えたため、件数は下限です。
        </p>
      ) : null}
      {events.newestAt === null ? null : (
        <p className="footnote">
          最新の記録: <Time value={events.newestAt} />
        </p>
      )}
    </>
  );
}

function Answer({
  pages,
  providers,
  more,
}: {
  pages: readonly ChangesSinceAnswer[];
  providers: ReadonlyMap<string, string>;
  more: ReactNode;
}): ReactNode {
  const first = pages[0]!;
  const sources = pages.flatMap((page) => page.sources);
  const unchanged = pages.flatMap((page) => page.unchanged);
  const continues = pages.at(-1)!.next !== null;
  return (
    <div className="panel-body">
      {first.sections.runs === "unauthorized" ? (
        <p className="footnote">
          収集の実行と取得した原本は、この権限では数えていません。それらだけが新しい取得元は「新しい記録のない取得元」に含まれます。
        </p>
      ) : null}
      {sources.length === 0 && !continues ? (
        <EmptyState>この期間に新しく記録されたものはありません。</EmptyState>
      ) : (
        <ul className="plain-list changes-sources">
          {sources.map((line) => (
            <SourceLine key={line.source} line={line} provider={providers.get(line.source)} />
          ))}
        </ul>
      )}
      {more}
      {unchanged.length > 0 ? (
        <details className="detail-disclosure">
          <summary>新しい記録のない取得元（{counted(unchanged.length, continues)}）</summary>
          <ul>
            {unchanged.map((id) => (
              <li key={id}>
                {providers.get(id) === undefined ? id : `${providers.get(id)!} · ${id}`}
              </li>
            ))}
          </ul>
          <p className="footnote">
            なぜ新しい記録がないかは <Link to="/collection-quality">収集の状況</Link>{" "}
            で取得元ごとに確認できます。
          </p>
        </details>
      ) : null}
      <h3 className="section-gap">経済イベント</h3>
      <Events events={first.events} />
      <details className="detail-disclosure">
        <summary>この一覧で数えていないもの（{first.notCovered.length}件）</summary>
        <ul>
          {first.notCovered.map((entry) => (
            <li key={entry.kind}>
              {NOT_COVERED_LABELS[entry.kind]}: {NOT_COVERED_REASONS[entry.reason]}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

/**
 * The errors of continuations that failed, by identity. The query holds its
 * last error until a read settles; this keeps that error read as the
 * continuation's while a later read runs, whatever direction it fetches in.
 */
const continuationErrors = new WeakSet<Error>();

export function ChangesSincePanel({ sources }: { sources: Overview["sources"] }): ReactNode {
  const [chosen, setChosen] = useState<WindowKey>("day");
  const span = WINDOWS.find((entry) => entry.key === chosen)!;
  const features = useFeatures();
  const query = useChangesSince(span.key, span.hours, features.changesSince);
  // `isFetchNextPageError` reads the running fetch's direction, so a reread
  // started after a failed continuation (its retry, a refocused tab, a return
  // to the window, a remount) clears it while the continuation's error is
  // still the query's. The error itself is remembered, and the query keeps
  // that object until a read settles, so the answer read and the error beside
  // the button stay while the reread runs (decision 6). A read that fails
  // anew throws a new error, which only a failed continuation marks. A read
  // refused for authentication withdraws the answer (main.tsx), so with no
  // answer left to keep, the error is the whole panel's.
  if (query.isFetchNextPageError && query.error !== null) continuationErrors.add(query.error);
  const failedOnContinuation =
    query.isError &&
    query.data !== undefined &&
    query.error !== null &&
    continuationErrors.has(query.error);
  // A caller the route refuses (it is the reader's), or a deployment without
  // the route (the local store): the panel is not shown.
  if (
    !features.changesSince ||
    (query.error instanceof ApiError && (query.error.status === 403 || query.error.status === 404))
  )
    return null;
  const providers = new Map(sources.map((source) => [source.id, source.provider]));
  const pages = query.data?.pages;
  const listed = pages?.reduce((sum, page) => sum + page.sources.length, 0);
  const label = "最近の変化";
  const more = query.hasNextPage ? (
    <div className="changes-more">
      <p className="footnote">
        一覧は続きます。一度に読み込める量に上限があるため、分けて読み込みます。
      </p>
      {failedOnContinuation ? (
        <ErrorState
          error={query.error!}
          label="最近の変化の続き"
          // A refused continuation (400: its `since` has passed the digest's
          // bound since the first page was read, say) would be refused again
          // as sent; the retry reads the answer again from the clock instead.
          onRetry={() =>
            void (query.error instanceof ApiError && query.error.status === 400
              ? query.refetch()
              : query.fetchNextPage())
          }
          retrying={query.isFetching}
        />
      ) : (
        <button
          type="button"
          className="button"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? "読み込んでいます…" : "続きを読み込む"}
        </button>
      )}
    </div>
  ) : null;
  return (
    <Panel
      id="changes-since"
      title={label}
      count={
        listed === undefined || query.isError
          ? undefined
          : `取得元 ${counted(listed, query.hasNextPage)}`
      }
      note={
        <>
          {/* The instant the answer shown was read for, as the digest echoes it. */}
          {pages === undefined ? (
            `直近${span.label}`
          ) : (
            <>
              <Time value={pages[0]!.since} />
              以降
            </>
          )}
          に新しく記録されたものを、取得元ごとに数えています。値がどう変わったかは比べていません。
        </>
      }
    >
      <div className="tab-row" role="group" aria-label="期間">
        {WINDOWS.map((entry) => (
          <button
            key={entry.key}
            type="button"
            className="button"
            aria-pressed={chosen === entry.key}
            onClick={() => setChosen(entry.key)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {query.isError && !failedOnContinuation ? (
        <div className="panel-body">
          <ErrorState
            error={query.error}
            label={label}
            onRetry={() => void query.refetch()}
            retrying={query.isFetching}
          />
        </div>
      ) : pages === undefined ? (
        <div className="panel-body">
          <Loading label={label} />
        </div>
      ) : (
        <Answer pages={pages} providers={providers} more={more} />
      )}
    </Panel>
  );
}
