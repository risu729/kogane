import { useEffect, useRef, type ReactNode } from "react";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import type {
  EvidenceArtifactId,
  EvidenceRunId,
} from "../../../packages/observation-shared/src/evidence-contract.ts";
import { useEvidenceMeta } from "./evidence-api.ts";
import { EvidenceBoundary } from "./evidence-ui.tsx";
import { EvidenceArtifactPage, EvidenceHistory, EvidenceRunPage } from "./pages/Evidence.tsx";
import { Link, usePath } from "./router.tsx";
import { AppShell, NAV_ICONS, type NavItem } from "./app-shell.tsx";
import { EmptyState } from "./ui.tsx";
import type { ApiMetadata } from "../../../packages/observation-shared/src/api-contract.ts";
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

  const navItems: NavItem[] = [
    ...(observationsAvailable
      ? [
          { to: "/", label: "ホーム", icon: NAV_ICONS.home, current: false },
          { to: "/transactions", label: "取引", icon: NAV_ICONS.transactions, current: false },
          { to: "/balances", label: "残高", icon: NAV_ICONS.balances, current: false },
          { to: "/positions", label: "保有資産", icon: NAV_ICONS.positions, current: false },
          { to: "/artifacts", label: "原本・証跡", icon: NAV_ICONS.artifacts, current: false },
        ]
      : []),
    {
      to: "/evidence",
      label: observationsAvailable ? "取得履歴" : "取得履歴・原本",
      icon: NAV_ICONS.evidence,
      current: route.kind === "history",
    },
  ];
  return (
    <AppShell
      tagline="保存された記録を、たどる。"
      navItems={navItems}
      note={{
        title: "記録と、その根拠。",
        body: "保存が完了した収集記録から、取得元の応答や収集内容を確認できます。",
      }}
      caption="保存された証跡"
      connection={{
        connected: metadata.isSuccess,
        label: metadata.isPending
          ? "接続を確認中"
          : metadata.isSuccess
            ? "中央保管庫に接続"
            : "接続を確認できません",
        detail: "接続状態は、収集結果やデータの新しさを表すものではありません。",
      }}
      refresh={{
        refreshing: fetching,
        onRefresh: () => {
          if (client.isFetching({ queryKey: ["evidence-v1"] }) > 0) return;
          void client.invalidateQueries({ queryKey: ["evidence-v1"], refetchType: "active" });
        },
      }}
      footer={[
        "保護された保存記録を、読み取り専用で表示しています。",
        "この画面から金融機関への接続・収集は実行しません。",
      ]}
      mainRef={main}
    >
      <ParsingHealthNotice health={parsingHealth} />
      <EvidenceContent observationsAvailable={observationsAvailable} />
    </AppShell>
  );
}
