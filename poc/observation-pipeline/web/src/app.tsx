// Read-only navigation. Connection metadata describes the API, not freshness
// of financial observations or whether a collector is currently running.

import { useEffect, useRef, type ReactNode } from "react";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { useFeatures, useMetadata } from "./api.ts";
import { QueryBoundary } from "./ui.tsx";
import { Link, useRoute, usePath, type Route } from "./router.tsx";
import { OverviewPage } from "./pages/Overview.tsx";
import { TransactionsPage } from "./pages/Transactions.tsx";
import { BalancesPage } from "./pages/Balances.tsx";
import { PositionsPage } from "./pages/Positions.tsx";
import { ArtifactsPage } from "./pages/Artifacts.tsx";
import { ArtifactDetailPage } from "./pages/ArtifactDetail.tsx";
import { ObservationDetailPage } from "./pages/ObservationDetail.tsx";
import { NotFoundPage } from "./pages/NotFound.tsx";
import { EvidenceContent } from "./evidence-app.tsx";
import { ParsingHealthNotice } from "./parsing-health.tsx";
import { CollectionControls } from "./collection-controls.tsx";
import { IdentitiesPage } from "./pages/Identities.tsx";
import { RewardsPage } from "./pages/Rewards.tsx";

const NAV: { to: string; label: string; icon: string }[] = [
  {
    to: "/",
    label: "ホーム",
    icon: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  },
  {
    to: "/transactions",
    label: "取引",
    icon: "M4 7h16m-4-4 4 4-4 4 M20 17H4m4-4-4 4 4 4",
  },
  {
    to: "/balances",
    label: "残高",
    icon: "M3 7h18v13H3z M3 7V4h15v3 M16 12h5v4h-5z",
  },
  {
    to: "/positions",
    label: "保有資産",
    icon: "M4 21V11h4v10 M10 21V3h4v18 M16 21V7h4v14",
  },
  { to: "/summaries", label: "期間実績・請求", icon: "M5 3h14v18H5z M8 8h8 M8 12h8 M8 16h5" },
  {
    to: "/artifacts",
    label: "原本・証跡",
    icon: "M5 3h9l5 5v13H5z M14 3v6h5 M9 13h6 M9 17h6",
  },
];

// Labels for known connection names. Text only: no feature reads these maps,
// and a name missing here falls back to a generic label with equal behaviour.
const SOURCE_KIND_LABELS: Record<string, string> = {
  "local-store": "ローカルデータに接続",
  "central-store": "中央保管庫に接続",
};
const SOURCE_KIND_NOTICES: Record<string, string> = {
  "local-store": "ローカルデータ",
  "central-store": "中央保管庫のデータ",
};

function isActive(navPath: string, currentPath: string): boolean {
  if (navPath === "/") return currentPath === "/";
  return currentPath === navPath || currentPath.startsWith(`${navPath}/`);
}

function View({ route }: { route: Route }): ReactNode {
  switch (route.name) {
    case "overview":
      return <OverviewPage />;
    case "transactions":
      return <TransactionsPage />;
    case "balances":
      return <BalancesPage />;
    case "summaries":
      return <BalancesPage view="summaries" />;
    case "positions":
      return <PositionsPage />;
    case "identities":
      return <IdentitiesPage />;
    case "rewards":
      return <RewardsPage />;
    case "artifacts":
      return <ArtifactsPage />;
    case "artifact":
      return <ArtifactDetailPage id={route.id} />;
    case "observation":
      return <ObservationDetailPage kind={route.kind} id={route.id} />;
    case "notFound":
      return <NotFoundPage path={route.path} />;
  }
}

export function App(): ReactNode {
  const route = useRoute();
  const path = usePath();
  const main = useRef<HTMLElement>(null);
  const previousPath = useRef(path);
  const metadata = useMetadata();
  const metadataReady = metadata.data !== undefined;
  useEffect(() => {
    const heading = main.current?.querySelector("h1");
    document.title = `${heading?.textContent ?? "記録と原本"} | kogane`;
    if (heading) {
      heading.tabIndex = -1;
      // Navigation starts reading at the new view. Refresh and typing never
      // move focus, and browser back/forward may restore their own scroll.
      if (previousPath.current !== path) heading.focus({ preventScroll: true });
      previousPath.current = path;
    }
  }, [path, metadataReady]);
  const client = useQueryClient();
  const fetching = useIsFetching() > 0;
  const connected = metadata.isSuccess;
  const classification = metadata.data?.source.classification;
  const synthetic = classification === "synthetic";
  // Feature decisions come from advertised capabilities only. `source.kind`
  // is a label: an unknown name gets the generic label and identical behaviour.
  const features = useFeatures();
  const connectionLabel = metadata.isPending
    ? "接続を確認中"
    : connected
      ? synthetic
        ? "デモデータに接続"
        : (SOURCE_KIND_LABELS[metadata.data?.source.kind ?? ""] ?? "保存された記録に接続")
      : "接続を確認できません";

  const evidenceRoute =
    features.evidenceHistory && (path === "/evidence" || path.startsWith("/runs/"));
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main">
        本文へ移動
      </a>
      <aside className="sidebar">
        <Link to="/" className="brand">
          <span className="brand-mark" aria-hidden="true">
            k
          </span>
          <span>
            <span className="brand-name">
              kogane<span className="brand-dot">.</span>
            </span>
            <span className="brand-sub">資産の記録を、たどる。</span>
          </span>
        </Link>
        <p className="nav-label">ライブラリ</p>
        <nav className="nav" aria-label="メインナビゲーション">
          {NAV.map((item) => (
            <Link key={item.to} to={item.to} current={isActive(item.to, path)}>
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d={item.icon} />
              </svg>
              <span>{item.label}</span>
            </Link>
          ))}
          {features.identities ? (
            <Link to="/identities" current={path === "/identities"}>
              口座・銘柄
            </Link>
          ) : null}
          {features.rewards ? (
            <Link to="/rewards" current={path === "/rewards"}>
              ポイント・前払式残高
            </Link>
          ) : null}
          {features.evidenceHistory ? (
            <Link to="/evidence" current={evidenceRoute}>
              取得履歴
            </Link>
          ) : null}
        </nav>
        <div className="sidebar-note">
          <span className="sidebar-note-symbol" aria-hidden="true">
            ↳
          </span>
          <strong>数字の先に、原本を。</strong>
          <p>取引や残高から、取得時の記録と保存された原本を確認できます。</p>
          <span className="read-only-label">閲覧専用</span>
        </div>
        <div className="sidebar-footer">
          KOGANE <span>EVIDENCE BROWSER</span>
        </div>
      </aside>
      <div className="workspace">
        <header className="workspace-bar">
          <div className="workspace-caption">
            マイライブラリ <span>/</span> 保存された記録
          </div>
          <button
            className="button refresh-button"
            disabled={fetching}
            onClick={() => {
              void client.invalidateQueries({ refetchType: "active" });
            }}
          >
            <span
              className={fetching ? "refresh-symbol is-refreshing" : "refresh-symbol"}
              aria-hidden="true"
            >
              ↻
            </span>
            {fetching ? "更新中…" : "表示を更新"}
          </button>
        </header>
        <div className="source-notice">
          <div className="source-identity">
            <span className={`connection-dot${connected ? " connected" : ""}`} aria-hidden="true" />
            <span role="status">{connectionLabel}</span>
          </div>
          <p>
            {metadata.data ? (
              synthetic ? (
                <>
                  <strong>デモデータ</strong>
                  <span className="notice-divider">·</span>
                  実際の取引・残高ではありません
                </>
              ) : classification === "financial" ? (
                <>
                  <strong>保存された実データ</strong>
                  <span className="notice-divider">·</span>
                  接続状態は収集結果やデータの新しさを表しません
                </>
              ) : (
                <>
                  <strong>
                    {SOURCE_KIND_NOTICES[metadata.data.source.kind] ?? "保存された記録"}
                  </strong>
                  <span className="notice-divider">·</span>
                  実データかどうか未確認
                </>
              )
            ) : (
              "データの種類は未確認です"
            )}
            {metadata.isError && metadata.data ? "（前回の接続情報）" : ""}
          </p>
        </div>
        <main id="main" ref={main} tabIndex={-1}>
          <ParsingHealthNotice health={metadata.data?.parsingHealth} />
          <QueryBoundary query={metadata} label="接続情報">
            {() => (
              <>
                {features.serverFilters &&
                ["transactions", "balances", "summaries", "positions", "artifacts"].includes(
                  route.name,
                ) ? (
                  <CollectionControls kind={route.name} />
                ) : null}
                {evidenceRoute ? (
                  <EvidenceContent observationsAvailable />
                ) : (
                  <View key={path + window.location.search} route={route} />
                )}
              </>
            )}
          </QueryBoundary>
        </main>
        <footer className="workspace-footer">
          <span>保存された証跡を、読み取り専用で表示しています。</span>
          <span>金融機関への接続・収集はこの画面から実行しません。</span>
        </footer>
      </div>
    </div>
  );
}
