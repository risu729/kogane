#!/usr/bin/env bash
set -euo pipefail

probe_root=${KOGANE_PROBE_ROOT:-/opt/kogane-globalpass-probe}
profile_dir=${KOGANE_PROFILE_DIR:-$probe_root/profile}
display_num=${KOGANE_DISPLAY:-:99}
cdp_port=${KOGANE_CDP_PORT:-9222}
browser_bin=${KOGANE_BROWSER_BIN:-google-chrome-stable}
node_bin=${KOGANE_NODE_BIN:-$probe_root/node/bin/node}
app_dir=${KOGANE_APP_DIR:-$probe_root/app}
log_dir=$probe_root/logs
stamp=$(date -u +%Y-%m-%dT%H-%M-%SZ)
extra_chrome_flags=()
if [[ -n "${KOGANE_CHROME_FLAGS:-}" ]]; then
  read -r -a extra_chrome_flags <<<"$KOGANE_CHROME_FLAGS"
fi

mkdir -p "$profile_dir" "$log_dir"
chmod 700 "$profile_dir"

cleanup() {
  if [[ -n "${chrome_pid:-}" ]]; then
    kill "$chrome_pid" 2>/dev/null || true
    wait "$chrome_pid" 2>/dev/null || true
  fi
  if [[ -n "${xvfb_pid:-}" ]]; then
    kill "$xvfb_pid" 2>/dev/null || true
    wait "$xvfb_pid" 2>/dev/null || true
  fi
}
trap cleanup EXIT

Xvfb "$display_num" -screen 0 1365x768x24 -nolisten tcp \
  >"$log_dir/xvfb-$stamp.log" 2>&1 &
xvfb_pid=$!

DISPLAY="$display_num" "$browser_bin" \
  --no-first-run \
  --no-default-browser-check \
  --disable-dev-shm-usage \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$cdp_port" \
  --remote-allow-origins='*' \
  --window-size=1365,768 \
  --user-data-dir="$profile_dir" \
  "${extra_chrome_flags[@]}" \
  'https://www.debit.vpass.ne.jp/p/login/RW1312010001?cc=01006' \
  >"$log_dir/chrome-$stamp.log" 2>&1 &
chrome_pid=$!

for _ in $(seq 1 200); do
  if curl -fsS "http://127.0.0.1:${cdp_port}/json/version" >/dev/null 2>&1; then
    break
  fi
  sleep 0.1
done
curl -fsS "http://127.0.0.1:${cdp_port}/json/version" >/dev/null

for _ in $(seq 1 300); do
  if curl -fsS "http://127.0.0.1:${cdp_port}/json/list" \
    | grep -q 'www.debit.vpass.ne.jp/p/login/'; then
    break
  fi
  sleep 0.1
done
curl -fsS "http://127.0.0.1:${cdp_port}/json/list" \
  | grep -q 'www.debit.vpass.ne.jp/p/login/'

for _ in $(seq 1 300); do
  token_length=$(
    "$node_bin" "$app_dir/probe-local-turnstile.mjs" "$cdp_port" \
      | "$node_bin" -e \
        'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).tokenLength))'
  )
  if [[ "$token_length" -gt 20 ]]; then break; fi
  sleep 0.1
done

curl -fsS https://www.cloudflare.com/cdn-cgi/trace \
  | grep -E '^(ip|loc|colo|warp|http)='
"$node_bin" "$app_dir/probe-local-turnstile.mjs" "$cdp_port"

if [[ "${1:-}" == "--auth" ]]; then
  "$node_bin" "$app_dir/probe-local-login.mjs" "$cdp_port"
fi
