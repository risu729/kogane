import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { getJson } from "./api.ts";
import { navigate, useLocation } from "./router.tsx";
import { QueryBoundary } from "./ui.tsx";
import type { FilterOptions } from "../../shared/api-contract.ts";

export function CollectionControls({ kind }: { kind: string }) {
  const location = useLocation();
  const params = new URLSearchParams(location.split("?")[1]);
  const source = params.get("source") ?? "";
  const account = params.get("account") ?? "";
  const [draft, setDraft] = useState({
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
    q: params.get("q") ?? "",
  });
  useEffect(() => {
    const current = new URLSearchParams(location.split("?")[1]);
    setDraft({
      from: current.get("from") ?? "",
      to: current.get("to") ?? "",
      q: current.get("q") ?? "",
    });
  }, [location]);
  const invalidDates = Boolean(draft.from && draft.to && draft.from > draft.to);
  const options = useQuery({
    queryKey: ["filter-options", kind],
    queryFn: ({ signal }) => getJson<FilterOptions>(`/api/filter-options?kind=${kind}`, signal),
  });
  function change(source: string, account: string) {
    const next = new URLSearchParams(params);
    for (const key of ["source", "account", "offset", "latestOffset", "cursor"]) next.delete(key);
    if (source) next.set("source", source);
    if (account) next.set("account", account);
    navigate(`/${kind}${next.size ? `?${next}` : ""}`);
  }
  function field(key: string, value: string) {
    const next = new URLSearchParams(params);
    for (const page of ["offset", "latestOffset", "cursor"]) next.delete(page);
    if (value) next.set(key, value);
    else next.delete(key);
    navigate(`/${kind}${next.size ? `?${next}` : ""}`);
  }
  return (
    <QueryBoundary query={options} label="全記録の絞り込み">
      {(data) => (
        <section className="panel-body" aria-label="全記録の絞り込み">
          <p>保存された全記録から絞り込み、500件ずつ読み込みます。</p>
          <div className="filter-grid">
            <label className="filter-field">
              取得元
              <select
                aria-label="全記録の取得元"
                value={source}
                onChange={(event) => change(event.target.value, "")}
              >
                <option value="">すべての取得元</option>
                {data.sources.map((id) => (
                  <option key={id}>{id}</option>
                ))}
              </select>
            </label>
            {kind !== "artifacts" ? (
              <label className="filter-field">
                口座
                <select
                  aria-label="全記録の口座"
                  value={account ? JSON.stringify([source, account]) : ""}
                  onChange={(event) => {
                    if (!event.target.value) change(source, "");
                    else {
                      const [selectedSource, selectedAccount] = JSON.parse(event.target.value) as [
                        string,
                        string,
                      ];
                      change(selectedSource, selectedAccount);
                    }
                  }}
                >
                  <option value="">すべての口座</option>
                  {data.accounts
                    .filter((row) => !source || row.source_id === source)
                    .map((row) => (
                      <option
                        key={JSON.stringify([row.source_id, row.source_account])}
                        value={JSON.stringify([row.source_id, row.source_account])}
                      >
                        {row.display_name ? `${row.display_name} · ` : ""}
                        {row.source_account} · {row.source_id}
                        {row.organization_ambiguous ? "（複数の整理区分）" : ""}
                      </option>
                    ))}
                </select>
              </label>
            ) : null}
            {kind === "balances"
              ? (
                  [
                    ["instrument", "通貨・単位", data.instruments ?? []],
                    ["metric", "残高の種類", data.metrics ?? []],
                  ] as const
                ).map(([key, label, values]) => (
                  <label className="filter-field" key={key}>
                    {label}
                    <select
                      value={params.get(key) ?? ""}
                      onChange={(event) => field(key, event.target.value)}
                    >
                      <option value="">すべて</option>
                      {values.map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                  </label>
                ))
              : null}
          </div>
          {kind === "transactions" ? (
            <form
              className="filter-grid"
              onSubmit={(event) => {
                event.preventDefault();
                if (invalidDates) return;
                const next = new URLSearchParams(params);
                next.delete("offset");
                for (const [key, value] of Object.entries(draft)) {
                  if (value) next.set(key, value);
                  else next.delete(key);
                }
                navigate(`/${kind}${next.size ? `?${next}` : ""}`);
              }}
            >
              <label className="filter-field">
                開始日
                <input
                  type="date"
                  value={draft.from}
                  aria-invalid={invalidDates || undefined}
                  onChange={(event) => setDraft({ ...draft, from: event.target.value })}
                />
              </label>
              <label className="filter-field">
                終了日
                <input
                  type="date"
                  value={draft.to}
                  aria-invalid={invalidDates || undefined}
                  onChange={(event) => setDraft({ ...draft, to: event.target.value })}
                />
              </label>
              <label className="filter-field">
                内容を検索
                <input
                  type="search"
                  value={draft.q}
                  onChange={(event) => setDraft({ ...draft, q: event.target.value })}
                />
              </label>
              <button className="button" type="submit" disabled={invalidDates}>
                検索条件を適用
              </button>
              {invalidDates ? <p role="alert">開始日を終了日以前にしてください。</p> : null}
            </form>
          ) : null}
          {params.size ? (
            <button className="button" onClick={() => navigate(`/${kind}`)}>
              条件をクリア
            </button>
          ) : null}
          {params.has("offset") || params.has("cursor") || params.has("latestOffset") ? (
            <button className="button" onClick={() => change(source, account)}>
              最初のページへ
            </button>
          ) : null}
        </section>
      )}
    </QueryBoundary>
  );
}
