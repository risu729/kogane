// The frame both clients share: skip link, sidebar (brand, navigation, note,
// footer), workspace bar with the refresh button, connection notice, main
// column and footer. Callers decide the navigation, the copy and what the
// refresh button does; the shell only renders. Connection metadata describes
// the API, not freshness of financial observations or whether a collector is
// currently running.

import type { ReactNode, RefObject } from "react";
import { Link } from "./router.tsx";

/** One navigation entry. `icon` is a 24-viewbox stroke path. */
export type NavItem = {
  to: string;
  label: string;
  icon: string;
  current: boolean;
};

/** Stroke-only 24-viewbox paths, one per destination. */
export const NAV_ICONS = {
  home: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  transactions: "M4 7h16m-4-4 4 4-4 4 M20 17H4m4-4-4 4 4 4",
  balances: "M3 7h18v13H3z M3 7V4h15v3 M16 12h5v4h-5z",
  positions: "M4 21V11h4v10 M10 21V3h4v18 M16 21V7h4v14",
  summaries: "M5 3h14v18H5z M8 8h8 M8 12h8 M8 16h5",
  artifacts: "M5 3h9l5 5v13H5z M14 3v6h5 M9 13h6 M9 17h6",
  reconciliation: "M3 5h18v14H3z M3 10h18 M7 15h3 M14 15l2 2 4-4",
  identities: "M3 10l9-6 9 6 M5 10v9 M10 10v9 M14 10v9 M19 10v9 M3 19h18",
  rewards: "M12 4a8 8 0 1 0 0 16 8 8 0 1 0 0-16 M12 8v8 M9.5 10h5 M9.5 14h5",
  evidence: "M12 3a9 9 0 1 0 0 18 9 9 0 1 0 0-18 M12 7v5l3 2",
} as const;

export function AppShell({
  tagline,
  navItems,
  note,
  caption,
  connection,
  refresh,
  footer,
  mainRef,
  children,
}: {
  /** Line under the brand name. */
  tagline: string;
  navItems: readonly NavItem[];
  /** Sidebar note: a short title and one sentence. */
  note: { title: string; body: string };
  /** Second crumb of the workspace caption. */
  caption: string;
  /** Connection line: the dot, its status label, and the explanatory sentence. */
  connection: { connected: boolean; label: string; detail: ReactNode };
  /** The refresh button keeps its accessible name while refreshing; the
   * handler is expected to ignore clicks during a refresh. */
  refresh: { refreshing: boolean; onRefresh: () => void };
  footer: readonly [string, string];
  /** The caller moves focus to the heading inside `main` on navigation. */
  mainRef: RefObject<HTMLElement | null>;
  children: ReactNode;
}): ReactNode {
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
            <span className="brand-sub">{tagline}</span>
          </span>
        </Link>
        <p className="nav-label">ライブラリ</p>
        <nav className="nav" aria-label="メインナビゲーション">
          {navItems.map((item) => (
            <Link key={item.to} to={item.to} current={item.current}>
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
          <strong>{note.title}</strong>
          <p>{note.body}</p>
          <span className="read-only-label">閲覧専用</span>
        </div>
        <div className="sidebar-footer">
          KOGANE <span>EVIDENCE BROWSER</span>
        </div>
      </aside>
      <div className="workspace">
        <header className="workspace-bar">
          <div className="workspace-caption">
            マイライブラリ <span aria-hidden="true">/</span> {caption}
          </div>
          <button
            className="button refresh-button"
            aria-disabled={refresh.refreshing}
            onClick={refresh.onRefresh}
          >
            <span
              className={refresh.refreshing ? "refresh-symbol is-refreshing" : "refresh-symbol"}
              aria-hidden="true"
            >
              ↻
            </span>
            {refresh.refreshing ? "更新中…" : "表示を更新"}
          </button>
        </header>
        <div className="source-notice">
          <div className="source-identity">
            <span
              className={`connection-dot${connection.connected ? " connected" : ""}`}
              aria-hidden="true"
            />
            <span role="status">{connection.label}</span>
          </div>
          <p>{connection.detail}</p>
        </div>
        <main id="main" ref={mainRef} tabIndex={-1}>
          {children}
        </main>
        <footer className="workspace-footer">
          <span>{footer[0]}</span>
          <span>{footer[1]}</span>
        </footer>
      </div>
    </div>
  );
}
