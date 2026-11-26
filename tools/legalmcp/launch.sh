#!/usr/bin/env bash
set -euo pipefail
task_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Cloud proxy-auth default: in a Claude Code cloud session (CLAUDE_CODE_REMOTE=true)
# the provider keys live only in the network proxy, so switch the server's
# proxy-auth mode on - but only when LEGALMCP_PROXY_AUTH is not set at all.
# Any explicit value (including 0 or an empty string) in the environment, or a
# LEGALMCP_PROXY_AUTH line in .env, is left alone. Outside the cloud nothing
# changes. Only the variable NAME is looked for in .env; nothing is printed.
if [[ "${CLAUDE_CODE_REMOTE:-}" = "true" && -z "${LEGALMCP_PROXY_AUTH+x}" ]] \
   && ! { [[ -f "$task_root/.env" ]] && grep -qE '^[[:space:]]*LEGALMCP_PROXY_AUTH[[:space:]]*=' "$task_root/.env"; }; then
  export LEGALMCP_PROXY_AUTH=1
  echo "LegalMCP: cloud session, proxy-auth mode on (LEGALMCP_PROXY_AUTH not set explicitly)" >&2
fi
wanted="$(sha256sum "$task_root/requirements.txt" | cut -d " " -f1)"
if [[ ! -x "$task_root/.venv/bin/python" || ! -f "$task_root/.setup-ready" || "$(cat "$task_root/.setup-ready")" != "$wanted" ]]; then
  # MCP may start before or alongside the SessionStart hook. setup.sh holds a
  # lock, so this waits for a running install or performs it. Only the "core"
  # stage is awaited: a Chromium download must never delay the MCP handshake
  # (Claude Code gives up on connect after 30 s). stdout belongs to the MCP
  # protocol, hence everything goes to stderr.
  bash "$task_root/setup.sh" core >&2
fi
# Playwright's own Chromium is used only when it is known to be installed
# (.browser-status = ok). Otherwise - download failed, blocked, or still running
# in the SessionStart hook - fall back to the cloud image's preinstalled
# Chromium, unless the path is already set.
if [[ -z "${LEGALMCP_CHROMIUM_EXECUTABLE_PATH:-}" ]] && ! { [[ -f "$task_root/.browser-status" ]] && [[ "$(cat "$task_root/.browser-status")" = "ok" ]]; }; then
  preinstalled="${PLAYWRIGHT_BROWSERS_PATH:-/opt/pw-browsers}/chromium"
  if [[ -x "$preinstalled" ]]; then
    export LEGALMCP_CHROMIUM_EXECUTABLE_PATH="$preinstalled"
    echo "LegalMCP: using preinstalled Chromium at $preinstalled" >&2
  fi
fi
exec "$task_root/.venv/bin/python" -B "$task_root/server.py"
