"""Offline tests: unified completeness control for OpenAI, DeepSeek and Gemini.

A review counts only if the text is non-empty and the provider finished
normally. No network, no keys. Run:
    tools/legalmcp/.venv/bin/python -B tools/legalmcp/test_review_completeness.py
"""

import asyncio
import importlib.util
import inspect
import json
import os
import pathlib
import unittest
from types import SimpleNamespace as NS
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location(
    "legalmcp_server_completeness_test", ROOT / "server.py"
)
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

GOOD = "VERDICT\n\nREVISE\n\nWHAT IS GOOD\n\n- ok\n\nFINAL NOTE\n\nShort summary of the review."
SENTINEL_KEY = "test-key-not-a-secret"
CLEAN_VARS = (
    "OPENAI_API_KEY", "GEMINI_API_KEY", "DEEPSEEK_API_KEY",
    "LEGALMCP_PROXY_AUTH", "GEMINI_STANDARD_THINKING_LEVEL",
)


def clean_env():
    env = {k: v for k, v in os.environ.items() if k not in CLEAN_VARS}
    return mock.patch.dict(os.environ, env, clear=True)


def openai_response(text, status="completed", reason=None, rid="resp_test"):
    details = NS(reason=reason) if reason else None
    return NS(
        output_text=text, status=status, incomplete_details=details, id=rid,
        usage=NS(input_tokens=10, output_tokens=20, total_tokens=30),
    )


def deepseek_response(content, finish):
    return NS(
        choices=[NS(message=NS(content=content), finish_reason=finish)],
        usage=NS(prompt_tokens=10, completion_tokens=20, total_tokens=30),
    )


def gemini_response(text, finish):
    return NS(
        text=text,
        candidates=[NS(finish_reason=NS(value=finish) if finish else None)],
        usage_metadata=NS(prompt_token_count=5, candidates_token_count=7,
                          total_token_count=12, thoughts_token_count=0),
    )


class FinishClassification(unittest.TestCase):
    def test_table(self):
        c = server.classify_review_finish
        cases = {
            "openai": {"completed": "complete", "incomplete: max_output_tokens": "truncated",
                       "max_output_tokens": "truncated", "incomplete: content_filter": "incomplete",
                       "incomplete": "incomplete", "failed": "incomplete", "cancelled": "incomplete",
                       "in_progress": "incomplete", "queued": "incomplete", None: "complete"},
            "deepseek": {"stop": "complete", "length": "truncated", "content_filter": "incomplete",
                         "insufficient_system_resource": "incomplete", "tool_calls": "incomplete",
                         None: "complete"},
            "google_gemini": {"STOP": "complete", "MAX_TOKENS": "truncated", "SAFETY": "incomplete",
                              "RECITATION": "incomplete", "OTHER": "incomplete", None: "complete"},
        }
        for provider, table in cases.items():
            for finish, expected in table.items():
                self.assertEqual(c(provider, finish), expected, (provider, finish))


class Assessment(unittest.TestCase):
    def test_openai_states(self):
        a = server.assess_review_completion
        self.assertEqual(a("openai", openai_response(GOOD))["status"], "complete")
        self.assertEqual(a("openai", openai_response(GOOD))["verdict"], "REVISE")
        t = a("openai", openai_response("VERDICT\n\nREV", "incomplete", "max_output_tokens"))
        self.assertEqual((t["status"], t["finish_class"]), ("truncated", "truncated"))
        self.assertEqual(t["finish_reason"], "incomplete: max_output_tokens")
        self.assertEqual(a("openai", openai_response("x", "incomplete", "content_filter"))["status"], "incomplete")
        self.assertEqual(a("openai", openai_response("x", "failed"))["status"], "incomplete")
        e = a("openai", openai_response("", "incomplete", "max_output_tokens"))
        self.assertEqual((e["status"], e["finish_class"]), ("empty", "truncated"))
        self.assertEqual(a("openai", openai_response("  ", "completed"))["status"], "empty")

    def test_openai_without_status_is_not_truncation(self):
        r = NS(output_text=GOOD, usage=None)
        self.assertEqual(server.assess_review_completion("openai", r)["status"], "complete")

    def test_deepseek_states(self):
        a = server.assess_review_completion
        self.assertEqual(a("deepseek", deepseek_response(GOOD, "stop"))["status"], "complete")
        self.assertEqual(a("deepseek", deepseek_response("VERDICT\n\nREV", "length"))["status"], "truncated")
        self.assertEqual(a("deepseek", deepseek_response("", "length"))["status"], "empty")
        self.assertEqual(a("deepseek", deepseek_response(None, "stop"))["status"], "empty")
        self.assertEqual(a("deepseek", deepseek_response("x", "content_filter"))["status"], "incomplete")
        self.assertEqual(a("deepseek", NS(choices=[]))["status"], "empty")

    def test_gemini_wrapper_matches_unified(self):
        r = gemini_response("VERDICT\n\nREV", "MAX_TOKENS")
        self.assertEqual(server.assess_gemini_completion(r), server.assess_review_completion("google_gemini", r))


class OpenAIReview(unittest.TestCase):
    def _run(self, response, **kwargs):
        seen = {}

        def create(**kw):
            seen.update(kw)
            return response

        client = NS(responses=NS(create=create))
        with clean_env(), mock.patch.object(server.OPENAI_ADAPTER, "get_client", lambda: client):
            result = asyncio.run(server.ai_review(task="t", proposal="p", **kwargs))
        return result, seen

    def test_complete_review(self):
        r, seen = self._run(openai_response(GOOD), max_output_tokens=100)
        self.assertTrue(r["success"])
        self.assertFalse(r["incomplete"])
        self.assertEqual(r["review"], GOOD)
        self.assertEqual(r["verdict"], "REVISE")
        self.assertEqual(r["finish_reason"], "completed")
        self.assertEqual((r["provider"], r["actual_provider"], r["fallback_used"]), ("openai", "openai", False))
        self.assertEqual(r["response_id"], "resp_test")
        self.assertEqual(r["output_budget"], {"requested_max_output_tokens": 100, "max_output_tokens": 500})
        self.assertEqual(seen["max_output_tokens"], 500)
        self.assertIs(seen["store"], False)

    def test_truncated_is_not_a_review(self):
        r, _ = self._run(openai_response("VERDICT\n\nREV", "incomplete", "max_output_tokens"))
        self.assertFalse(r["success"])
        self.assertTrue(r["incomplete"])
        self.assertEqual(r["incomplete_status"], "truncated")
        self.assertEqual(r["error_type"], "IncompleteResponse")
        self.assertEqual(r["finish_reason"], "incomplete: max_output_tokens")
        self.assertEqual(r["partial_review"], "VERDICT\n\nREV")
        self.assertNotIn("review", r)
        self.assertIn("max_output_tokens", r["hint"])
        self.assertEqual(r["response_id"], "resp_test")
        self.assertEqual(r["usage"]["output_tokens"], 20)

    def test_empty_with_budget_exhausted(self):
        r, _ = self._run(openai_response("", "incomplete", "max_output_tokens"))
        self.assertEqual((r["success"], r["incomplete"], r["error_type"]), (False, True, "EmptyResponse"))
        self.assertNotIn("review", r)
        self.assertNotIn("partial_review", r)
        self.assertIn("max_output_tokens", r["hint"])

    def test_content_filter_is_incomplete(self):
        r, _ = self._run(openai_response("cut", "incomplete", "content_filter"))
        self.assertEqual((r["success"], r["incomplete_status"]), (False, "incomplete"))

    def test_payload_has_only_safe_metadata(self):
        r, _ = self._run(openai_response("cut", "incomplete", "max_output_tokens"))
        dumped = json.dumps(r, ensure_ascii=False, default=str).lower()
        for needle in ("authorization", "bearer", "api_key", "x-goog", "headers", SENTINEL_KEY):
            self.assertNotIn(needle, dumped)

    def test_exception_path_unchanged(self):
        def boom(**_):
            err = RuntimeError("synthetic")
            err.status_code = 503
            raise err

        client = NS(responses=NS(create=boom))
        with clean_env(), mock.patch.object(server.OPENAI_ADAPTER, "get_client", lambda: client):
            r = asyncio.run(server.ai_review(task="t", proposal="p"))
        self.assertFalse(r["success"])
        self.assertEqual(r["status_code"], 503)
        self.assertNotIn("incomplete", r)

    def test_local_mode_missing_key_still_raises(self):
        with clean_env():
            with self.assertRaises(RuntimeError):
                asyncio.run(server.ai_review(task="t", proposal="p"))


class DeepSeekReview(unittest.TestCase):
    def _run(self, response, **kwargs):
        seen = {}

        def create(**kw):
            seen.update(kw)
            return response

        client = NS(chat=NS(completions=NS(create=create)))
        with clean_env(), mock.patch.object(server.DEEPSEEK_ADAPTER, "get_client", lambda: client):
            result = asyncio.run(server.deepseek_review(task="t", proposal="p", **kwargs))
        return result, seen

    def test_complete_review(self):
        r, seen = self._run(deepseek_response(GOOD, "stop"), max_output_tokens=4096)
        self.assertTrue(r["success"])
        self.assertFalse(r["incomplete"])
        self.assertEqual((r["finish_reason"], r["status_code"], r["timed_out"]), ("stop", 200, False))
        self.assertEqual((r["actual_provider"], r["fallback_used"]), ("deepseek", False))
        self.assertEqual(r["output_budget"], {"requested_max_output_tokens": 4096, "max_output_tokens": 4096})
        self.assertEqual(r["verdict"], "REVISE")
        self.assertEqual(seen["max_tokens"], 4096)

    def test_length_with_text_is_not_success(self):
        r, _ = self._run(deepseek_response("VERDICT\n\nREV", "length"))
        self.assertFalse(r["success"])
        self.assertTrue(r["incomplete"])
        self.assertEqual((r["incomplete_status"], r["error_type"]), ("truncated", "IncompleteResponse"))
        self.assertEqual(r["partial_review"], "VERDICT\n\nREV")
        self.assertNotIn("review", r)
        self.assertEqual(r["finish_reason"], "length")
        self.assertIn("max_tokens", r["hint"])
        self.assertEqual(r["thinking_mode"], "disabled")

    def test_empty_content_with_length(self):
        r, _ = self._run(deepseek_response("", "length"), depth="deep")
        self.assertEqual((r["success"], r["incomplete"], r["error_type"]), (False, True, "EmptyResponse"))
        self.assertEqual(r["thinking_mode"], "enabled")
        self.assertIn("deep", r["hint"])
        self.assertNotIn("partial_review", r)

    def test_empty_content_with_stop(self):
        r, _ = self._run(deepseek_response("  ", "stop"))
        self.assertEqual((r["success"], r["error_type"]), (False, "EmptyResponse"))

    def test_content_filter_is_incomplete(self):
        r, _ = self._run(deepseek_response("some text", "content_filter"))
        self.assertEqual((r["success"], r["incomplete_status"]), (False, "incomplete"))

    def test_deep_budget_floor_is_reported(self):
        r, seen = self._run(deepseek_response("x", "length"), depth="deep", max_output_tokens=1000)
        self.assertEqual(r["output_budget"], {"requested_max_output_tokens": 1000, "max_output_tokens": 4000})
        self.assertEqual(seen["max_tokens"], 4000)


class AiCompareOpenAILeg(unittest.TestCase):
    def _compare(self, openai_resp, gemini_resp):
        oc = NS(responses=NS(create=lambda **_: openai_resp))
        gc = NS(aio=NS(models=NS(generate_content=mock.AsyncMock(return_value=gemini_resp))))
        with clean_env(), mock.patch.object(server.OPENAI_ADAPTER, "get_client", lambda: oc), \
                mock.patch.object(server, "get_gemini_client", lambda: gc):
            return asyncio.run(server.ai_compare(task="t", proposal="p"))

    def test_both_complete(self):
        r = self._compare(openai_response(GOOD), gemini_response(GOOD, "STOP"))
        self.assertEqual((r["status"], r["independent_review_count"]), ("complete", 2))
        self.assertTrue(r["openai"]["success"])

    def test_truncated_openai_not_counted(self):
        r = self._compare(openai_response("VERDICT\n\nREV", "incomplete", "max_output_tokens"),
                          gemini_response(GOOD, "STOP"))
        o = r["openai"]
        self.assertFalse(o["success"])
        self.assertTrue(o["incomplete"])
        self.assertEqual(o["error_type"], "IncompleteResponse")
        self.assertEqual(o["partial_review"], "VERDICT\n\nREV")
        self.assertIsNone(o["review"])
        self.assertEqual((r["status"], r["independent_review_count"]), ("partial", 1))
        self.assertEqual(r["weighted_signal"]["label"], "partial")

    def test_both_incomplete_fails(self):
        r = self._compare(openai_response("x", "incomplete", "max_output_tokens"),
                          gemini_response("x", "MAX_TOKENS"))
        self.assertEqual((r["status"], r["independent_review_count"]), ("failed", 0))
        self.assertFalse(r["success"])


class GeminiReviewOpenAIFallback(unittest.TestCase):
    def _run(self, fallback_response):
        class Transient(Exception):
            status_code = 503

        def boom(**_):
            raise Transient("synthetic")

        async def fake_fallback(**_):
            return {"response": fallback_response, "model": "m",
                    "review": server.OPENAI_ADAPTER.response_text(fallback_response),
                    "usage": {}, "finish_reason": server.OPENAI_ADAPTER.finish_reason(fallback_response),
                    "response_id": "r"}

        async def no_sleep(_):
            return None

        client = NS(aio=NS(models=NS(generate_content=mock.AsyncMock(side_effect=boom))))
        with clean_env(), mock.patch.object(server.GEMINI_ADAPTER, "get_client", lambda: client), \
                mock.patch.object(server, "run_openai_review_fallback", fake_fallback), \
                mock.patch.object(server.asyncio, "sleep", no_sleep):
            return asyncio.run(server.gemini_review(task="t", proposal="p"))

    def test_complete_fallback_still_succeeds(self):
        r = self._run(openai_response(GOOD))
        self.assertTrue(r["success"])
        self.assertTrue(r["fallback_used"])
        self.assertEqual(r["actual_provider"], "openai")

    def test_truncated_fallback_is_not_a_review(self):
        r = self._run(openai_response("cut", "incomplete", "max_output_tokens"))
        self.assertFalse(r["success"])
        self.assertTrue(r["incomplete"])
        self.assertTrue(r["fallback_used"])
        self.assertEqual(r["actual_provider"], "openai")
        self.assertEqual(r["partial_review"], "cut")
        self.assertNotIn("review", r)


class SignaturesUnchanged(unittest.TestCase):
    def test_tool_signatures(self):
        base = ["task", "proposal", "context", "mode", "goal", "constraints", "depth", "max_output_tokens"]
        expected = {
            "ai_review": base,
            "deepseek_review": base + ["timeout_seconds"],
            "gemini_review": base + ["dev_force_gemini_503", "allow_fallback"],
            "ai_compare": base + ["deadline_seconds"],
        }
        for name, params in expected.items():
            self.assertEqual(list(inspect.signature(getattr(server, name)).parameters), params, name)


if __name__ == "__main__":
    unittest.main(verbosity=2)

