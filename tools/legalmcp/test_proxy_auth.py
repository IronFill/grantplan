"""Offline tests for the cloud proxy-auth mode and gemini_review(allow_fallback).

No network, no real keys. Run:
    tools/legalmcp/.venv/bin/python -B tools/legalmcp/test_proxy_auth.py
"""

import asyncio
import importlib.util
import os
import pathlib
import unittest
from types import SimpleNamespace as NS
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parent
KEY_VARS = (
    "OPENAI_API_KEY",
    "GEMINI_API_KEY",
    "DEEPSEEK_API_KEY",
    "LEGALMCP_PROXY_AUTH",
    "CLAUDE_CODE_REMOTE",
)

spec = importlib.util.spec_from_file_location(
    "legalmcp_server_under_test", ROOT / "server.py"
)
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

FAKE_KEY = "test-key-not-a-secret"


def env(**values):
    """Clean environment for the keys/flags under test, plus given values."""
    cleaned = {k: v for k, v in os.environ.items() if k not in KEY_VARS}
    cleaned.update(values)
    return mock.patch.dict(os.environ, cleaned, clear=True)


class ProxyAuthMode(unittest.TestCase):
    def test_local_mode_unchanged_without_key(self):
        with env():
            self.assertFalse(server.proxy_auth_enabled())
            self.assertEqual(server.resolve_provider_key("OPENAI_API_KEY"), ("", "none"))
            for factory in (
                server.get_openai_client,
                server.get_gemini_client,
                server.get_deepseek_client,
            ):
                with self.assertRaises(RuntimeError):
                    factory()

    def test_local_mode_real_key_from_env(self):
        with env(OPENAI_API_KEY=FAKE_KEY):
            self.assertEqual(
                server.resolve_provider_key("OPENAI_API_KEY"), (FAKE_KEY, "env")
            )
            self.assertEqual(server.get_openai_client().api_key, FAKE_KEY)

    def test_flag_alone_is_not_enough(self):
        with env(LEGALMCP_PROXY_AUTH="1"):
            self.assertFalse(server.proxy_auth_enabled())
            with self.assertRaises(RuntimeError):
                server.get_openai_client()

    def test_remote_alone_is_not_enough(self):
        with env(CLAUDE_CODE_REMOTE="true"):
            self.assertFalse(server.proxy_auth_enabled())
            with self.assertRaises(RuntimeError):
                server.get_deepseek_client()

    def test_falsy_flag_values(self):
        for value in ("", "0", "false", "no", "off", "2"):
            with env(LEGALMCP_PROXY_AUTH=value, CLAUDE_CODE_REMOTE="true"):
                self.assertFalse(server.proxy_auth_enabled(), value)

    def test_opt_in_gives_placeholder_to_all_sdks(self):
        with env(LEGALMCP_PROXY_AUTH="1", CLAUDE_CODE_REMOTE="true"):
            self.assertTrue(server.proxy_auth_enabled())
            ph = server.PROXY_AUTH_PLACEHOLDER
            self.assertEqual(server.get_openai_client().api_key, ph)
            deepseek = server.get_deepseek_client()
            self.assertEqual(deepseek.api_key, ph)
            self.assertTrue(str(deepseek.base_url).startswith("https://api.deepseek.com"))
            gemini = server.get_gemini_client()
            self.assertEqual(gemini._api_client.api_key, ph)

    def test_real_key_wins_in_opt_in_mode(self):
        with env(LEGALMCP_PROXY_AUTH="1", CLAUDE_CODE_REMOTE="true", GEMINI_API_KEY=FAKE_KEY):
            self.assertEqual(server.resolve_provider_key("GEMINI_API_KEY"), (FAKE_KEY, "env"))
            self.assertEqual(server.get_gemini_client()._api_client.api_key, FAKE_KEY)
            self.assertEqual(
                server.resolve_provider_key("OPENAI_API_KEY")[1], "proxy_placeholder"
            )

    def test_placeholder_is_not_key_shaped(self):
        ph = server.PROXY_AUTH_PLACEHOLDER
        self.assertFalse(ph.startswith(("sk-", "AIza")))
        self.assertIn("placeholder", ph)

    def test_system_health_reports_source_not_values(self):
        with env(LEGALMCP_PROXY_AUTH="1", CLAUDE_CODE_REMOTE="true", OPENAI_API_KEY=FAKE_KEY):
            health = server.system_health()
            self.assertTrue(health["proxy_auth_enabled"])
            self.assertEqual(
                health["provider_key_source"],
                {"openai": "env", "google_gemini": "proxy_placeholder", "deepseek": "proxy_placeholder"},
            )
            # existing meaning kept: "configured" = a real key in the environment
            self.assertTrue(health["openai_key_configured"])
            self.assertFalse(health["gemini_key_configured"])
            self.assertNotIn(FAKE_KEY, repr(health))
            self.assertNotIn(server.PROXY_AUTH_PLACEHOLDER, repr(health))


class _Transient503(Exception):
    status_code = 503


class GeminiFallbackSwitch(unittest.TestCase):
    def _run(self, **kwargs):
        openai_calls = []

        async def fake_openai(**call_kwargs):
            openai_calls.append(call_kwargs)
            response = NS(output_text="VERDICT\n\nACCEPT", status="completed", incomplete_details=None, id="r")
            return {"response": response, "model": "fake", "review": "x", "usage": {}, "response_id": "r", "finish_reason": "completed"}

        class FakeModels:
            async def generate_content(self, **_):
                raise _Transient503("synthetic")

        class FakeClient:
            aio = NS(models=FakeModels())

        async def no_sleep(_):
            return None

        with env(), mock.patch.object(
            server.GEMINI_ADAPTER, "get_client", lambda: FakeClient()
        ), mock.patch.object(
            server, "run_openai_review_fallback", fake_openai
        ), mock.patch.object(server.asyncio, "sleep", no_sleep):
            result = asyncio.run(
                server.gemini_review(task="t", proposal="p", **kwargs)
            )
        return result, openai_calls

    def test_default_keeps_openai_fallback(self):
        result, calls = self._run()
        self.assertEqual(len(calls), 1)
        self.assertTrue(result["success"], result.get("error"))
        self.assertTrue(result["fallback_used"])
        self.assertEqual(result["actual_provider"], "openai")
        self.assertEqual(result["requested_provider"], "google_gemini")

    def test_allow_fallback_false_never_calls_openai(self):
        result, calls = self._run(allow_fallback=False)
        self.assertEqual(calls, [])
        self.assertFalse(result["success"])
        self.assertFalse(result["fallback_used"])
        self.assertFalse(result["fallback_allowed"])
        self.assertEqual(result["actual_provider"], "google_gemini")
        self.assertEqual(result["status_code"], 503)
        self.assertTrue(result["retryable"])


if __name__ == "__main__":
    unittest.main(verbosity=2)

