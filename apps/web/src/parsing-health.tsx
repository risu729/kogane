import type { ApiMetadata } from "../../shared/api-contract.ts";

export function parsingHealthMessage(health: ApiMetadata["parsingHealth"]): string | null {
  if (!health || health.pending + health.running + health.failed === 0) return null;
  return `解析待ち ${health.pending}件・解析中 ${health.running}件・解析失敗 ${health.failed}件。取引・残高・保有資産の表示には未反映の記録があります。これらは登録済みの解析処理の件数で、収集の成否やデータの新しさを示しません。`;
}

export function ParsingHealthNotice({ health }: { health: ApiMetadata["parsingHealth"] }) {
  const message = parsingHealthMessage(health);
  return message ? (
    <div className="query-notice query-warning" role="status">
      {message}
    </div>
  ) : null;
}
