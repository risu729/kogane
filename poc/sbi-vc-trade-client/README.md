# SBI VCトレード read-only Web gateway PoC

認証済みのVCTRADEシンプルモードsessionから、公開Web clientで確認したread eventだけを呼ぶローカルPoCである。generic event senderを公開せず、同じ`trade` gatewayに存在する注文、取消、入出金、貸コイン申込、認証設定変更を構造的に送信できないようにしている。

収集対象:

- `cashBalanceList`: 日本円・暗号資産の残高
- `accountMargin`: 口座詳細
- `positionSummaryList`: 保有ポジションsummary
- `executionList`: 約定履歴。page 0で`historical=false`を1回、`historical=true`をpagination
- `getCashflowList`: 日本円の入出金履歴。現行UIと同じ`historical=true`だけをpagination
- `tradeReportList`: 報告書metadata一覧。download eventは含めない

このPoCはloginを実装しない。loginにはpasskeyまたはID/password + MFAが必要で、password経路はCloudflare Turnstileを使う。認証済みsessionの成立とread replayを分離して検証するためである。2026-08-31のlive試験ではCookie + Web clientの`secureKey`をBunへ渡す直接replayに成功した。session fileは実測で必要だった`vct_bff_sid`、`JSESSIONID`、`AWSALBAPP-0..3`、`AWSALB`、`AWSALBCORS`と`secureKey`だけを持ち、Git外・mode 600で用意する。clientは`__cf_bm`を送信しない。値をshell引数や標準出力へ置かない。読み取り時は`O_NOFOLLOW`で一度だけfileを開き、同じdescriptorでregular-file/mode検査とreadを行うため、pathの`stat`と再openの間に差し替えられるTOCTOUを作らない。

```json
{
  "cookies": {
    "vctBffSid": "REDACTED",
    "jSessionId": "REDACTED",
    "awsAlbApp": ["REDACTED", "REDACTED", "REDACTED", "REDACTED"],
    "awsAlb": "REDACTED",
    "awsAlbCors": "REDACTED"
  },
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

outputは実残高・履歴を含むためprivateであり、commit、CI artifact、stdoutへ送らない。出力directoryはmode 700、各fileは作成時からmode 600とし、既存fileやsymlinkを上書きしない。このlocal client自身はsession更新や再認証を行わない。それらと定期収集は隣接する`poc/sbi-vc-trade-worker`へ分離している。公開UIが送らない任意date filterはformatを推測せず実装していない。

`tradeReportList`はtyped methodだけを用意し、現行UIが使うstatement typeの意味を値なしで検証できていないためdefault collectionへ入れていない。PDF/ZIP payload取得はread statusを更新する可能性が未確認なので実装しない。
