# GLOBAL PASS PoC cleanup inventory

2026-08-30時点の検証資源を、削除範囲の誤りを避けるため3分類する。TAMIA Tunnelや他collectorと共有する資源は、このPoCのcleanupに含めない。

## 検証後すぐに整理できるもの

- Container instance identity `prestia-globalpass-read-only-v9`: 旧imageを保持していたため、2026-08-28に`destroy`済み。
- Container instance identity `prestia-globalpass-read-only-v10`: 2026-08-28に`destroy`済み。
- Container instance identity `prestia-globalpass-read-only-v11`: 2026-08-29に`destroy`済み。
- Container instance identity `prestia-globalpass-read-only-v12`: same-egress、Patchright、後付けCDP検証後、2026-08-29に`destroy`済み。
- Container instance identity `prestia-globalpass-read-only-v13`: 通常Chrome後付けCDPの直通検証後、2026-08-29に`destroy`済み。
- Container instance identity `prestia-globalpass-read-only-v14`: Windows fingerprintと直通egressの最終検証後、`stop`受理後もrunningだったため2026-08-29に`destroy`済み。
- Container instance identity `prestia-globalpass-read-only-v15`: timezone collector v2検証後にstop/destroyを受理済み。Cloudflareのinstance一覧にはinactive recordが残るため、app削除時に消す。
- Container instance identity `prestia-globalpass-read-only-v16`: timezone collector v3検証用。destroy受理済みで、inactive recordはapp削除に従わせる。
- Container instance identities `prestia-globalpass-read-only-v17`: image rollout完了前に起動して旧v3 imageを保持したため、destroy受理済み。inactive recordはapp削除に従わせる。
- Container instance identity `prestia-globalpass-read-only-v18`: rollout完了後に起動した現行timezone collector v4。daily/backfill成功済みで、Workers Cronが使用するため保持する。
- 旧Container image `sha256:3035cabb81c0f7a70923cd5491a310406b31ef29e1f092397c28d2157276f2e5`: Xvfb wrapperによりport 8080をlistenできなかった検証image。
- 旧Container image `sha256:3027472193d263d31180ac600d87f230134a3d84407e2b97a2de63b3547be757`: diagnostic path sanitizer導入前の検証image。
- 旧Container image `sha256:35d493c8d276d9e6d58856fe4b132d5ec9a14cbc28f92118c48dc5fc50bb9c03`: Playwright同梱Chromiumだけを含む6条件目導入前のimage。
- local Docker image/tag `kogane-globalpass-collector-poc-globalpasscollectorcontainer:worker`: remote deployを検証し終えたら削除可能。
- 2026-08-30 font bind A/Bの一時Container、profile、font cache、Xvfb、SOCKS adapter、port 18083は停止・削除済み。追加imageとregistry pushはない。
- 2026-08-30 timezone A/Bの一時Container、profile、Chrome/Xvfb、SOCKS adapter、ports 11180/11181/9339/9340/8137/8138は停止・削除済み。
- Camoufox一時image `kogane-camoufox-probe-20260830:one-shot`（image ID `sha256:9eeca18798983968bb313685843b1f6d343bc02588cfe31656de164d732537f6`）、container、venv、browser bundle、profile、GeoIP DB、一時script、relay port 11089は削除・停止済み。registry pushはない。共有BuildKit cacheはpruneしていない。
- Kuebiko raw capture `C:\Users\risu\AppData\Local\Kuebiko\captures\2026-08-27T21-46-51`: cookie等を含み得る。sanitized結果は本repoに記録済みなので、追加解析が不要になった時点で削除する。
- 2026-08-29 local A/B用Windows profile `C:\Users\risu\AppData\Local\Kuebiko\browser-profile-globalpass-copy-win-20260829`と`browser-profile-globalpass-fresh-win-20260829`: 元profileは削除せず、この2個だけ追加解析後に削除する。
- 2026-08-29 local A/B用WSL profile `/home/risu/.local/share/kogane/browser-profile-globalpass-copy-wsl-20260829`と`browser-profile-globalpass-fresh-wsl-20260829`: 前者はWindows profileの約5 GiB copy。この2個だけ追加解析後に削除する。
- 2026-08-29 local A/B raw captures: Windowsの`2026-08-29T12-35-16`、`2026-08-29T12-53-00`、`2026-08-29T12-55-57`と、WSLの`2026-08-29T12-45-21`、`2026-08-29T12-51-54`。cookie等を含み得るためGitへ入れず、sanitized結果確認後に各capture directoryだけ削除する。
- 2026-08-29 fresh WSL login POST raw capture `/home/risu/.local/state/Kuebiko/captures/2026-08-29T13-08-05`: login cookieと認証POST由来の機密情報を含み得る。sanitized結果はrepoへ記録済みなので、追加解析後はこのdirectoryだけ削除する。
- 2026-08-30 same-runtime network A/B用WSL profile `/home/risu/.local/share/kogane/browser-profile-globalpass-wsl-tamia-20260830`と`/home/risu/.local/share/kogane/browser-profile-globalpass-wsl-warp-control-20260830`: どちらもfresh profile。sanitized結果確認後に各directoryだけ削除する。
- 2026-08-30同A/BのChrome log `/home/risu/.local/state/kogane-globalpass-wsl-tamia-20260830.log`と`/home/risu/.local/state/kogane-globalpass-wsl-warp-control-20260830.log`: token値・資格情報は記録していない。追加解析後にこの2 fileだけ削除する。
- 2026-08-30 Xvfb control用WSL profile `/home/risu/.local/share/kogane/browser-profile-globalpass-wsl-xvfb-tamia-20260830`とlog directory `/home/risu/.local/state/kogane-globalpass-xvfb-tamia-20260830`: token値・資格情報は記録していない。追加解析後にこのprofileとlog directoryだけ削除する。
- 2026-08-30 Turnstile body/Debugger比較用WSL profiles: `/home/risu/.local/share/kogane/browser-profile-globalpass-wsl-xvfb-tamia-payload-20260830`、`browser-profile-globalpass-wsl-xvfb-tamia-payload2-20260830`、`browser-profile-globalpass-wsl-xvfb-tamia-debugger-20260830`、`browser-profile-globalpass-wsl-xvfb-tamia-trace-20260830`、`browser-profile-globalpass-wsl-xvfb-tamia-vmtrace-20260830`、`browser-profile-globalpass-wsl-xvfb-tamia-vmtrace2-20260830`。各profileだけを追加解析完了後に削除する。
- 同比較のWSL state directories: `/home/risu/.local/state/kogane-globalpass-wsl-xvfb-tamia-payload-20260830`、`kogane-globalpass-wsl-xvfb-tamia-debugger-20260830`、`kogane-globalpass-wsl-xvfb-tamia-trace-20260830`、`kogane-globalpass-wsl-xvfb-tamia-vmtrace-20260830`、`kogane-globalpass-wsl-xvfb-tamia-vmtrace2-20260830`。Chrome/Xvfb processは停止済み。
- private raw comparison directory `/home/risu/.local/share/kogane/private/globalpass-turnstile/20260830`: POST body、response body、compile済みscript、sanitized reportを含む。資格情報入力とlogin POSTは行っていないが、challenge値を含むためGitへ入れず、追加解析が完了した時点でdirectory単位で削除する。
- temporary deobfuscation tools/reports `/tmp/kogane-turnstile-tools`、`/tmp/kogane-turnstile-index.json`、`/tmp/kogane-turnstile-comparison.json`、および明示的に作成したoutside-worktree pretty directory。private capture本体とは別に削除できる。
- 誤った旧worktree `/home/risu/codex-work/2026-08-27/kogane-globalpass-worker`内の同名untracked analyzer 5 files: 正しいPR worktreeへ反映済みなので、旧worktreeを破棄するときだけ削除する。
- 誤ってWindows側へ作成されていた`C:\home`は2026-08-30に監査し、14 fileすべてがWSL側より古い草稿でsecret/cookie/captureを含まず正本がGit/WSLにあることを確認して削除済み。cleanup対象には残っていない。
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
- Turnstile payload/Debugger比較profiles `/opt/kogane-globalpass-probe/profile-payload-tamia-20260830`、`profile-payload-tamia-debugger-20260830`
- 同比較のstate directories `/opt/kogane-globalpass-probe/state-payload-tamia-20260830`、`state-payload-tamia-debugger-20260830`
- private raw captures `/opt/kogane-globalpass-probe/private/turnstile-bots-xvfb-tamia-20260830.json`、`turnstile-bots-xvfb-tamia-debugger-20260830.json`と後者のgzip copy。Gitへ入れず、再比較用に保持する。
- sanitized probe scripts、`ws` dependency、Chrome/Xvfb logs (`/opt/kogane-globalpass-probe/app`, `logs`)

TAMIA比較に使うlocalhost SOCKS adapter processは検証後に停止済みで、port 11080も
listenしていない。relay tokenはstdinからmemoryへ渡し、`bots`のfileには保存していない。
再実行時だけ同processを起動し、終了後に停止する。

これらを後で削除する場合は、先に`bots`上で絶対pathとChrome processを再確認し、
`/opt/kogane-globalpass-probe`以外のOCI workloadへ影響しないことを確認する。

## PoC全体を廃止するときに削除するもの

- 現行app repository kogane-globalpass-collector-poc-globalpasscollectorcontainer の旧tags: 007215b4、0080b617、2444b612、4311cdf8、63148685、87f23407、8b4e8803、a220cfae、b8e96bd2、cb98569f、d86b50ae、f2585107、f6406948、f73b2bab、cd80a6ee、791950f1、bef74562、9fe9a176、790bbb11、92453ede。現行v4 registry tag `1cdfb2ea`はapp削除後に削除する。同じdigestを再利用したlocal tags `b9013549`と`45bc7bac`はWranglerがdeploy時にuntag済み。
- 旧standalone probe repository kogane-globalpass-container-probe-20260827-globalpassprobecontainer の全tags: 1068a298、57c4aa1c、73d5ead9、7c10d299、833aeb70、927ed319、9d7b1c69、ae9b6abc、c16fe4c8、c2e12ab7、c7f3e510、d1e7d4f5、ed0300e2、ee37d303、ee71d223。現行appから参照されていないが、このPoC全体を廃止するときだけ削除する。

- Worker `kogane-globalpass-collector-poc`とworkers.dev deployment。
- Container app `kogane-globalpass-collector-poc-globalpasscollectorcontainer`（app ID `a03ac341-52a7-4e81-9a7c-279a90cc4b0c`）。
- 現行Container image `sha256:831819f48420eec226601985df6b84e3a80d3948ae389dd2fbbd557d23eed0f3`（timezone collector v4）と、旧digests `sha256:db2ea4549e95c40114e95648d625b498c6d0ed7095a6d05bbc6d56bd09709f6c`、`sha256:7cd71344cc130d6b5e5c62a78743a8102daf07c0deb7ecd4a9e2428f55d2e863`、`sha256:c85e093a8a827821407fcba2fed849ea6558342fc103978846561cbc6f4192f7`、`sha256:c0bd4b80395580cf61eb8f6d34f5326a073e4191eda18064d47f5e5ecacdd501`、`sha256:c768879b72c2b88099fee38a139036142d4c43c6d0c8960a727deb11f52853af`を含むregistryの旧image。
- 2026-08-30 WSL local Docker A/Bの一時container `kogane-globalpass-wsl-ab-*`、port 8080/18080/18081/18082、Xvfb :93/:94、host SOCKS port 11080は全run終了後に停止・削除済み。新しいimage、profile、captureは作成していない。
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

この検証ではQueue、D1、新しいhostname routeを作成していないため、それらのcleanupは不要である。Workers Cron `17 18 * * *`はWorker削除に従って消えるが、PoCを残して定期収集だけ止める場合は`triggers.crons`を外してdeployする。active image rolloutでは旧instanceが旧imageを保持する場合があるため、app/image削除前にContainer instanceをstopまたはdestroyしてから確認する。

Container appの`max_instances`は2である。通常collectorは固定identity `v16`だけを使い、2枠目はimage rollout時に旧inactive instanceが枠を即時解放しない場合の入替用である。PoC廃止時はapp削除に従わせ、共有Tunnelの設定を変更しない。
