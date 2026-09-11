import type { ReactNode } from "react";
import { Link } from "../router.tsx";
const ROUTES = [
  { path: "/", label: "ホーム", description: "取得元と最近の収集状況" },
  { path: "/transactions", label: "取引", description: "入出金の記録を検索" },
  { path: "/balances", label: "残高", description: "口座ごとの残高と履歴" },
  {
    path: "/positions",
    label: "保有資産",
    description: "保有数量と取得元の評価額",
  },
  {
    path: "/artifacts",
    label: "原本",
    description: "保存された資料と解析の記録",
  },
];
export function NotFoundPage({ path }: { path: string }): ReactNode {
  return (
    <>
      <div className="page-head">
        <h1>ページが見つかりません</h1>
        <p className="lede">リンク先をご確認いただくか、下の一覧からお進みください。</p>
      </div>
      <section className="panel">
        <div className="panel-body">
          <ul>
            {ROUTES.map((route) => (
              <li key={route.path}>
                <Link to={route.path}>{route.label}</Link> — {route.description}
              </li>
            ))}
          </ul>
          <details className="detail-disclosure">
            <summary>指定されたページ</summary>
            <code>{path}</code>
          </details>
        </div>
      </section>
    </>
  );
}
