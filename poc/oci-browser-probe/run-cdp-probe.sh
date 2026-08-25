#!/usr/bin/env bash
set -euo pipefail

probe_root=${KOGANE_PROBE_ROOT:-/opt/kogane-browser-probe}
profile_dir=$(mktemp -d /tmp/kogane-chrome-profile.XXXXXX)
display_num=${KOGANE_DISPLAY:-:99}
cdp_port=${KOGANE_CDP_PORT:-9222}
browser_bin=${KOGANE_BROWSER_BIN:-google-chrome-stable}
node_bin=${KOGANE_NODE_BIN:-$probe_root/node/bin/node}
app_dir=${KOGANE_APP_DIR:-$probe_root/app}

cleanup() {
  if [[ -n "${chrome_pid:-}" ]]; then
    kill "$chrome_pid" 2>/dev/null || true
    wait "$chrome_pid" 2>/dev/null || true
  fi
  if [[ -n "${xvfb_pid:-}" ]]; then
    kill "$xvfb_pid" 2>/dev/null || true
    wait "$xvfb_pid" 2>/dev/null || true
  fi
  pkill -TERM -f -- "--user-data-dir=${profile_dir}" 2>/dev/null || true
  for _ in $(seq 1 20); do
    if rm -rf -- "$profile_dir" 2>/dev/null; then break; fi
    sleep 0.1
  done
}
trap cleanup EXIT

Xvfb "$display_num" -screen 0 1365x768x24 -nolisten tcp >/tmp/kogane-xvfb.log 2>&1 &
xvfb_pid=$!

DISPLAY="$display_num" "$browser_bin" \
  --no-first-run \
  --no-default-browser-check \
  --disable-dev-shm-usage \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$cdp_port" \
  --user-data-dir="$profile_dir" \
  about:blank >/tmp/kogane-chrome.log 2>&1 &
chrome_pid=$!

for _ in $(seq 1 100); do
  if curl -fsS "http://127.0.0.1:${cdp_port}/json/version" >/dev/null 2>&1; then break; fi
  sleep 0.1
done
curl -fsS "http://127.0.0.1:${cdp_port}/json/version" >/dev/null

cd "$app_dir"
KOGANE_CDP_URL="http://127.0.0.1:${cdp_port}" \
  "$node_bin" probe.mjs chrome-cdp "$@"
