# GLOBAL PASS PoC cleanup inventory

2026-08-29時点の検証資源を、削除範囲の誤りを避けるため3分類する。TAMIA Tunnelや他collectorと共有する資源は、このPoCのcleanupに含めない。

## 検証後すぐに整理できるもの

- Container instance identity `prestia-globalpass-read-only-v9`: 旧imageを保持していたため、2026-08-28に`destroy`済み。
- Container instance identity `prestia-globalpass-read-only-v10`: 2026-08-28に`destroy`済み。
- Container instance identity `prestia-globalpass-read-only-v11`: 2026-08-29に`destroy`済み。
- Container instance identity `prestia-globalpass-read-only-v12`: same-egress、Patchright、後付けCDP検証後、2026-08-29に`destroy`済み。
- Container instance identity `prestia-globalpass-read-only-v13`: 通常Chrome後付けCDPの直通検証後、2026-08-29に`destroy`済み。
- Container instance identity `prestia-globalpass-read-only-v14`: Windows fingerprintと直通egressの最終検証後、`stop`受理後もrunningだったため2026-08-29に`destroy`済み。
- 旧Container image `sha256:3035cabb81c0f7a70923cd5491a310406b31ef29e1f092397c28d2157276f2e5`: Xvfb wrapperによりport 8080をlistenできなかった検証image。
- 旧Container image `sha256:3027472193d263d31180ac600d87f230134a3d84407e2b97a2de63b3547be757`: diagnostic path sanitizer導入前の検証image。
- 旧Container image `sha256:35d493c8d276d9e6d58856fe4b132d5ec9a14cbc28f92118c48dc5fc50bb9c03`: Playwright同梱Chromiumだけを含む6条件目導入前のimage。
- local Docker image/tag `kogane-globalpass-collector-poc-globalpasscollectorcontainer:worker`: remote deployを検証し終えたら削除可能。
- Kuebiko raw capture `C:\Users\risu\AppData\Local\Kuebiko\captures\2026-08-27T21-46-51`: cookie等を含み得る。sanitized結果は本repoに記録済みなので、追加解析が不要になった時点で削除する。
- local admin token file `/home/risu/.local/share/kogane/secrets/globalpass-worker-admin-token`: PoCを操作しなくなった時点で削除する。
- `/home/risu/.docker/config.json`内のCloudflare registry認証entry: Wranglerが追加した可能性があるため確認して、不要ならそのentryだけを除去する。ファイル全体は他registry設定を含み得るため削除しない。
- このgit worktree: PRをmergeまたはcloseし、必要なcommitがremoteにあることを確認した後だけ削除可能。

## PoC全体を廃止するときに削除するもの

- Worker `kogane-globalpass-collector-poc`とworkers.dev deployment。
- Container app `kogane-globalpass-collector-poc-globalpasscollectorcontainer`（app ID `a03ac341-52a7-4e81-9a7c-279a90cc4b0c`）。
- 現行Container image `sha256:db2ea4549e95c40114e95648d625b498c6d0ed7095a6d05bbc6d56bd09709f6c`（Google Chrome Stable、Patchright、same-egress probe入り）と、registryに残る上記旧image。
- 2026-08-29追加検証の旧Container image `sha256:ac8dcc44bfcd5135dd60582ed801492f599735d4e45df63e4cf9416f108dded1`、`sha256:f3fe89e1590fce95edcca8b29dbb34aff3426b5cb39be88aedacb230e4dc284f`、およびそれ以前の現行imageだった`sha256:4933be0abc6397d74ec6f02b0e49a4a046daeda392962f7f28f3c3d41514c7c6`。
- Workerの公開診断endpoint `/egress`。既存Worker以外のresourceは作らず、Worker削除に従って消える。
- npm依存の`patchright`。別serviceや別registry resourceは作っていないため、repo/Container imageの削除だけで除去される。
- private R2 bucket `kogane-globalpass-collector-poc`。削除前にfailure manifestを残す必要がないことを確認する。
- Worker secrets `GLOBALPASS_ID`、`GLOBALPASS_PASSWORD`、`ADMIN_TRIGGER_TOKEN`、`RELAY_TOKEN`。
- Worker config内のBrowser Run binding `BROWSER`とTAMIA VPC binding。bindingを外すだけで、接続先Tunnel自体は削除しない。
- Cloudflareが保持するPoC Workerのversion/deployment history。Worker全体の削除に従わせ、個別versionを無理に消さない。

## このPoCのcleanupで削除してはいけないもの

- 共有TAMIA Tunnel `6b0ccf30-68b2-494e-baa8-f4f9f3e46b33`およびTAMIA側の`cloudflared`。
- 個人PCのWARP設定、既存hostname route、他のWorkerが使うVPC network。
- SBI証券、SMBCカード用Vpassなど、他collectorのWorker、R2、Queue、secret、Container image。

この検証ではCron、Queue、D1、新しいhostname routeを作成していないため、それらのcleanupは不要である。active image rolloutでは旧instanceが旧imageを保持する場合があるため、app/image削除前にContainer instanceをstopまたはdestroyしてから確認する。
