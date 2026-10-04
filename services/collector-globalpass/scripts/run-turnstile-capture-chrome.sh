#!/usr/bin/env bash
set -euo pipefail

profile_dir=${1:?usage: run-turnstile-capture-chrome.sh <profile-dir> <state-dir> [cdp-port] [display-number]}
state_dir=${2:?usage: run-turnstile-capture-chrome.sh <profile-dir> <state-dir> [cdp-port] [display-number]}
cdp_port=${3:-9227}
display_number=${4:-97}

mkdir -p "$profile_dir" "$state_dir"

Xvfb ":${display_number}" -screen 0 1365x768x24 -nolisten tcp \
  >"${state_dir}/xvfb.log" 2>&1 &
xvfb_pid=$!
echo "$xvfb_pid" >"${state_dir}/xvfb.pid"

cleanup() {
  if [[ -n "${chrome_pid:-}" ]]; then
    kill "$chrome_pid" 2>/dev/null || true
  fi
  kill "$xvfb_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

export DISPLAY=":${display_number}"
google-chrome \
  --no-first-run \
  --no-default-browser-check \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$cdp_port" \
  --remote-allow-origins='*' \
  --window-size=1365,768 \
  --proxy-server=socks5://127.0.0.1:11080 \
  --user-data-dir="$profile_dir" \
  about:blank >"${state_dir}/chrome.log" 2>&1 &
chrome_pid=$!
echo "$chrome_pid" >"${state_dir}/chrome.pid"
wait "$chrome_pid"
