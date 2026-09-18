// Read-only navigation. Connection metadata describes the API, not freshness
// of financial observations or whether a collector is currently running.

import { useEffect, useRef, type ReactNode } from "react";
import { useIsFetching, useQueryClient } from "@tanstack/react-query";
import { useFeatures, useMetadata } from "./api.ts";
import { QueryBoundary } from "./ui.tsx";
import { useRoute, usePath, type Route } from "./router.tsx";
import { AppShell, NAV_ICONS, type NavItem } from "./app-shell.tsx";
import type { ClientFeatures } from "./capabilities.ts";
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
import { ConfirmPage } from "./pages/Confirm.tsx";
import { CardOwnershipPage } from "./pages/CardOwnership.tsx";
import { ReconciliationPage } from "./pages/Reconciliation.tsx";

// Every destination in one list. A `feature` entry is shown only while the
// API advertises that capability; the others are always present.
const NAV: { to: string; label: string; icon: string; feature?: keyof ClientFeatures }[] = [
  { to: "/", label: "ホーム", icon: NAV_ICONS.home },
  { to: "/transactions", label: "取引", icon: NAV_ICONS.transactions },
  { to: "/balances", label: "残高", icon: NAV_ICONS.balances },
  { to: "/positions", label: "保有資産", icon: NAV_ICONS.positions },
  { to: "/summaries", label: "期間実績・請求", icon: NAV_ICONS.summaries },
  { to: "/artifacts", label: "原本・証跡", icon: NAV_ICONS.artifacts },
  {
    to: "/reconciliation",
    label: "カード照合",
    icon: NAV_ICONS.reconciliation,
    feature: "cardSettlementReconciliation",
  },
  { to: "/identities", label: "口座・銘柄", icon: NAV_ICONS.identities, feature: "identities" },
  { to: "/rewards", label: "ポイント・前払式残高", icon: NAV_ICONS.rewards, feature: "rewards" },
  { to: "/evidence", label: "取得履歴", icon: NAV_ICONS.evidence, feature: "evidenceHistory" },
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
    case "cardOwnership":
      return <CardOwnershipPage key={route.proposalId} proposalId={route.proposalId} />;
    case "reconciliation":
      return <ReconciliationPage />;
    case "artifacts":
      return <ArtifactsPage />;
    case "artifact":
      return <ArtifactDetailPage id={route.id} />;
    case "observation":
      return <ObservationDetailPage kind={route.kind} id={route.id} />;
    case "confirm":
      return <ConfirmPage key={route.planId} planId={route.planId} />;
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
    // Content is mounted only after metadata resolves; defer focus until then.
    const heading = metadataReady ? main.current?.querySelector("h1") : null;
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
  const classification = metadata.data?.source.classification;
  const synthetic = classification === "synthetic";
  const connected = metadata.isSuccess && !synthetic;
  // Feature decisions come from advertised capabilities only. `source.kind`
  // is a label: an unknown name gets the generic label and identical behaviour.
  const features = useFeatures();
  const connectionLabel = metadata.isPending
    ? "接続を確認中"
    : synthetic
      ? "表示対象の記録がありません"
      : connected
        ? (SOURCE_KIND_LABELS[metadata.data?.source.kind ?? ""] ?? "保存された記録に接続")
        : "接続を確認できません";

  const evidenceRoute =
    features.evidenceHistory && (path === "/evidence" || path.startsWith("/runs/"));
  const navItems: NavItem[] = NAV.filter((item) => !item.feature || features[item.feature]).map(
    (item) => ({
      to: item.to,
      label: item.label,
      icon: item.icon,
      current: item.to === "/evidence" ? evidenceRoute : isActive(item.to, path),
    }),
  );
  return (
    <AppShell
      tagline="資産の記録を、たどる。"
      navItems={navItems}
      note={{
        title: "数字の先に、原本を。",
        body: "取引や残高から、取得時の記録と保存された原本を確認できます。",
      }}
      caption="保存された記録"
      connection={{
        connected,
        label: connectionLabel,
        detail: (
          <>
            {metadata.data ? (
              synthetic ? (
                "この接続先のデータは表示できません"
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
          </>
        ),
      }}
      refresh={{
        refreshing: fetching,
        onRefresh: () => {
          if (client.isFetching() > 0) return;
          void client.invalidateQueries({ refetchType: "active" });
        },
      }}
      footer={[
        "原本を保持し、確認・訂正の履歴を記録します。",
        "金融機関への接続・収集はこの画面から実行しません。",
      ]}
      mainRef={main}
    >
      {!synthetic ? <ParsingHealthNotice health={metadata.data?.parsingHealth} /> : null}
      <QueryBoundary query={metadata} label="接続情報">
        {() =>
          synthetic ? (
            <section>
              <h1>表示対象の記録がありません</h1>
              <p>接続先を確認してください。</p>
            </section>
          ) : (
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
          )
        }
      </QueryBoundary>
    </AppShell>
  );
}
