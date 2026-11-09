# GLOBAL PASS PoC cleanup inventory

Verification resources as of 2026-08-30 are grouped into 3 categories to avoid removing the wrong resources. TAMIA Tunnel and resources shared with other collectors are excluded from this PoC's cleanup.

<a id="検証後すぐに整理できるもの"></a>

## Items that can be cleaned up immediately after verification

- Container instance identity `prestia-globalpass-read-only-v9`: `destroy` completed on 2026-08-28 because it retained an old image.
- Container instance identity `prestia-globalpass-read-only-v10`: `destroy` completed on 2026-08-28.
- Container instance identity `prestia-globalpass-read-only-v11`: `destroy` completed on 2026-08-29.
- Container instance identity `prestia-globalpass-read-only-v12`: `destroy` completed on 2026-08-29 after same-egress, Patchright and delayed-CDP verification.
- Container instance identity `prestia-globalpass-read-only-v13`: `destroy` completed on 2026-08-29 after ordinary-Chrome delayed-CDP direct-egress verification.
- Container instance identity `prestia-globalpass-read-only-v14`: remained running after accepted `stop`; `destroy` completed on 2026-08-29 after final Windows-fingerprint/direct-egress verification.
- Container instance identity `prestia-globalpass-read-only-v15`: stop/destroy accepted after timezone collector v2 verification. Cloudflare retains an inactive instance-list record; remove it with the app.
- Container instance identity `prestia-globalpass-read-only-v16`: used for timezone collector v3 verification. Destroy accepted; leave its inactive record for app removal.
- Container instance identities `prestia-globalpass-read-only-v17`: destroy accepted because startup before image-rollout completion retained the old v3 image. Leave its inactive record for app removal.
- Container instance identity `prestia-globalpass-read-only-v18`: succeeded in daily/backfill with v4 and Chrome control/corrected daily with v5. `destroy` completed on 2026-08-31 because old v5 restarted after HTTP CONNECT rollout.
- Container instance identity `prestia-globalpass-read-only-v19`: current identity used by Workers Cron and the HTTP CONNECT version. Confirmed destroyed with `destroy()` and returned to inactive after daily success on 2026-08-31.
- Container instance identity `prestia-globalpass-chromium-timezone-probe-v1`: A/B-only identity replacing just the binary with Playwright-bundled Chromium under final successful conditions. Destroyed after 3 runs; leave its inactive record for app removal.
- Old Container image `sha256:3035cabb81c0f7a70923cd5491a310406b31ef29e1f092397c28d2157276f2e5`: verification image unable to listen on port 8080 because of the Xvfb wrapper.
- Old Container image `sha256:3027472193d263d31180ac600d87f230134a3d84407e2b97a2de63b3547be757`: verification image before the diagnostic-path sanitizer.
- Old Container image `sha256:35d493c8d276d9e6d58856fe4b132d5ec9a14cbc28f92118c48dc5fc50bb9c03`: image before adding the 6th condition, containing only Playwright-bundled Chromium.
- Local Docker image/tag `kogane-globalpass-collector-poc-globalpasscollectorcontainer:worker`: removable after remote-deploy verification.
- Temporary Container, profiles, font cache, Xvfb, SOCKS adapter and port 18083 for the 2026-08-30 font-bind A/B are stopped/removed. No additional image or registry push.
- Temporary Containers, profiles, Chrome/Xvfb, SOCKS adapter and ports 11180/11181/9339/9340/8137/8138 for the 2026-08-30 timezone A/B are stopped/removed.
- Temporary Camoufox image `kogane-camoufox-probe-20260830:one-shot` (image ID `sha256:9eeca18798983968bb313685843b1f6d343bc02588cfe31656de164d732537f6`), container, venv, browser bundle, profile, GeoIP DB, temporary scripts and relay port 11089 are removed/stopped. No registry push. Shared BuildKit cache was not pruned.
- Kuebiko raw capture `C:\Users\risu\AppData\Local\Kuebiko\captures\2026-08-27T21-46-51`: may contain cookies or similar data. Sanitized results are recorded in this repository; remove it once further analysis is unnecessary.
- Windows profiles for the 2026-08-29 local A/B, `C:\Users\risu\AppData\Local\Kuebiko\browser-profile-globalpass-copy-win-20260829` and `browser-profile-globalpass-fresh-win-20260829`: keep the original profile; remove only these 2 after further analysis.
- WSL profiles for the 2026-08-29 local A/B, `/home/risu/.local/share/kogane/browser-profile-globalpass-copy-wsl-20260829` and `browser-profile-globalpass-fresh-wsl-20260829`: the former is an approximately 5 GiB Windows-profile copy. Remove only these 2 after further analysis.
- Raw captures for the 2026-08-29 local A/B: Windows `2026-08-29T12-35-16`, `2026-08-29T12-53-00`, `2026-08-29T12-55-57`, and WSL `2026-08-29T12-45-21`, `2026-08-29T12-51-54`. They may contain cookies or similar data; keep them out of Git and remove only each capture directory after checking sanitized results.
- 2026-08-29 fresh-WSL-login-POST raw capture `/home/risu/.local/state/Kuebiko/captures/2026-08-29T13-08-05`: may contain login cookies and secrets from the authentication POST. Sanitized results are recorded in the repository; remove only this directory after further analysis.
- WSL profiles for the 2026-08-30 same-runtime network A/B, `/home/risu/.local/share/kogane/browser-profile-globalpass-wsl-tamia-20260830` and `/home/risu/.local/share/kogane/browser-profile-globalpass-wsl-warp-control-20260830`: both fresh profiles. Remove only each directory after checking sanitized results.
- Chrome logs for the same 2026-08-30 A/B, `/home/risu/.local/state/kogane-globalpass-wsl-tamia-20260830.log` and `/home/risu/.local/state/kogane-globalpass-wsl-warp-control-20260830.log`: no token values or credentials were recorded. Remove only these 2 files after further analysis.
- WSL profile `/home/risu/.local/share/kogane/browser-profile-globalpass-wsl-xvfb-tamia-20260830` and log directory `/home/risu/.local/state/kogane-globalpass-xvfb-tamia-20260830` for the 2026-08-30 Xvfb control: no token values or credentials were recorded. Remove only this profile and log directory after further analysis.
- WSL profiles for the 2026-08-30 Turnstile-body/Debugger comparison: `/home/risu/.local/share/kogane/browser-profile-globalpass-wsl-xvfb-tamia-payload-20260830`, `browser-profile-globalpass-wsl-xvfb-tamia-payload2-20260830`, `browser-profile-globalpass-wsl-xvfb-tamia-debugger-20260830`, `browser-profile-globalpass-wsl-xvfb-tamia-trace-20260830`, `browser-profile-globalpass-wsl-xvfb-tamia-vmtrace-20260830`, `browser-profile-globalpass-wsl-xvfb-tamia-vmtrace2-20260830`. Remove only each profile after further analysis is complete.
- Worker `placement.region`, `CF_EGRESS` (`cf1:network`) binding and `chrome-stable-no-ua-all-cloudflare-gateway` variant for NRT Cloudflare Gateway diagnostics: no Container charge while inactive. Remove these 3 together if retaining TAMIA is finalized without a sufficiently spaced A/B. Container instances for diagnostic Durable Object names `prestia-globalpass-apac-ne-direct-probe-v1` and `v2` are destroyed; only inactive list metadata remains.
- WSL state directories for the same comparison: `/home/risu/.local/state/kogane-globalpass-wsl-xvfb-tamia-payload-20260830`, `kogane-globalpass-wsl-xvfb-tamia-debugger-20260830`, `kogane-globalpass-wsl-xvfb-tamia-trace-20260830`, `kogane-globalpass-wsl-xvfb-tamia-vmtrace-20260830`, `kogane-globalpass-wsl-xvfb-tamia-vmtrace2-20260830`. Chrome/Xvfb processes are stopped.
- Private raw-comparison directory `/home/risu/.local/share/kogane/private/globalpass-turnstile/20260830`: contains POST bodies, response bodies, compiled scripts and sanitized reports. No credential entry or login POST was performed, but challenge values are present; keep it out of Git and remove the directory once further analysis is complete.
- Temporary deobfuscation tools/reports `/tmp/kogane-turnstile-tools`, `/tmp/kogane-turnstile-index.json`, `/tmp/kogane-turnstile-comparison.json` and the explicitly created outside-worktree pretty directory. These can be removed separately from private captures.
- The 5 same-named untracked analyzer files in mistaken old worktree `/home/risu/codex-work/2026-08-27/kogane-globalpass-worker`: reflected in the correct PR worktree; remove only when discarding the old worktree.
- Mistakenly created Windows `C:\home` was audited on 2026-08-30. All 14 files were older drafts than WSL copies, contained no secrets/cookies/captures and had authoritative copies in Git/WSL; it was deleted. It is no longer a cleanup target.
- Local admin-token file `/home/risu/.local/share/kogane/secrets/globalpass-worker-admin-token`: remove when no longer operating the PoC.
- Cloudflare registry authentication entry in `/home/risu/.docker/config.json`: check whether Wrangler added it; remove only that entry if unnecessary. Do not remove the whole file, which may contain other registry settings.
- This Git worktree: removable only after the PR is merged or closed and necessary commits are confirmed on the remote.

<a id="現在は保持するoci-bots検証資源"></a>

## OCI `bots` verification resources currently retained

Under the 2026-08-30 instruction, do not remove these resources after verification. Chrome/Xvfb processes stop at the end of each run, but packages, runtimes, profiles, scripts and logs remain for comparisons.

- probe root `/opt/kogane-globalpass-probe`
- official Google Chrome Stable 152.0.7977.64 ARM64
- Xvfb, Noto CJK font
- Node.js 24.20.0 ARM64 (`/opt/kogane-globalpass-probe/node`)
- OCI fresh profile `/opt/kogane-globalpass-probe/profile`
- copy of the successful local WSL profile `/opt/kogane-globalpass-probe/profile-from-wsl-20260829`
- SwiftShader comparison profile `/opt/kogane-globalpass-probe/profile-swiftshader`
- TAMIA relay comparison profile `/opt/kogane-globalpass-probe/profile-tamia-swiftshader`
- Turnstile-payload/Debugger comparison profiles `/opt/kogane-globalpass-probe/profile-payload-tamia-20260830`, `profile-payload-tamia-debugger-20260830`
- State directories for the same comparison `/opt/kogane-globalpass-probe/state-payload-tamia-20260830`, `state-payload-tamia-debugger-20260830`
- Private raw captures `/opt/kogane-globalpass-probe/private/turnstile-bots-xvfb-tamia-20260830.json`, `turnstile-bots-xvfb-tamia-debugger-20260830.json` and the latter's gzip copy. Keep them out of Git and retain for comparison.
- Sanitized probe scripts, `ws` dependency and Chrome/Xvfb logs (`/opt/kogane-globalpass-probe/app`, `logs`)

The localhost SOCKS adapter used for TAMIA comparison is stopped after verification; port 11080 is not listening. The relay token passed from stdin into memory, without storage in a `bots` file. Start that process only for reruns and stop it afterward.

Before removing these later, recheck absolute paths and Chrome processes on `bots`, ensuring no OCI workload outside `/opt/kogane-globalpass-probe` is affected.

<a id="poc全体を廃止するときに削除するもの"></a>

## Items removed when retiring the entire PoC

- Old tags in current app repository kogane-globalpass-collector-poc-globalpasscollectorcontainer: 007215b4, 0080b617, 2444b612, 4311cdf8, 63148685, 87f23407, 8b4e8803, a220cfae, b8e96bd2, cb98569f, d86b50ae, f2585107, f6406948, f73b2bab, cd80a6ee, 791950f1, bef74562, 9fe9a176, 790bbb11, 92453ede, 1cdfb2ea, acd857ec. Remove current v6 registry tag `a8c58f4b` after app removal. Wrangler already untagged local tags reusing the same digest during deployment.
- All tags in old standalone probe repository kogane-globalpass-container-probe-20260827-globalpassprobecontainer: 1068a298, 57c4aa1c, 73d5ead9, 7c10d299, 833aeb70, 927ed319, 9d7b1c69, ae9b6abc, c16fe4c8, c2e12ab7, c7f3e510, d1e7d4f5, ed0300e2, ee37d303, ee71d223. They are not referenced by the current app; remove them only when retiring this entire PoC.

- Worker `kogane-globalpass-collector-poc` and workers.dev deployment.
- Container app `kogane-globalpass-collector-poc-globalpasscollectorcontainer` (app ID `a03ac341-52a7-4e81-9a7c-279a90cc4b0c`).
- Current Container image `sha256:195ebaa959f2676e08e8c6d40335b5984e64e36e905efc957a4061070835e6b1` (timezone collector v6), v5 `sha256:f0b630d018a20ae23f2834134cb02923e3b640500d53114a42be036dd594a4c0`, v4 `sha256:831819f48420eec226601985df6b84e3a80d3948ae389dd2fbbd557d23eed0f3` and old registry images including digests `sha256:db2ea4549e95c40114e95648d625b498c6d0ed7095a6d05bbc6d56bd09709f6c`, `sha256:7cd71344cc130d6b5e5c62a78743a8102daf07c0deb7ecd4a9e2428f55d2e863`, `sha256:c85e093a8a827821407fcba2fed849ea6558342fc103978846561cbc6f4192f7`, `sha256:c0bd4b80395580cf61eb8f6d34f5326a073e4191eda18064d47f5e5ecacdd501`, `sha256:c768879b72c2b88099fee38a139036142d4c43c6d0c8960a727deb11f52853af`.
- Temporary containers `kogane-globalpass-wsl-ab-*`, ports 8080/18080/18081/18082, Xvfb :93/:94 and host SOCKS port 11080 for the 2026-08-30 WSL local-Docker A/B were stopped/removed after all runs. No new image, profile or capture was created.
- Old Container images for additional 2026-08-29 verification, `sha256:ac8dcc44bfcd5135dd60582ed801492f599735d4e45df63e4cf9416f108dded1`, `sha256:f3fe89e1590fce95edcca8b29dbb34aff3426b5cb39be88aedacb230e4dc284f`, and earlier current image `sha256:4933be0abc6397d74ec6f02b0e49a4a046daeda392962f7f28f3c3d41514c7c6`.
- Public Worker diagnostic endpoint `/egress`. It creates no resource beyond the existing Worker and disappears with Worker removal.
- npm dependency `patchright`. No separate service or registry resource was created; repository/Container-image removal removes it.
- Private R2 bucket `kogane-globalpass-collector-poc`. Confirm failure manifests need not be retained before removal.
- Worker secrets `GLOBALPASS_ID`, `GLOBALPASS_PASSWORD`, `RELAY_TOKEN`.
- Browser Run binding `BROWSER` and TAMIA VPC binding in Worker configuration. Remove bindings only, not the destination Tunnel itself.
- Cloudflare-held PoC Worker version/deployment history. Leave it for entire-Worker removal rather than forcing individual-version deletion.

<a id="このpocのcleanupで削除してはいけないもの"></a>

## Items this PoC cleanup must not remove

- Shared TAMIA Tunnel `6b0ccf30-68b2-494e-baa8-f4f9f3e46b33` and TAMIA-side `cloudflared`.
- Personal-PC WARP configuration, existing hostname routes and VPC networks used by other Workers.
- Workers, R2, Queues, secrets and Container images of other collectors, including `SBI証券` (SBI Securities) and SMBC-card Vpass.

This verification created no Queue, D1 or new hostname route, so those need no cleanup. Workers Cron `17 18 * * *` disappears with Worker removal; to retain the PoC while stopping only periodic capture, remove `triggers.crons` and deploy. During active image rollout, old instances may retain old images; stop/destroy Container instances and check them before app/image removal.

Container-app `max_instances` is 2. Ordinary collection uses only fixed identity `v19`; the 2nd slot holds an old inactive instance during image rollout or serves bounded probes. Leave it for app removal when retiring the PoC, without changing shared Tunnel configuration.
