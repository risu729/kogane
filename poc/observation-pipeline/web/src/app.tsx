// The shell: a masthead whose links mirror the API's own URL space, and one
// view per route. There is no state here beyond the current path — every page
// reads what it shows from the API on the request that renders it.

import type { ReactNode } from "react";
import { Link, useRoute, usePath, type Route } from "./router.tsx";
import { OverviewPage } from "./pages/Overview.tsx";
import { TransactionsPage } from "./pages/Transactions.tsx";
import { BalancesPage } from "./pages/Balances.tsx";
import { PositionsPage } from "./pages/Positions.tsx";
import { ArtifactsPage } from "./pages/Artifacts.tsx";
import { ArtifactDetailPage } from "./pages/ArtifactDetail.tsx";
import { ObservationDetailPage } from "./pages/ObservationDetail.tsx";
import { NotFoundPage } from "./pages/NotFound.tsx";

const NAV: { to: string; label: string }[] = [
  { to: "/", label: "overview" },
  { to: "/transactions", label: "transactions" },
  { to: "/balances", label: "balances" },
  { to: "/positions", label: "positions" },
  { to: "/artifacts", label: "artifacts" },
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

  return (
    <>
      <header className="masthead">
        <div className="masthead-inner">
          <Link to="/" className="brand">
            <span className="brand-name">kogane</span>
            <span className="brand-sub">evidence browser</span>
          </Link>
          <nav className="nav" aria-label="Views">
            {NAV.map((item) => (
              <Link key={item.to} to={item.to} current={isActive(item.to, path)}>
                {item.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>
      <main id="main">
        <View route={route} />
      </main>
    </>
  );
}
