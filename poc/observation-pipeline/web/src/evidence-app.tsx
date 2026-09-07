import { useEffect, useRef, type ReactNode } from "react";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import type { EvidenceArtifactId, EvidenceRunId } from "../../shared/evidence-contract.ts";
import { useEvidenceMeta } from "./evidence-api.ts";
import { EvidenceBoundary } from "./evidence-ui.tsx";
import { EvidenceArtifactPage, EvidenceHistory, EvidenceRunPage } from "./pages/Evidence.tsx";
import { Link, usePath } from "./router.tsx";
import { EmptyState } from "./ui.tsx";
import type { ApiMetadata } from "../../shared/api-contract.ts";
import { ParsingHealthNotice } from "./parsing-health.tsx";

function routeFor(path: string) {
  const artifact = /^\/runs\/(r_[1-9]\d*)\/artifacts\/(a_[1-9]\d*)$/u.exec(path);
  if (artifact)
    return {
      kind: "artifact" as const,
      runId: artifact[1] as EvidenceRunId,
      artifactId: artifact[2] as EvidenceArtifactId,
      title: "ファイルの詳細",
    };
  const run = /^\/runs\/(r_[1-9]\d*)$/u.exec(path);
  if (run) return { kind: "run" as const, runId: run[1] as EvidenceRunId, title: "収集記録の詳細" };
  return path === "/" || path === "/evidence"
    ? { kind: "history" as const, title: "取得履歴と原本" }
    : { kind: "missing" as const, title: "ページが見つかりません" };
}

/** Route content only. Production keeps App's navigation, refresh and connection shell. */
export function EvidenceContent({
  observationsAvailable = false,
}: {
  observationsAvailable?: boolean;
}): ReactNode {
  const route = routeFor(usePath());
  const metadata = useEvidenceMeta();
  return (
    <>
      {route.kind !== "history" ? (
        <nav className="breadcrumb" aria-label="現在の位置">
          <Link to="/evidence">取得履歴</Link>
          {route.kind === "artifact" ? (
            <>
              {" "}
              / <Link to={`/runs/${route.runId}`}>収集記録</Link>
            </>
          ) : null}
        </nav>
      ) : null}
      <div className="page-head">
        <h1>{route.title}</h1>
        <p className="lede">保存済みの記録と、取得時に残されたファイルを確認できます。</p>
      </div>
      <EvidenceBoundary query={metadata} label="取得履歴の接続情報">
        {(meta) => (
          <>
            {!observationsAvailable && !meta.capabilities.parsedObservations ? (
              <p className="query-notice">
                この画面は原本・証跡の閲覧用です。取引・残高としての解析結果はまだ提供していません。
              </p>
            ) : null}
            {route.kind === "history" ? (
              <EvidenceHistory sources={meta.sources} />
            ) : route.kind === "run" ? (
              <EvidenceRunPage key={route.runId} runId={route.runId} sources={meta.sources} />
            ) : route.kind === "artifact" ? (
              <EvidenceArtifactPage
                key={`${route.runId}/${route.artifactId}`}
                runId={route.runId}
                artifactId={route.artifactId}
                sources={meta.sources}
              />
            ) : (
              <EmptyState>
                このURLに対応するページはありません。<Link to="/evidence">取得履歴へ戻る</Link>
              </EmptyState>
            )}
          </>
        )}
      </EvidenceBoundary>
    </>
  );
}

export function EvidenceApp({
  parsingHealth,
  observationsAvailable = false,
}: {
  parsingHealth?: ApiMetadata["parsingHealth"];
  observationsAvailable?: boolean;
} = {}): ReactNode {
  const path = usePath();
  const route = routeFor(path);
  const metadata = useEvidenceMeta();
  const client = useQueryClient();
  const fetching = useIsFetching({ queryKey: ["evidence-v1"] }) > 0;
  const main = useRef<HTMLElement>(null);
  const previous = useRef(path);
  useEffect(() => {
    document.title = `${route.title} | kogane`;
    const heading = main.current?.querySelector("h1");
    if (heading) {
      heading.tabIndex = -1;
      if (previous.current !== path) heading.focus({ preventScroll: true });
    }
    previous.current = path;
  }, [path, route.title]);

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
            <span className="brand-sub">保存された記録を、たどる。</span>
          </span>
        </Link>
        <p className="nav-label">ライブラリ</p>
        <nav className="nav" aria-label="メインナビゲーション">
          {observationsAvailable ? (
            <>
              <Link to="/">ホーム</Link>
              <Link to="/transactions">取引</Link>
              <Link to="/balances">残高</Link>
              <Link to="/positions">保有資産</Link>
              <Link to="/artifacts">原本・証跡</Link>
            </>
          ) : null}
          <Link to="/evidence" current={route.kind === "history"}>
            {observationsAvailable ? "取得履歴" : "取得履歴・原本"}
          </Link>
        </nav>
        <div className="sidebar-note">
          <strong>記録と、その根拠。</strong>
          <p>保存が完了した収集記録から、取得元の応答や収集内容を確認できます。</p>
          <span className="read-only-label">閲覧専用</span>
        </div>
        <div className="sidebar-footer">
          KOGANE <span>EVIDENCE BROWSER</span>
        </div>
      </aside>
      <div className="workspace">
        <header className="workspace-bar">
          <div className="workspace-caption">
            マイライブラリ <span>/</span> 保存された証跡
          </div>
          <button
            className="button refresh-button"
            disabled={fetching}
            onClick={() => {
              void client.invalidateQueries({ queryKey: ["evidence-v1"], refetchType: "active" });
            }}
          >
            {fetching ? "更新中…" : "表示を更新"}
          </button>
        </header>
        <div className="source-notice">
          <div className="source-identity">
            <span
              className={`connection-dot${metadata.isSuccess ? " connected" : ""}`}
              aria-hidden="true"
            />
            <span role="status">
              {metadata.isPending
                ? "接続を確認中"
                : metadata.isSuccess
                  ? "中央保管庫に接続"
                  : "接続を確認できません"}
            </span>
          </div>
          <p>接続状態は、収集結果やデータの新しさを表すものではありません。</p>
        </div>
        <main id="main" ref={main} tabIndex={-1}>
          <ParsingHealthNotice health={parsingHealth} />
          <EvidenceContent observationsAvailable={observationsAvailable} />
        </main>
        <footer className="workspace-footer">
          <span>保護された保存記録を、読み取り専用で表示しています。</span>
          <span>この画面から金融機関への接続・収集は実行しません。</span>
        </footer>
      </div>
    </div>
  );
}
