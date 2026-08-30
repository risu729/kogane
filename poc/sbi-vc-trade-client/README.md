# SBI VCトレード read-only Web gateway PoC

認証済みのVCTRADEシンプルモードsessionから、公開Web clientで確認した4つのread eventだけを呼ぶローカルPoCである。generic event senderを公開せず、同じ`trade` gatewayに存在する注文、取消、入出金、貸コイン申込、認証設定変更を構造的に送信できないようにしている。

収集対象:

- `cashBalanceList`: 日本円・暗号資産の残高
- `accountMargin`: 口座詳細
- `positionSummaryList`: 保有ポジションsummary
- `executionList`: 約定履歴。page 0で`historical=false`を1回、`historical=true`をpagination
- `getCashflowList`: 日本円の入出金履歴。現行UIと同じ`historical=true`だけをpagination
- `tradeReportList`: 報告書metadata一覧。download eventは含めない

このPoCはloginを実装しない。loginにはCloudflare TurnstileとpasskeyまたはID/password + MFAが必要で、認証済みsessionの成立とread replayを分離して検証するためである。session fileは一時的なCookie headerとWeb clientの`secureKey`だけを持ち、Git外・mode 600で用意する。値をshell引数や標準出力へ置かない。

```json
{
  "cookieHeader": "REDACTED",
  "secureKey": "REDACTED"
}
```

```sh
chmod 600 /secure/sbi-vc-session.json
bun install --frozen-lockfile
bun test
bun run typecheck
bun run collect -- \
  --session-file /secure/sbi-vc-session.json \
  --output /secure/sbi-vc-output
```

outputは実残高・履歴を含むためprivateであり、commit、CI artifact、stdout、Cloudflareへ送らない。session fileを別hostへ移送する設計でもない。session timeout、Cookieと`secureKey`の対応、Cloudflareが直接HTTP replayを許すかはlive検証前の未確認事項である。公開UIが送らない任意date filterはformatを推測せず実装していない。

`tradeReportList`はtyped methodだけを用意し、現行UIが使うstatement typeの意味を値なしで検証できていないためdefault collectionへ入れていない。PDF/ZIP payload取得はread statusを更新する可能性が未確認なので実装しない。
