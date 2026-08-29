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
- 2026-08-29 local A/B用Windows profile `C:\Users\risu\AppData\Local\Kuebiko\browser-profile-globalpass-copy-win-20260829`と`browser-profile-globalpass-fresh-win-20260829`: 元profileは削除せず、この2個だけ追加解析後に削除する。
- 2026-08-29 local A/B用WSL profile `/home/risu/.local/share/kogane/browser-profile-globalpass-copy-wsl-20260829`と`browser-profile-globalpass-fresh-wsl-20260829`: 前者はWindows profileの約5 GiB copy。この2個だけ追加解析後に削除する。
- 2026-08-29 local A/B raw captures: Windowsの`2026-08-29T12-35-16`、`2026-08-29T12-53-00`、`2026-08-29T12-55-57`と、WSLの`2026-08-29T12-45-21`、`2026-08-29T12-51-54`。cookie等を含み得るためGitへ入れず、sanitized結果確認後に各capture directoryだけ削除する。
- 2026-08-29 fresh WSL login POST raw capture `/home/risu/.local/state/Kuebiko/captures/2026-08-29T13-08-05`: login cookieと認証POST由来の機密情報を含み得る。sanitized結果はrepoへ記録済みなので、追加解析後はこのdirectoryだけ削除する。
- 2026-08-30 same-runtime network A/B用WSL profile `/home/risu/.local/share/kogane/browser-profile-globalpass-wsl-tamia-20260830`と`/home/risu/.local/share/kogane/browser-profile-globalpass-wsl-warp-control-20260830`: どちらもfresh profile。sanitized結果確認後に各directoryだけ削除する。
- 2026-08-30同A/BのChrome log `/home/risu/.local/state/kogane-globalpass-wsl-tamia-20260830.log`と`/home/risu/.local/state/kogane-globalpass-wsl-warp-control-20260830.log`: token値・資格情報は記録していない。追加解析後にこの2 fileだけ削除する。
- local admin token file `/home/risu/.local/share/kogane/secrets/globalpass-worker-admin-token`: PoCを操作しなくなった時点で削除する。
- `/home/risu/.docker/config.json`内のCloudflare registry認証entry: Wranglerが追加した可能性があるため確認して、不要ならそのentryだけを除去する。ファイル全体は他registry設定を含み得るため削除しない。
- このgit worktree: PRをmergeまたはcloseし、必要なcommitがremoteにあることを確認した後だけ削除可能。

## 現在は保持するOCI `bots`検証資源

2026-08-30の指示により、次の資源は検証後も削除しない。Chrome/Xvfb processは各runの
終了時に停止するが、package、runtime、profile、script、logは再比較用に保持する。

- probe root `/opt/kogane-globalpass-probe`
- official Google Chrome Stable 152.0.7977.64 ARM64
- Xvfb、Noto CJK font
- Node.js 24.20.0 ARM64 (`/opt/kogane-globalpass-probe/node`)
- OCI fresh profile `/opt/kogane-globalpass-probe/profile`
- local WSL成功profileのcopy `/opt/kogane-globalpass-probe/profile-from-wsl-20260829`
- SwiftShader比較profile `/opt/kogane-globalpass-probe/profile-swiftshader`
- TAMIA relay比較profile `/opt/kogane-globalpass-probe/profile-tamia-swiftshader`
- sanitized probe scripts、`ws` dependency、Chrome/Xvfb logs (`/opt/kogane-globalpass-probe/app`, `logs`)

TAMIA比較に使うlocalhost SOCKS adapter processは検証後に停止済みで、port 11080も
listenしていない。relay tokenはstdinからmemoryへ渡し、`bots`のfileには保存していない。
再実行時だけ同processを起動し、終了後に停止する。

これらを後で削除する場合は、先に`bots`上で絶対pathとChrome processを再確認し、
`/opt/kogane-globalpass-probe`以外のOCI workloadへ影響しないことを確認する。

## PoC全体を廃止するときに削除するもの

- 現行app repository kogane-globalpass-collector-poc-globalpasscollectorcontainer の旧tags: 007215b4、0080b617、2444b612、4311cdf8、63148685、87f23407、8b4e8803、a220cfae、b8e96bd2、cb98569f、d86b50ae、f2585107、f6406948、f73b2bab。現行cd80a6eeはapp削除後に削除する。
- 旧standalone probe repository kogane-globalpass-container-probe-20260827-globalpassprobecontainer の全tags: 1068a298、57c4aa1c、73d5ead9、7c10d299、833aeb70、927ed319、9d7b1c69、ae9b6abc、c16fe4c8、c2e12ab7、c7f3e510、d1e7d4f5、ed0300e2、ee37d303、ee71d223。現行appから参照されていないが、このPoC全体を廃止するときだけ削除する。

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
