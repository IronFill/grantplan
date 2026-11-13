"""Offline tests for the Grok creative critic (grok_critic.py) and its registration.

No network, no real keys: httpx.MockTransport and synthetic values only.

    tools/legalmcp/.venv/bin/python -B tools/legalmcp/test_grok_critic.py
"""

import asyncio
import importlib.util
import json
import os
import pathlib
import sys
import unittest
from unittest import mock

import httpx

ROOT = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import grok_critic as g  # noqa: E402

FAKE_KEY = "synthetic-not-a-secret"
ENV_VARS = ("GROK_REVIEW_MODEL", "GROK_REASONING_EFFORT", "XAI_API_KEY",
            "LEGALMCP_PROXY_AUTH", "CLAUDE_CODE_REMOTE")


def clean_env(**values):
    cleaned = {k: v for k, v in os.environ.items() if k not in ENV_VARS}
    cleaned.update(values)
    return mock.patch.dict(os.environ, cleaned, clear=True)


def response_body(**overrides):
    critique = {"verdict": "Нужна более конкретная польза",
                **{key: ["Конкретное замечание"] for key in g.FIELDS[1:]}}
    body = {"model": "grok-4.7", "status": "completed", "output": [
        {"type": "reasoning", "encrypted_content": "do-not-return"},
        {"type": "message", "role": "assistant", "status": "completed",
         "content": [{"type": "output_text", "text": json.dumps(critique)}]}],
        "usage": {"input_tokens": 42, "output_tokens": 100, "total_tokens": 142,
                  "output_tokens_details": {"reasoning_tokens": 30},
                  "cost_in_usd_ticks": 12345, "secret_field": FAKE_KEY}}
    body.update(overrides)
    return body


class ReviewTests(unittest.IsolatedAsyncioTestCase):
    async def call(self, body=None, code=200, exception=None, key=FAKE_KEY, env=None, **kwargs):
        calls, clients = [], []

        def handle(request):
            calls.append(request)
            if exception:
                raise exception
            return httpx.Response(code, json=body if body is not None else response_body())

        def factory(**options):
            client = httpx.AsyncClient(transport=httpx.MockTransport(handle), **options)
            clients.append(client)
            return client

        with clean_env(**(env or {})):
            result = await g.creative_review("Review ad", "Business plan ad", "Public facts",
                key_resolver=lambda _: (key, "env" if key else "none"),
                client_factory=factory, **kwargs)
        self.assertTrue(all(client.is_closed for client in clients))
        return result, calls

    async def test_complete_independent_review(self):
        result, calls = await self.call()
        self.assertTrue(result["success"])
        self.assertFalse(result["incomplete"])
        self.assertEqual(result["status"], "complete")
        self.assertEqual(result["actual_provider"], "xai")
        self.assertEqual(result["actual_model"], "grok-4.7")
        self.assertEqual(result["requested_model"], "grok-4.7")
        self.assertFalse(result["fallback_used"])
        self.assertFalse(result["search_enabled"])
        self.assertEqual(result["attempts_used"], 1)
        self.assertEqual(len(calls), 1)
        self.assertEqual(result["usage"], {"input_tokens": 42, "output_tokens": 100,
            "total_tokens": 142, "reasoning_tokens": 30, "cost_in_usd_ticks": 12345})
        text = json.dumps(result)
        for forbidden in ("encrypted_content", "do-not-return", FAKE_KEY, "Bearer", "secret_field"):
            self.assertNotIn(forbidden, text)

    async def test_request_shape_follows_xai_responses_docs(self):
        result, calls = await self.call()
        self.assertEqual(str(calls[0].url), g.ENDPOINT)
        self.assertEqual(calls[0].headers["authorization"], "Bearer " + FAKE_KEY)
        payload = json.loads(calls[0].content)
        self.assertEqual(payload["model"], "grok-4.7")
        self.assertFalse(payload["store"])
        self.assertEqual(payload["max_output_tokens"], 3000)
        self.assertEqual(payload["reasoning"], {"effort": "low"})
        self.assertNotIn("instructions", payload)
        self.assertNotIn("previous_response_id", payload)
        roles = [m["role"] for m in payload["input"]]
        self.assertEqual(roles, ["system", "user"])
        self.assertEqual(payload["input"][0]["content"], g.INSTRUCTIONS)
        self.assertEqual(json.loads(payload["input"][1]["content"])["proposal"], "Business plan ad")
        for forbidden in ("tools", "tool_choice", "include", "search_parameters", "web_search"):
            self.assertNotIn(forbidden, payload)
        self.assertNotIn("web_search", json.dumps(payload))
        fmt = payload["text"]["format"]
        self.assertEqual((fmt["type"], fmt["strict"]), ("json_schema", True))
        self.assertEqual(fmt["schema"], g.SCHEMA)
        self.assertFalse(fmt["schema"]["additionalProperties"])
        self.assertEqual(set(fmt["schema"]["required"]), set(g.FIELDS))

    async def test_model_and_effort_come_from_settings_only(self):
        result, calls = await self.call(
            response_body(model="grok-4.6"),
            env={"GROK_REVIEW_MODEL": "grok-4.6", "GROK_REASONING_EFFORT": "MEDIUM"})
        payload = json.loads(calls[0].content)
        self.assertEqual((payload["model"], payload["reasoning"]["effort"]), ("grok-4.6", "medium"))
        self.assertTrue(result["success"])
        self.assertEqual(result["reasoning_effort"], "medium")

    async def test_no_silent_model_substitution(self):
        for returned in ("grok-4.6", "grok-4.70", "different-provider", None, 7):
            with self.subTest(returned=returned):
                body = response_body()
                body["model"] = returned
                result, calls = await self.call(body)
                self.assertEqual(result["error"], "model_mismatch")
                self.assertFalse(result["success"])
                self.assertNotIn("review", result)
                self.assertEqual(len(calls), 1)
        result, _ = await self.call(response_body(model="grok-4.7-0309"))
        self.assertTrue(result["success"])  # dated alias of the requested model

    async def test_errors_do_not_retry_or_echo(self):
        expected = {400: "request_rejected", 401: "authentication_error",
                    403: "authentication_error", 404: "model_or_endpoint_not_found",
                    429: "rate_limited", 500: "provider_unavailable",
                    502: "provider_unavailable", 503: "provider_unavailable"}
        for code, error in expected.items():
            with self.subTest(code=code):
                result, calls = await self.call({"secret": FAKE_KEY, "error": "private"}, code)
                self.assertFalse(result["success"])
                self.assertTrue(result["incomplete"])
                self.assertEqual(result["error"], error)
                self.assertEqual(len(calls), 1)  # no retry
                self.assertEqual(result["http_status"], code)
                self.assertEqual(result["actual_provider"], "xai")
                self.assertFalse(result["fallback_used"])
                self.assertNotIn(FAKE_KEY, json.dumps(result))
                self.assertNotIn("private", json.dumps(result))

    async def test_redirects_are_not_followed(self):
        calls = []
        options_seen = []

        def handle(request):
            calls.append(str(request.url))
            return httpx.Response(302, headers={"location": "https://example.invalid/steal"})

        def factory(**options):
            options_seen.append(options)
            return httpx.AsyncClient(transport=httpx.MockTransport(handle), **options)

        with clean_env():
            result = await g.creative_review("t", "p", key_resolver=lambda _: (FAKE_KEY, "env"),
                                             client_factory=factory)
        self.assertEqual(calls, [g.ENDPOINT])
        self.assertEqual(result["error"], "request_rejected")
        self.assertFalse(options_seen[0]["follow_redirects"])

    async def test_missing_key_no_request(self):
        result = await g.creative_review("task", "ad", key_resolver=lambda _: ("", "none"),
            client_factory=lambda **_: self.fail("Must not create HTTP client"))
        self.assertEqual(result["error"], "missing_api_key")
        self.assertEqual(result["attempts_used"], 0)
        self.assertIsNone(result["actual_provider"])  # nothing was sent anywhere
        self.assertEqual(result["key_source"], "none")

    async def test_truncated_response_is_not_a_review_and_keeps_usage(self):
        body = response_body(status="incomplete", incomplete_details={"reason": "max_output_tokens"})
        result, _ = await self.call(body)
        self.assertEqual(result["error"], "incomplete_response")
        self.assertEqual(result["incomplete_reason"], "max_output_tokens")
        self.assertEqual(result["usage"]["reasoning_tokens"], 30)  # billed tokens stay visible
        self.assertEqual(result["actual_model"], "grok-4.7")
        self.assertNotIn("review", result)
        self.assertFalse(result["success"])
        body = response_body(status="incomplete", incomplete_details={"reason": "<script>"})
        result, _ = await self.call(body)
        self.assertEqual(result["incomplete_reason"], "other")

    async def test_non_completed_statuses_rejected(self):
        for status in ("in_progress", "failed", "cancelled", None, ""):
            with self.subTest(status=status):
                result, _ = await self.call(response_body(status=status))
                self.assertEqual(result["error"], "incomplete_response")

    async def test_refusal_rejected(self):
        body = response_body()
        body["output"][1]["content"] = [{"type": "refusal", "refusal": "no"}]
        result, _ = await self.call(body)
        self.assertEqual(result["error"], "refused")

    async def test_empty_or_invalid_schema_rejected(self):
        base = {key: ["x"] for key in g.FIELDS[1:]}
        cases = ["", "broken", "{}", "[]", '{"verdict":""}',
                 json.dumps({**base, "verdict": "   "}),
                 json.dumps({**base, "verdict": "ok", "extra": 1}),
                 json.dumps({**base, "verdict": "ok", "strengths": "not a list"}),
                 json.dumps({**base, "verdict": "ok", "test_plan": [""]}),
                 json.dumps({"verdict": "ok", **{key: [] for key in g.FIELDS[1:]}})]
        for text in cases:
            with self.subTest(text=text[:40]):
                body = response_body()
                body["output"][1]["content"][0]["text"] = text
                result, _ = await self.call(body)
                self.assertFalse(result["success"])
                self.assertTrue(result["incomplete"])
                self.assertNotIn("review", result)

    async def test_no_message_item_is_not_a_review(self):
        body = response_body()
        body["output"] = [body["output"][0]]
        result, _ = await self.call(body)
        self.assertFalse(result["success"])
        self.assertEqual(result["error"], "invalid_review_json")

    async def test_message_incomplete_rejected(self):
        body = response_body()
        body["output"][1]["status"] = "in_progress"
        result, _ = await self.call(body)
        self.assertEqual(result["error"], "incomplete_response")

    async def test_malformed_bodies_rejected(self):
        for body in ([], "text", {"model": "grok-4.7", "status": "completed"},
                     response_body(output="x"), response_body(output=["x"])):
            with self.subTest(body=str(body)[:30]):
                result, _ = await self.call(body)
                self.assertFalse(result["success"])
                self.assertIn(result["error"], {"invalid_response", "model_mismatch"})

    async def test_non_json_and_oversized_responses_rejected(self):
        def factory(content):
            return lambda **options: httpx.AsyncClient(
                transport=httpx.MockTransport(lambda r: httpx.Response(200, content=content)), **options)
        with clean_env():
            for content, error in ((b"<html>not json</html>", "invalid_response"),
                                   (b" " * 2_000_001, "response_too_large")):
                result = await g.creative_review("t", "p", key_resolver=lambda _: (FAKE_KEY, "env"),
                                                 client_factory=factory(content))
                self.assertEqual(result["error"], error)
                self.assertFalse(result["success"])

    async def test_timeout_and_network_error(self):
        for exc, expected in ((httpx.ReadTimeout("private"), "timeout"),
                              (httpx.ConnectError("private"), "network_error")):
            result, calls = await self.call(exception=exc)
            self.assertEqual(result["error"], expected)
            self.assertEqual(len(calls), 1)  # no retry
            self.assertNotIn("private", json.dumps(result))

    async def test_cancellation_propagates_and_closes(self):
        with self.assertRaises(asyncio.CancelledError):
            await self.call(exception=asyncio.CancelledError())

    async def test_input_limits(self):
        for kwargs in ({"max_output_tokens": 0}, {"max_output_tokens": 499}, {"max_output_tokens": 8001},
                       {"max_output_tokens": True}, {"timeout_seconds": 200}, {"timeout_seconds": 14},
                       {"timeout_seconds": float("nan")}, {"timeout_seconds": True}):
            with self.subTest(**kwargs), self.assertRaises(ValueError):
                await self.call(**kwargs)
        for args in (("t", "x" * 40001), ("", "p"), ("t", "   "), ("t", 5)):
            with self.subTest(args=str(args)[:20]), self.assertRaises(ValueError):
                await g.creative_review(*args)

    async def test_invalid_settings_rejected_before_any_request(self):
        for env in ({"GROK_REVIEW_MODEL": "gpt-5"}, {"GROK_REVIEW_MODEL": "grok-4.7 x"},
                    {"GROK_REASONING_EFFORT": "max"}):
            with self.subTest(env=env), self.assertRaises(ValueError):
                await self.call(env=env)


class SettingsAndStatus(unittest.TestCase):
    def test_defaults(self):
        with clean_env():
            self.assertEqual(g.settings()["model"], "grok-4.7")
            self.assertEqual(g.settings()["reasoning_effort"], "low")
        with clean_env(GROK_REVIEW_MODEL="   ", GROK_REASONING_EFFORT=""):
            self.assertEqual(g.settings()["model"], "grok-4.7")

    def test_status_never_raises_and_has_no_key(self):
        with clean_env(GROK_REASONING_EFFORT="bogus"):
            result = g.status()
            self.assertFalse(result["configured"])
            self.assertEqual(result["error"], "invalid_grok_configuration")
        with clean_env():
            self.assertTrue(g.status()["configured"])


class FakeMCP:
    def __init__(self):
        self.tools = {}

    def tool(self):
        def decorate(func):
            self.tools[func.__name__] = func
            return func
        return decorate


class RegistrationTests(unittest.IsolatedAsyncioTestCase):
    async def test_registration_and_status(self):
        server = FakeMCP()
        g.register_grok_tools(server, lambda _: ("", "none"))
        self.assertEqual(set(server.tools), {"grok_review", "grok_status"})
        with clean_env():
            status = await server.tools["grok_status"]()
            self.assertFalse(status["credential_configured"])
            self.assertFalse(status["live_verified"])
            self.assertEqual(status["key_source"], "none")
            result = await server.tools["grok_review"]("t", "p")
        self.assertEqual(result["error"], "missing_api_key")
        self.assertTrue(server.tools["grok_review"].__doc__)

    async def test_status_reports_source_not_key(self):
        server = FakeMCP()
        g.register_grok_tools(server, lambda _: (FAKE_KEY, "proxy_placeholder"))
        with clean_env():
            status = await server.tools["grok_status"]()
        self.assertTrue(status["credential_configured"])
        self.assertEqual(status["key_source"], "proxy_placeholder")
        self.assertNotIn(FAKE_KEY, json.dumps(status))

    async def test_env_fallback_without_resolver(self):
        server = FakeMCP()
        g.register_grok_tools(server)
        with clean_env(XAI_API_KEY=FAKE_KEY):
            status = await server.tools["grok_status"]()
        self.assertEqual(status["key_source"], "env")
        self.assertNotIn(FAKE_KEY, json.dumps(status))


def load_server():
    spec = importlib.util.spec_from_file_location("legalmcp_server_grok_test", ROOT / "server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class ServerIntegration(unittest.IsolatedAsyncioTestCase):
    @classmethod
    def setUpClass(cls):
        with clean_env():
            cls.server = load_server()

    async def test_server_registers_grok_tools_and_keeps_old_ones(self):
        names = {tool.name for tool in await self.server.mcp.list_tools()}
        self.assertEqual(len(names), 22)
        self.assertTrue({"grok_review", "grok_status", "ai_review", "gemini_review",
                         "deepseek_review", "ai_compare", "system_health"} <= names)

    async def test_registration_precedes_main_run(self):
        text = (ROOT / "server.py").read_text(encoding="utf-8")
        self.assertEqual(text.count("grok_critic.register_grok_tools(mcp, resolve_provider_key)"), 1)
        self.assertLess(text.index("grok_critic.register_grok_tools(mcp, resolve_provider_key)"),
                        text.index("mcp.run("))

    def test_proxy_placeholder_is_used_in_explicit_proxy_mode_only(self):
        resolver = self.server.resolve_provider_key
        with clean_env():
            self.assertEqual(resolver("XAI_API_KEY"), ("", "none"))
        with clean_env(LEGALMCP_PROXY_AUTH="1"):
            self.assertEqual(resolver("XAI_API_KEY"), ("", "none"))  # flag alone is not enough
        with clean_env(LEGALMCP_PROXY_AUTH="1", CLAUDE_CODE_REMOTE="true"):
            self.assertEqual(resolver("XAI_API_KEY"),
                             (self.server.PROXY_AUTH_PLACEHOLDER, "proxy_placeholder"))
        with clean_env(LEGALMCP_PROXY_AUTH="1", CLAUDE_CODE_REMOTE="true", XAI_API_KEY=FAKE_KEY):
            self.assertEqual(resolver("XAI_API_KEY"), (FAKE_KEY, "env"))

    async def test_review_in_proxy_mode_sends_placeholder_and_reports_source(self):
        seen = []

        def handle(request):
            seen.append(request.headers["authorization"])
            return httpx.Response(200, json=response_body())

        def factory(**options):
            return httpx.AsyncClient(transport=httpx.MockTransport(handle), **options)

        with clean_env(LEGALMCP_PROXY_AUTH="1", CLAUDE_CODE_REMOTE="true"):
            result = await g.creative_review("t", "p", key_resolver=self.server.resolve_provider_key,
                                             client_factory=factory)
        self.assertTrue(result["success"])
        self.assertEqual(result["key_source"], "proxy_placeholder")
        self.assertEqual(seen, ["Bearer " + self.server.PROXY_AUTH_PLACEHOLDER])

    def test_system_health_reports_grok_without_key(self):
        with clean_env(LEGALMCP_PROXY_AUTH="1", CLAUDE_CODE_REMOTE="true", XAI_API_KEY=FAKE_KEY):
            health = self.server.system_health()
        self.assertTrue(health["xai_key_configured"])
        self.assertEqual(health["grok_critic"]["key_source"], "env")
        self.assertNotIn("xai_grok", health["provider_key_source"])  # old contract untouched
        self.assertEqual(health["grok_critic"]["model"], "grok-4.7")
        self.assertEqual(health["grok_critic"]["role"], "independent_creative_critic")
        self.assertNotIn(FAKE_KEY, json.dumps(health))
        with clean_env(LEGALMCP_PROXY_AUTH="1", CLAUDE_CODE_REMOTE="true"):
            health = self.server.system_health()
        self.assertFalse(health["xai_key_configured"])
        self.assertEqual(health["grok_critic"]["key_source"], "proxy_placeholder")
        with clean_env(GROK_REVIEW_MODEL="bad"):
            self.assertFalse(self.server.system_health()["grok_critic"]["configured"])

    async def test_self_test_stays_offline_and_unchanged(self):
        with clean_env(LEGALMCP_PROXY_AUTH="1", CLAUDE_CODE_REMOTE="true"):
            report = await self.server.provider_layer_self_test(live=False)
        self.assertEqual(report["summary"], {"total": 49, "passed": 49, "failed": 0})
        self.assertNotIn("xai", json.dumps(report).lower())


if __name__ == "__main__":
    unittest.main()
