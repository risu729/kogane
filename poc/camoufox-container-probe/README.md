# Camoufox container fingerprint probe

This probe tests a materially different browser condition from a custom user
agent: Camoufox runs Firefox in a Linux container while generating a coherent
Windows or macOS fingerprint at the browser-engine layer. It is a candidate for
Cloudflare Containers, not proof that Vpass authentication will pass.

The default command performs only read-only GETs and prints sanitized runtime
metadata. It does not inspect cookies, save response bodies, or persist a
profile unless `PROFILE_DIR` is explicitly mounted.

```bash
docker build -t kogane-camoufox-probe .
docker run --rm -e TARGET_OS=windows kogane-camoufox-probe
docker run --rm -e TARGET_OS=macos kogane-camoufox-probe
```

The optional `--auth` mode reads two lines from non-echoed standard input,
performs one bounded attempt, emits only status/classification metadata, and
stops. Never commit the profile directory or pass credentials through image
layers, environment variables, arguments, or logs.

If one arm authenticates locally, reproduce the exact image through direct
Cloudflare Container egress before adding `TAMIA.connect()`. Container disk is
ephemeral; any accepted profile/session checkpoint must be encrypted outside the
image and restored for one source generation under a single-run lease.

See `RESULTS.md` for the bounded 2026-08-26 controls. The retained local image
can be removed with:

```sh
docker image rm kogane-camoufox-probe:0.5.5
```
