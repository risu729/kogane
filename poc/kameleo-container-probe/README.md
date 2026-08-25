# Kameleo Chroma container probe

This probe tests the technically distinct case that Camoufox cannot cover: a
Chromium-based browser with an engine-level, coherent Windows Chrome
fingerprint while the real runtime remains a Linux container.

The official Kameleo image is started separately:

```sh
docker run -d --name kogane-kameleo-probe \
  --platform linux/amd64 \
  --shm-size=2g \
  -p 127.0.0.1:5050:5050 \
  -v kogane-kameleo-probe-data:/data \
  kameleo/kameleo-app:latest
```

Kameleo 5.1 can start in accountless mode when `PAT` is omitted. The probe asks
for a recent Windows desktop Chrome fingerprint, sets Japanese language, and
starts Chroma with `disable-dev-shm-usage`. The last flag is important for a
future Cloudflare Containers test because Wrangler does not currently expose a
Docker `--shm-size` setting.

Install the small controller environment and run the non-authenticated probe:

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python probe.py
```

The optional `--auth` mode reads exactly two credential lines from standard
input after printing `READY_FOR_CREDENTIALS`. It never prints the values,
cookies, response bodies, or the public IP. Do not put credentials in command
arguments, environment variables, shell history, logs, or this repository.

Set `KEEP_PROFILE=1 WARMUP=1` to reuse one coherent profile and first visit the
public SMBC Card site with ordinary scrolling and pointer movement. Auth mode
then uses mouse movement and per-character keyboard input instead of direct DOM
value assignment. This arm tests profile continuity and interaction telemetry,
not merely another randomized fingerprint.

See `RESULTS.md` for the bounded 2026-08-26 controls. Do not run another
credentialed arm until visible Windows Chrome produces a repeatable baseline
under fixed conditions.

The probe creates a temporary Kameleo profile and deletes it on exit. The local
test resources are intentionally retained until the experiment is complete:

- image: `kameleo/kameleo-app:latest`
- container: `kogane-kameleo-probe`
- volume: `kogane-kameleo-probe-data`
- controller venv: `/tmp/kogane-kameleo-probe-venv`

Exact cleanup:

```sh
docker rm -f kogane-kameleo-probe
docker volume rm kogane-kameleo-probe-data
docker image rm kameleo/kameleo-app:latest
rm -rf /tmp/kogane-kameleo-probe-venv
```
