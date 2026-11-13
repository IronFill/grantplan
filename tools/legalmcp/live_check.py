"""Bounded live check of the LegalMCP provider layer through a real MCP stdio client.

Starts launch.sh exactly as Claude Code does, with the explicit cloud proxy-auth
opt-in, then calls: ping, provider_layer_self_test(live=False), system_health,
and at most ONE short review per provider (OpenAI, Gemini without fallback,
DeepSeek) on a neutral educational task.

Only safe metadata is printed/saved: status codes, error type names, model
names, provider fields, attempt counts, character counts. Never review text,
error message bodies, headers or key values.

    LEGALMCP_PROXY_AUTH=1 python -B tools/legalmcp/live_check.py [out.json]
"""

import asyncio
import json
import os
import pathlib
import sys

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

ROOT = pathlib.Path(__file__).resolve().parent

TASK = "Check a one-sentence explanation for a school physics lesson."
PROPOSAL = (
    "The sky looks blue because air molecules scatter short (blue) wavelengths "
    "of sunlight more strongly than long (red) ones."
)
SAFE_KEYS = (
    "success", "provider", "requested_provider", "actual_provider", "fallback_used",
    "fallback_allowed", "model", "actual_model", "status_code", "retryable",
    "error_type", "timed_out", "primary_attempts", "fallback_attempts",
    "attempts_used", "finish_reason", "incomplete", "incomplete_status",
    "review_chars", "verdict", "output_budget",
)
SECTIONS = (
    "VERDICT", "WHAT IS GOOD", "CRITICAL ISSUES", "UNPROVEN ASSUMPTIONS",
    "BETTER ALTERNATIVES", "MISSING CASES", "PERFORMANCE / COST",
    "SECURITY / RELIABILITY", "RECOMMENDED PLAN", "FINAL NOTE",
)


def parse(result):
    text = next((c.text for c in result.content if hasattr(c, "text")), "")
    try:
        return json.loads(text)
    except Exception:
        return {"_unparsed_chars": len(text)}


def safe(payload):
    out = {k: payload[k] for k in SAFE_KEYS if k in payload}
    review = payload.get("review")
    out["review_chars"] = len(review) if isinstance(review, str) else 0
    if isinstance(review, str):
        out["sections_present"] = [s for s in SECTIONS if s in review.upper()]
        out["sections_missing"] = [s for s in SECTIONS if s not in review.upper()]
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
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    params = StdioServerParameters(command="bash", args=[str(ROOT / "launch.sh")], env=env)
    report = {"proxy_auth_flag": env.get("LEGALMCP_PROXY_AUTH", "unset")}
    async with stdio_client(params) as streams:
        async with ClientSession(*streams) as session:
            await session.initialize()
            tools = await session.list_tools()
            report["tools"] = len(tools.tools)
            ping = await session.call_tool("ping", {})
            report["ping"] = {"is_error": ping.is_error}
            st = parse(await session.call_tool("provider_layer_self_test", {"live": False}))
            report["self_test"] = {"success": st.get("success"), **(st.get("summary") or {})}
            health = parse(await session.call_tool("system_health", {}))
            report["health"] = {
                k: health.get(k)
                for k in (
                    "proxy_auth_enabled", "provider_key_source", "openai_key_configured",
                    "gemini_key_configured", "deepseek_key_configured", "openai_sdk_installed",
                    "gemini_sdk_installed", "openai_review_model", "gemini_review_model",
                    "deepseek_review_model",
                )
            }
            common = {"task": TASK, "proposal": PROPOSAL, "mode": "general", "depth": "standard"}
            calls = {
                "openai": ("ai_review", {**common, "max_output_tokens": 500}),
                "google_gemini": (
                    "gemini_review",
                    {
                        **common,
                        "max_output_tokens": int(os.environ.get("LEGALMCP_GEMINI_TOKENS", "4096")),
                        "allow_fallback": False,
                    },
                ),
                "deepseek": ("deepseek_review", {**common, "max_output_tokens": 500, "timeout_seconds": 45}),
            }
            if os.environ.get("LEGALMCP_LIVE_ONLY"):
                calls = {k: v for k, v in calls.items() if k in os.environ["LEGALMCP_LIVE_ONLY"].split(",")}
            report["reviews"] = {}
            for provider, (tool, args) in calls.items():  # exactly one call each, no loops
                res = await session.call_tool(tool, args)
                payload = parse(res)
                report["reviews"][provider] = {"tool": tool, "tool_is_error": res.is_error, **safe(payload)}
                save_dir = os.environ.get("LEGALMCP_LIVE_SAVE_TEXT_DIR")
                text = payload.get("review") or payload.get("partial_review")
                if save_dir and isinstance(text, str):  # model output only, never in the repo
                    pathlib.Path(save_dir, provider + ".review.txt").write_text(text, encoding="utf-8")
    text = json.dumps(report, ensure_ascii=False, indent=2)
    print(text)
    if out_path:
        pathlib.Path(out_path).write_text(text + "\n", encoding="utf-8")


asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else None))
