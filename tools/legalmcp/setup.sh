#!/usr/bin/env bash
# Usage: setup.sh [all|core|browser]   (default: all)
#   core    - venv, pinned requirements, offline verify. This is all the MCP
#             server needs to start; launch.sh runs only this stage so that the
#             MCP handshake is never held up by a browser download.
#   browser - Playwright Chromium download (best effort, own lock/status).
#   all     - core, then browser (used by the SessionStart hook).
set -euo pipefail
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
stage="${1:-all}"
case "$stage" in all|core|browser) ;; *) echo "usage: setup.sh [all|core|browser]" >&2; exit 2 ;; esac

setup_core() {
  exec 9>"$task_root/.setup.lock"
  flock 9
  local wanted
  wanted="$(sha256sum "$task_root/requirements.txt" | cut -d " " -f1)"
  if [[ -x "$task_root/.venv/bin/python" && -f "$task_root/.setup-ready" && "$(cat "$task_root/.setup-ready")" = "$wanted" ]]; then
    return 0
  fi
  python3 -m venv "$task_root/.venv"
  "$task_root/.venv/bin/python" -m pip install -r "$task_root/requirements.txt"
  "$task_root/.venv/bin/python" -B "$task_root/verify.py"
  printf "%s\n" "$wanted" > "$task_root/.setup-ready"
}

setup_browser() {
  exec 8>"$task_root/.browser.lock"
  flock 8
  if [[ -f "$task_root/.browser-status" && "$(cat "$task_root/.browser-status")" = "ok" ]]; then
    return 0
  fi
  # Best effort: the offline MCP contract (tools, ping, provider_layer_self_test)
  # does not need Chromium, and the cloud network policy may block
  # cdn.playwright.dev. Record the outcome instead of failing.
  if "$task_root/.venv/bin/python" -m playwright install --with-deps chromium; then
    echo ok > "$task_root/.browser-status"
  else
    echo unavailable > "$task_root/.browser-status"
    echo "WARNING: Playwright Chromium download failed; browser tools unavailable until cdn.playwright.dev is allowed" >&2
  fi
}

case "$stage" in
  core) setup_core ;;
  browser) setup_core; setup_browser ;;
  all) setup_core; setup_browser ;;
esac
