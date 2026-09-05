// Read-only navigation. Connection metadata describes the API, not freshness
// of financial observations or whether a collector is currently running.

import { useEffect, useRef, type ReactNode } from "react";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { useMetadata } from "./api.ts";
import { Link, useRoute, usePath, type Route } from "./router.tsx";
import { OverviewPage } from "./pages/Overview.tsx";
import { TransactionsPage } from "./pages/Transactions.tsx";
import { BalancesPage } from "./pages/Balances.tsx";
import { PositionsPage } from "./pages/Positions.tsx";
import { ArtifactsPage } from "./pages/Artifacts.tsx";
import { ArtifactDetailPage } from "./pages/ArtifactDetail.tsx";
import { ObservationDetailPage } from "./pages/ObservationDetail.tsx";
import { NotFoundPage } from "./pages/NotFound.tsx";

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
  {
    to: "/artifacts",
    label: "原本・証跡",
    icon: "M5 3h9l5 5v13H5z M14 3v6h5 M9 13h6 M9 17h6",
  },
];

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
    case "positions":
      return <PositionsPage />;
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
  useEffect(() => {
    const heading = main.current?.querySelector("h1");
    document.title = `${heading?.textContent ?? "記録と原本"} | kogane`;
    if (heading) {
      heading.tabIndex = -1;
      // Navigation starts reading at the new view. Refresh and typing never
      // move focus, and browser back/forward may restore their own scroll.
      if (previousPath.current !== path) heading.focus({ preventScroll: true });
    }
    previousPath.current = path;
  }, [path]);
  const metadata = useMetadata();
  const client = useQueryClient();
  const fetching = useIsFetching() > 0;
  const connected = metadata.isSuccess;
  const synthetic = metadata.data?.source.classification === "synthetic";
  const connectionLabel = metadata.isPending
    ? "接続を確認中"
    : connected
      ? "ローカルデータに接続"
      : "接続を確認できません";

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
              ) : (
                <>
                  <strong>ローカルデータ</strong>
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
          <View route={route} />
        </main>
        <footer className="workspace-footer">
          <span>保存された証跡を、読み取り専用で表示しています。</span>
          <span>金融機関への接続・収集はこの画面から実行しません。</span>
        </footer>
      </div>
    </div>
  );
}
