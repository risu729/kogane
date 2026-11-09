<a id="sbi-vcトレード-read-only-web-gateway-poc"></a>

# `SBI VCトレード` (SBI VC Trade) read-only Web gateway PoC

This local PoC calls only read events confirmed in the public Web client, using an authenticated VCTRADE simple-mode session. It exposes no generic event sender, structurally preventing orders, cancellations, deposits/withdrawals, lending applications and authentication-setting changes available on the same `trade` gateway.

Captured data:

- `cashBalanceList`: JPY/cryptoasset balances.
- `accountMargin`: account details.
- `positionSummaryList`: held-position summary.
- `executionList`: execution history; calls `historical=false` 1 time on page 0, then paginates `historical=true`.
- `getCashflowList`: JPY deposit/withdrawal history; paginates only `historical=true`, as the current UI does.
- `tradeReportList`: report metadata list; no download event.

This PoC implements no login. Login needs a passkey or ID/password + MFA; the password path uses Cloudflare Turnstile. Session establishment and read replay are verified separately. A live test on 2026-08-31 successfully replayed directly in Bun with cookies and the Web client's `secureKey`. The session file contains only the cookies found necessary in that test (`vct_bff_sid`, `JSESSIONID`, `AWSALBAPP-0..3`, `AWSALB`, `AWSALBCORS`) and `secureKey`, outside Git with mode 600. The client does not send `__cf_bm`. Values go in neither shell arguments nor stdout. Reading opens the file once with `O_NOFOLLOW`, then checks regular-file status/mode and reads through the same descriptor, avoiding a TOCTOU replacement between path `stat` and reopening.

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
mise run install                                # from the repository root
mise run //packages/sbi-vc-trade-client:ci        # typecheck and test
bun src/cli.ts -- \
  --session-file /secure/sbi-vc-session.json \
  --output /secure/sbi-vc-output
```

The CLI writes only 1 JSON line to stdout/stderr: `{"status":"success","artifactCount":N}` on success, or `{"status":"failed","stage":…,"errorType":…}` on failure (also `httpStatus` for a gateway error). It emits no exception message, gateway-returned status string or response body (`src/run-cli.ts`).

Output contains real balances/history and is private; send it to neither commits, CI artifacts nor stdout. The output directory has mode 700 and every file has mode 600 from creation; existing files and symlinks are never overwritten. This local client neither refreshes sessions nor reauthenticates. Those responsibilities and periodic collection are separate in adjacent `services/collector-sbi-vc-trade`. Arbitrary date filters absent from the public UI are unimplemented rather than assigned a guessed format.

`tradeReportList` has only a typed method; it is excluded from default collection because the meanings of the current UI's statement types have not been verified without values. PDF/ZIP payload capture is unimplemented because whether it updates read status is unconfirmed.
