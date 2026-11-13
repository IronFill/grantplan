"""Offline tests: Gemini output budget, thinking config, empty/truncated answers.

No network, no keys. Run:
    tools/legalmcp/.venv/bin/python -B tools/legalmcp/test_gemini_completeness.py
"""

import asyncio
import importlib.util
import os
import pathlib
import unittest
from types import SimpleNamespace as NS
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location(
    "legalmcp_server_gemini_test", ROOT / "server.py"
)
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

GOOD = (
    "VERDICT\n\nACCEPT\n\nWHAT IS GOOD\n\n- correct\n\n"
    "FINAL NOTE\n\nShort summary."
)


def response(text, finish, thinking=10, out=20):
    """Shape of a google-genai GenerateContentResponse (only used fields)."""
    return NS(
        text=text,
        candidates=[NS(finish_reason=NS(value=finish) if finish else None)],
        usage_metadata=NS(
            prompt_token_count=5,
            candidates_token_count=out,
            total_token_count=5 + out + thinking,
            thoughts_token_count=thinking,
        ),
    )


def clean_env(**values):
    cleaned = {
        k: v
        for k, v in os.environ.items()
        if k != "GEMINI_STANDARD_THINKING_LEVEL"
    }
    cleaned.update(values)
    return mock.patch.dict(os.environ, cleaned, clear=True)


class Assessment(unittest.TestCase):
    def test_complete(self):
        a = server.assess_gemini_completion(response(GOOD, "STOP"))
        self.assertEqual(a["status"], "complete")
        self.assertEqual(a["verdict"], "ACCEPT")
        self.assertEqual(a["review_chars"], len(GOOD))

    def test_empty_with_max_tokens(self):
        a = server.assess_gemini_completion(response("", "MAX_TOKENS", thinking=479, out=17))
        self.assertEqual(a["status"], "empty")

    def test_whitespace_only_is_empty(self):
        self.assertEqual(
            server.assess_gemini_completion(response("  \n ", "STOP"))["status"], "empty"
        )

    def test_truncated_non_empty_is_not_complete(self):
        a = server.assess_gemini_completion(response("VERDICT\n\nREV", "MAX_TOKENS"))
        self.assertEqual(a["status"], "truncated")

    def test_other_finish_reasons_incomplete(self):
        for reason in ("SAFETY", "RECITATION", "BLOCKLIST", "OTHER"):
            a = server.assess_gemini_completion(response("some text", reason))
            self.assertEqual(a["status"], "incomplete", reason)

    def test_missing_finish_reason_not_treated_as_truncation(self):
        a = server.assess_gemini_completion(response("text", None))
        self.assertEqual(a["status"], "complete")
        self.assertIsNone(a["finish_reason"])

    def test_no_verdict_is_metadata_not_failure(self):
        a = server.assess_gemini_completion(response("free form answer", "STOP"))
        self.assertEqual(a["status"], "complete")
        self.assertIsNone(a["verdict"])


class Budget(unittest.TestCase):
    def test_standard_floor_raises_small_values(self):
        with clean_env():
            b = server.gemini_generation_budget("standard", 500)
        self.assertEqual(b["max_output_tokens"], 2048)
        self.assertTrue(b["raised_to_floor"])
        self.assertEqual(b["thinking_level"], "low")
        self.assertEqual(b["requested_max_output_tokens"], 500)

    def test_standard_keeps_larger_values_and_ceiling(self):
        with clean_env():
            self.assertEqual(server.gemini_generation_budget("standard", 4096)["max_output_tokens"], 4096)
            self.assertEqual(server.gemini_generation_budget("standard", 99999)["max_output_tokens"], 8000)
            self.assertFalse(server.gemini_generation_budget("standard", 4096)["raised_to_floor"])

    def test_deep_unchanged_floor_and_level(self):
        b = server.gemini_generation_budget("deep", 500)
        self.assertEqual((b["max_output_tokens"], b["thinking_level"]), (500, "high"))

    def test_env_override_validated(self):
        with clean_env(GEMINI_STANDARD_THINKING_LEVEL="Medium"):
            self.assertEqual(server.gemini_standard_thinking_level(), "medium")
        with clean_env(GEMINI_STANDARD_THINKING_LEVEL="turbo"):
            self.assertEqual(server.gemini_standard_thinking_level(), "low")


class ThinkingConfig(unittest.TestCase):
    def test_only_thinking_level_is_sent(self):
        cfg = server.build_gemini_thinking_config("low")
        self.assertIsNotNone(cfg)
        self.assertEqual(str(cfg.thinking_level.value), "LOW")
        self.assertIsNone(cfg.thinking_budget)

    def test_without_sdk_types_returns_none(self):
        with mock.patch.object(server, "genai_types", None):
            self.assertIsNone(server.build_gemini_thinking_config("low"))


class GeminiReviewEndToEnd(unittest.TestCase):
    def _run(self, resp, **kwargs):
        seen = {}

        def generate_content(**kw):
            seen.update(kw)
            return resp

        client = NS(aio=NS(models=NS(generate_content=mock.AsyncMock(side_effect=generate_content))))
        with clean_env(), mock.patch.object(
            server.GEMINI_ADAPTER, "get_client", lambda: client
        ):
            result = asyncio.run(
                server.gemini_review(
                    task="t", proposal="p", allow_fallback=False, **kwargs
                )
            )
        return result, seen

    def test_request_uses_floor_and_thinking_level_only(self):
        _, seen = self._run(response(GOOD, "STOP"), max_output_tokens=500)
        cfg = seen["config"]
        self.assertEqual(cfg.max_output_tokens, 2048)
        self.assertEqual(str(cfg.thinking_config.thinking_level.value), "LOW")
        self.assertIsNone(cfg.thinking_config.thinking_budget)

    def test_complete_review_is_success(self):
        r, _ = self._run(response(GOOD, "STOP"), max_output_tokens=4096)
        self.assertTrue(r["success"])
        self.assertFalse(r["incomplete"])
        self.assertEqual(r["review"], GOOD)
        self.assertEqual(r["verdict"], "ACCEPT")
        self.assertEqual(r["finish_reason"], "STOP")
        self.assertEqual(r["output_budget"]["max_output_tokens"], 4096)

    def test_empty_max_tokens_is_not_success(self):
        r, _ = self._run(response("", "MAX_TOKENS", thinking=479, out=17), max_output_tokens=500)
        self.assertFalse(r["success"])
        self.assertTrue(r["incomplete"])
        self.assertEqual(r["error_type"], "EmptyResponse")
        self.assertEqual(r["finish_reason"], "MAX_TOKENS")
        self.assertNotIn("review", r)
        self.assertNotIn("partial_review", r)
        self.assertEqual(r["usage"]["thinking_tokens"], 479)
        self.assertIn("max_output_tokens", r["hint"])
        self.assertEqual(r["status_code"], 200)
        self.assertFalse(r["fallback_used"])

    def test_truncated_text_is_not_success_and_not_called_review(self):
        r, _ = self._run(response("VERDICT\n\nREV", "MAX_TOKENS"))
        self.assertFalse(r["success"])
        self.assertTrue(r["incomplete"])
        self.assertEqual(r["error_type"], "IncompleteResponse")
        self.assertEqual(r["incomplete_status"], "truncated")
        self.assertNotIn("review", r)
        self.assertEqual(r["partial_review"], "VERDICT\n\nREV")

    def test_no_openai_call_on_incomplete(self):
        calls = []

        async def fake_openai(**kw):
            calls.append(kw)
            return {}

        with mock.patch.object(server, "run_openai_review_fallback", fake_openai):
            r, _ = self._run(response("", "MAX_TOKENS"))
        self.assertEqual(calls, [])
        self.assertFalse(r["fallback_used"])


class AiCompareGeminiLeg(unittest.TestCase):
    def _compare(self, resp):
        async def ok_openai(**_):
            return {"success": True, "review": GOOD, "provider": "openai"}

        client = NS(aio=NS(models=NS(generate_content=mock.AsyncMock(return_value=resp))))
        with clean_env(), mock.patch.object(
            server, "ai_review", ok_openai
        ), mock.patch.object(server, "get_gemini_client", lambda: client):
            return asyncio.run(server.ai_compare(task="t", proposal="p"))

    def test_truncated_gemini_is_not_independent_review(self):
        r = self._compare(response("VERDICT\n\nREV", "MAX_TOKENS"))
        g = r["gemini"]
        self.assertFalse(g["success"])
        self.assertTrue(g["incomplete"])
        self.assertFalse(g["independent"])
        self.assertEqual(r["independent_review_count"], 1)
        types = [c["type"] for c in r["comparison"].get("conflicts", [])]
        self.assertIn("gemini_incomplete_response", types)

    def test_complete_gemini_counts(self):
        r = self._compare(response(GOOD, "STOP"))
        self.assertTrue(r["gemini"]["success"])
        self.assertTrue(r["gemini"]["independent"])
        self.assertEqual(r["independent_review_count"], 2)


if __name__ == "__main__":
    unittest.main(verbosity=2)

