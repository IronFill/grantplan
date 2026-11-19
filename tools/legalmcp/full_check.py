"""General stdio run of LegalMCP exactly as a cloud session would start it.

Starts launch.sh (no proxy-auth variable set by this script; launch.sh decides),
then: list_tools, ping, provider_layer_self_test(live=False), system_health,
browser_open on a local page, ONE ai_compare (OpenAI + Gemini) and ONE
deepseek_review (ai_compare does not include DeepSeek), on a neutral task, with
output limits up to 4096 per provider and no substitution or extra retries.

Review texts are saved only to LEGALMCP_FULL_SAVE_DIR (never inside the repo);
the printed/saved JSON holds safe metadata only. A review counts as complete
only if the tool says so, finish_reason is a normal stop (when reported), the
output did not hit the token cap, all ten required sections are present and
FINAL NOTE has real content.

    python -B tools/legalmcp/full_check.py out.json
"""

import asyncio
import functools
import http.server
import json
import os
import pathlib
import sys
import tempfile
import threading

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

ROOT = pathlib.Path(__file__).resolve().parent

TASK = "Check a one-sentence explanation for a school geography lesson."
PROPOSAL = (
    "Seasons occur because Earth's rotation axis is tilted relative to its orbital "
    "plane, so each hemisphere receives more direct sunlight for part of the year."
)
SECTIONS = (
    "VERDICT", "WHAT IS GOOD", "CRITICAL ISSUES", "UNPROVEN ASSUMPTIONS",
    "BETTER ALTERNATIVES", "MISSING CASES", "PERFORMANCE / COST",
    "SECURITY / RELIABILITY", "RECOMMENDED PLAN", "FINAL NOTE",
)
OK_FINISH = {None, "STOP", "stop", "completed"}
CAP = {"openai": 4000, "google_gemini": 4000, "deepseek": 4096}


def parse(result):
    text = next((c.text for c in result.content if hasattr(c, "text")), "")
    try:
        return json.loads(text)
    except Exception:
        return {"_unparsed_chars": len(text)}


def completeness(provider, payload):
    """Judge the review text itself, not the HTTP status."""
    text = payload.get("review") if isinstance(payload.get("review"), str) else ""
    upper = text.upper()
    positions = [upper.find(s) for s in SECTIONS]
    present = [s for s, p in zip(SECTIONS, positions) if p >= 0]
    in_order = all(p >= 0 for p in positions) and positions == sorted(positions)
    tail = text[positions[-1] + len("FINAL NOTE"):].strip() if positions[-1] >= 0 else ""
    out_tokens = (payload.get("usage") or {}).get("output_tokens")
    finish = payload.get("finish_reason")
    checks = {
        "tool_success": bool(payload.get("success")),
        "tool_not_incomplete": not payload.get("incomplete", False),
        "finish_reason_normal": finish in OK_FINISH,
        "finish_reason": finish,
        "under_token_cap": (out_tokens is None) or out_tokens < CAP[provider],
        "all_sections_present_in_order": in_order,
        "sections_missing": [s for s in SECTIONS if s not in present],
        "final_note_chars": len(tail),
        "final_note_ok": len(tail) >= 40,
        "review_chars": len(text),
    }
    checks["complete"] = all(
        checks[k] for k in (
            "tool_success", "tool_not_incomplete", "finish_reason_normal",
            "under_token_cap", "all_sections_present_in_order", "final_note_ok",
        )
    )
    return checks


def safe_meta(payload):
    keys = (
        "success", "provider", "requested_provider", "actual_provider", "fallback_used",
        "model", "status_code", "retryable", "error_type", "timed_out", "primary_attempts",
        "attempts_used", "finish_reason", "incomplete", "verdict", "independent",
        "output_budget",
    )
    out = {k: payload[k] for k in keys if k in payload}
    usage = payload.get("usage")
    if isinstance(usage, dict):
        out["usage"] = {k: v for k, v in usage.items() if isinstance(v, int)}
    errs = payload.get("primary_errors")
    if isinstance(errs, list):
        out["primary_errors"] = [
            {k: e.get(k) for k in ("attempt", "status_code", "error_type", "retryable")}
            for e in errs if isinstance(e, dict)
        ]
    return out


async def main(out_path):
    save_dir = pathlib.Path(os.environ.get("LEGALMCP_FULL_SAVE_DIR", tempfile.mkdtemp(prefix="legalmcp-full-")))
    save_dir.mkdir(parents=True, exist_ok=True)

    site = pathlib.Path(tempfile.mkdtemp(prefix="legalmcp-site-"))
    (site / "index.html").write_text(
        '<!doctype html><html lang="uk"><head><meta charset="utf-8"><title>Навчальна сторінка</title></head>'
        "<body><h1>Перевірка</h1><p>Локальна сторінка без зовнішньої мережі.</p></body></html>",
        encoding="utf-8",
    )
    handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(site))
    handler.log_message = lambda *a, **k: None
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    page = f"http://127.0.0.1:{httpd.server_address[1]}/"

    env = {k: v for k, v in os.environ.items() if k != "LEGALMCP_PROXY_AUTH"}
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    params = StdioServerParameters(command="bash", args=[str(ROOT / "launch.sh")], env=env)
    report = {
        "launch_env": {
            "CLAUDE_CODE_REMOTE": env.get("CLAUDE_CODE_REMOTE", "unset"),
            "LEGALMCP_PROXY_AUTH": "unset (launch.sh decides)",
        }
    }
    async with stdio_client(params) as streams:
        async with ClientSession(*streams) as session:
            await session.initialize()
            report["tools"] = sorted(t.name for t in (await session.list_tools()).tools)
            ping = await session.call_tool("ping", {})
            report["ping"] = {"is_error": ping.is_error}
            st = parse(await session.call_tool("provider_layer_self_test", {"live": False}))
            report["self_test"] = {"success": st.get("success"), **(st.get("summary") or {})}
            h = parse(await session.call_tool("system_health", {}))
            report["health"] = {
                k: h.get(k) for k in (
                    "proxy_auth_enabled", "provider_key_source", "openai_key_configured",
                    "gemini_key_configured", "deepseek_key_configured",
                    "openai_review_model", "gemini_review_model", "deepseek_review_model",
                )
            }
            br = parse(await session.call_tool("browser_open", {"url": page}))
            report["browser_open_local"] = {
                "success": br.get("success"), "status": br.get("status"),
                "title": br.get("title"), "text_chars": len(str(br.get("text") or "")),
            }

            common = {"task": TASK, "proposal": PROPOSAL, "mode": "general", "depth": "standard"}
            reviews = {}

            cmp_res = await session.call_tool(
                "ai_compare", {**common, "max_output_tokens": CAP["openai"], "deadline_seconds": 50}
            )
            cmp_payload = parse(cmp_res)
            report["ai_compare"] = {
                "tool_is_error": cmp_res.is_error,
                "success": cmp_payload.get("success"),
                "status": cmp_payload.get("status"),
                "independent_review_count": cmp_payload.get("independent_review_count"),
            }
            for provider, key in (("openai", "openai"), ("google_gemini", "gemini")):
                reviews[provider] = cmp_payload.get(key) or {}

            ds_res = await session.call_tool(
                "deepseek_review",
                {**common, "max_output_tokens": CAP["deepseek"], "timeout_seconds": 60},
            )
            reviews["deepseek"] = parse(ds_res)

            report["reviews"] = {}
            for provider, payload in reviews.items():
                text = payload.get("review")
                if isinstance(text, str):
                    (save_dir / f"{provider}.review.txt").write_text(text, encoding="utf-8")
                report["reviews"][provider] = {**safe_meta(payload), "completeness": completeness(provider, payload)}
    httpd.shutdown()
    text = json.dumps(report, ensure_ascii=False, indent=2)
    print(text)
    if out_path:
        pathlib.Path(out_path).write_text(text + "\n", encoding="utf-8")
    print(f"review texts saved outside the repo: {save_dir}", file=sys.stderr)


asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else None))
