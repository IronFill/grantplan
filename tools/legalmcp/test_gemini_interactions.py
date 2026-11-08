"""Offline tests: Gemini API modes (generate_content default, interactions opt-in).

No network and no real keys: Interactions HTTP is served by httpx.MockTransport,
the legacy path by a fake SDK client. Run:
    tools/legalmcp/.venv/bin/python -B tools/legalmcp/test_gemini_interactions.py
"""

import asyncio
import contextlib
import importlib.util
import json
import os
import pathlib
import unittest
from types import SimpleNamespace as NS
from unittest import mock

import httpx

ROOT = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location(
    "legalmcp_server_interactions_test", ROOT / "server.py"
)
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

URL = "https://generativelanguage.googleapis.com/v1beta/interactions"
PLACEHOLDER = server.PROXY_AUTH_PLACEHOLDER
FAKE_KEY = "test-key-not-a-secret-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123"
GOOD = "VERDICT\n\nREVISE\n\nWHAT IS GOOD\n\n- ok\n\nFINAL NOTE\n\nShort summary of the review."
USAGE = {"total_input_tokens": 10, "total_output_tokens": 20, "total_thought_tokens": 5, "total_tokens": 35}
CLEAN = (
    "GEMINI_API_MODE", "GEMINI_API_KEY", "OPENAI_API_KEY", "DEEPSEEK_API_KEY",
    "LEGALMCP_PROXY_AUTH", "CLAUDE_CODE_REMOTE", "GEMINI_STANDARD_THINKING_LEVEL",
    "LEGALMCP_ENABLE_FAULT_INJECTION",
)


def env(**values):
    cleaned = {k: v for k, v in os.environ.items() if k not in CLEAN}
    cleaned.update(values)
    return mock.patch.dict(os.environ, cleaned, clear=True)


def text_step(text, kind="model_output"):
    return {"type": kind, "content": [{"type": "text", "text": text}]}


def thought_step():
    return {"type": "thought", "summary": [{"type": "text", "text": "thinking about it"}]}


def good_steps(text=GOOD):
    return [text_step("input", "user_input"), thought_step(), text_step(text)]


def interaction(status="completed", steps=None, usage=USAGE, **extra):
    body = {"object": "interaction", "model": "gemini-3.8-flash", "status": status,
            "steps": good_steps() if steps is None else steps, "usage": usage}
    body.update(extra)
    return body


class Recorder:
    """httpx.MockTransport handler that records every request."""

    def __init__(self, responses):
        self.responses = list(responses)
        self.requests = []

    def __call__(self, request):
        self.requests.append(request)
        item = self.responses[min(len(self.requests), len(self.responses)) - 1]
        if isinstance(item, httpx.Response):
            return item
        status, body = item
        if isinstance(body, (bytes, str)):
            return httpx.Response(status, content=body)
        return httpx.Response(status, json=body)

    def body(self, index=0):
        return json.loads(self.requests[index].content)


@contextlib.contextmanager
def interactions_env(handler, extra_env=None, **env_values):
    values = {"GEMINI_API_MODE": "interactions", "LEGALMCP_PROXY_AUTH": "1", "CLAUDE_CODE_REMOTE": "true"}
    values.update(env_values)

    async def no_sleep(_):
        return None

    def boom(*_a, **_k):
        raise AssertionError("SDK client must not be created in interactions mode")

    with env(**values), mock.patch.object(server, "GEMINI_INTERACTIONS_TRANSPORT", httpx.MockTransport(handler)), \
            mock.patch.object(server.asyncio, "sleep", no_sleep), \
            mock.patch.object(server.GEMINI_ADAPTER, "get_client", boom):
        yield


def review(**kwargs):
    args = {"task": "TASK-MARKER", "proposal": "PROPOSAL-MARKER", "allow_fallback": False}
    args.update(kwargs)
    return asyncio.run(server.gemini_review(**args))


def run_interactions(responses, **kwargs):
    handler = Recorder(responses)
    with interactions_env(handler):
        result = review(**kwargs)
    return result, handler


class ModeSelection(unittest.TestCase):
    def test_default_and_values(self):
        with env():
            self.assertEqual(server.gemini_api_mode(), "generate_content")
        for value, expected in (("interactions", "interactions"), (" Interactions ", "interactions"),
                                ("generate_content", "generate_content"), ("", "generate_content")):
            with env(GEMINI_API_MODE=value):
                self.assertEqual(server.gemini_api_mode(), expected, value)

    def test_invalid_value_is_an_error_not_a_silent_default(self):
        with env(GEMINI_API_MODE="interaction"):
            with self.assertRaises(ValueError):
                server.gemini_api_mode()
            with self.assertRaises(ValueError):
                asyncio.run(server.gemini_review(task="t", proposal="p"))
            with self.assertRaises(ValueError):
                asyncio.run(server.ai_compare(task="t", proposal="p"))
            self.assertEqual(server.safe_gemini_api_mode(), "invalid")

    def test_system_health_reports_mode_without_secrets(self):
        with env(GEMINI_API_MODE="interactions", GEMINI_API_KEY=FAKE_KEY):
            health = server.system_health()
        self.assertEqual(health["gemini_api_mode"], "interactions")
        self.assertNotIn(FAKE_KEY, json.dumps(health, default=str))
        with env():
            self.assertEqual(server.system_health()["gemini_api_mode"], "generate_content")

    def test_project_mcp_env_enables_interactions_only_there(self):
        config = json.loads((ROOT.parent.parent / ".mcp.json").read_text(encoding="utf-8"))
        self.assertEqual(config["mcpServers"]["LegalMCP"]["env"]["GEMINI_API_MODE"], "interactions")
        for name in ("launch.sh", "setup.sh"):
            self.assertNotIn("GEMINI_API_MODE", (ROOT / name).read_text(encoding="utf-8"))


class RequestShape(unittest.TestCase):
    def test_exact_request(self):
        result, handler = run_interactions([(200, interaction())])
        self.assertTrue(result["success"], result)
        self.assertEqual(len(handler.requests), 1)
        request = handler.requests[0]
        self.assertEqual((request.method, str(request.url)), ("POST", URL))
        body = handler.body()
        self.assertEqual(
            sorted(body),
            ["background", "generation_config", "input", "model", "store", "stream", "system_instruction"],
        )
        self.assertIs(body["store"], False)
        self.assertIs(body["background"], False)
        self.assertIs(body["stream"], False)
        self.assertNotIn("tools", body)
        self.assertEqual(body["model"], "gemini-3.8-flash")
        self.assertEqual(body["generation_config"], {"max_output_tokens": 4000, "thinking_level": "low"})

    def test_whole_prompt_and_system_instruction_are_kept(self):
        _, handler = run_interactions(
            [(200, interaction())], mode="legal", context="CONTEXT-MARKER", goal="GOAL-MARKER",
            constraints="CONSTRAINTS-MARKER")
        body = handler.body()
        for marker in ("TASK-MARKER", "PROPOSAL-MARKER", "CONTEXT-MARKER", "GOAL-MARKER", "CONSTRAINTS-MARKER",
                       "VERDICT", "FINAL NOTE", "CLAUDE PROPOSAL"):
            self.assertIn(marker, body["input"], marker)
        self.assertIn(server.build_review_instructions("legal"), body["system_instruction"])
        self.assertIn("независимый Gemini reviewer", body["system_instruction"])
        self.assertNotIn("PROPOSAL-MARKER", body["system_instruction"])

    def test_thinking_levels(self):
        cases = (
            ({"depth": "standard"}, {}, "low"),
            ({"depth": "deep"}, {}, "high"),
            ({"depth": "standard"}, {"GEMINI_STANDARD_THINKING_LEVEL": "minimal"}, "low"),
            ({"depth": "standard"}, {"GEMINI_STANDARD_THINKING_LEVEL": "medium"}, "medium"),
        )
        for kwargs, extra, expected in cases:
            handler = Recorder([(200, interaction())])
            with interactions_env(handler, **extra):
                review(**kwargs)
            level = handler.body()["generation_config"]["thinking_level"]
            self.assertEqual(level, expected, (kwargs, extra))
            self.assertNotEqual(level, "minimal")

    def test_standard_floor_and_ceiling(self):
        _, handler = run_interactions([(200, interaction())], max_output_tokens=500)
        self.assertEqual(handler.body()["generation_config"]["max_output_tokens"], 2048)
        _, handler = run_interactions([(200, interaction())], max_output_tokens=99999)
        self.assertEqual(handler.body()["generation_config"]["max_output_tokens"], 8000)


class ProxyAuthAndSecrets(unittest.TestCase):
    def test_placeholder_header_in_cloud_proxy_mode(self):
        _, handler = run_interactions([(200, interaction())])
        request = handler.requests[0]
        self.assertEqual(request.headers["x-goog-api-key"], PLACEHOLDER)
        self.assertNotIn("authorization", request.headers)
        self.assertNotIn(PLACEHOLDER, handler.requests[0].content.decode())

    def test_real_key_wins_and_stays_in_header_only(self):
        handler = Recorder([(200, interaction())])
        with interactions_env(handler, GEMINI_API_KEY=FAKE_KEY):
            result = review()
        self.assertEqual(handler.requests[0].headers["x-goog-api-key"], FAKE_KEY)
        self.assertNotIn(FAKE_KEY, handler.requests[0].content.decode())
        self.assertNotIn(FAKE_KEY, json.dumps(result, ensure_ascii=False, default=str))

    def test_local_mode_without_key_behaves_like_legacy(self):
        def outcome(mode):
            with env(GEMINI_API_MODE=mode):
                try:
                    return ("returned", asyncio.run(server.gemini_review(task="t", proposal="p", allow_fallback=False))["success"])
                except Exception as exc:
                    return ("raised", type(exc).__name__)
        self.assertEqual(outcome("interactions"), outcome("generate_content"))

    def test_errors_never_contain_keys(self):
        leak = {"error": {"code": "invalid_request",
                          "message": f"bad key {FAKE_KEY} Bearer {FAKE_KEY} x-goog-api-key: {FAKE_KEY} "
                                     "see https://example.test/?key=AIzaSyA1234567890abcdefghijklmnop "
                                     "project 123456789012"}}
        for status in (400, 401, 403, 429, 500, 503):
            handler = Recorder([(status, leak)])
            with interactions_env(handler, GEMINI_API_KEY=FAKE_KEY):
                result = review()
            dumped = json.dumps(result, ensure_ascii=False, default=str)
            for needle in (FAKE_KEY, "AIzaSy", "123456789012", "Bearer", "https://example.test"):
                self.assertNotIn(needle, dumped, (status, needle))
            self.assertFalse(result["success"])

    def test_short_keys_are_scrubbed_by_exact_match(self):
        short = "k-short-123"  # too short for any key-shaped pattern
        for status in (400, 503):
            handler = Recorder([(status, {"error": {"code": "invalid_request", "message": f"rejected {short} here"}})])
            with interactions_env(handler, GEMINI_API_KEY=short):
                result = review()
            self.assertNotIn(short, json.dumps(result, ensure_ascii=False, default=str), status)

    def test_sanitizer(self):
        text = server.sanitize_gemini_error_text(f"{FAKE_KEY} AIzaSyA1234567890abcdef 99999999 https://x.y/z?k=1", FAKE_KEY)
        for needle in (FAKE_KEY, "AIzaSy", "99999999", "https://"):
            self.assertNotIn(needle, text)
        self.assertLessEqual(len(server.sanitize_gemini_error_text("a " * 500)), 300)


class CompleteResponse(unittest.TestCase):
    def test_success_fields(self):
        result, _ = run_interactions([(200, interaction())])
        self.assertTrue(result["success"])
        self.assertFalse(result["incomplete"])
        self.assertEqual(result["review"], GOOD)
        self.assertEqual(result["verdict"], "REVISE")
        self.assertEqual(result["review_chars"], len(GOOD))
        self.assertEqual((result["requested_provider"], result["actual_provider"], result["fallback_used"]),
                         ("google_gemini", "google_gemini", False))
        self.assertEqual((result["api_mode"], result["primary_api_mode"], result["transport"]),
                         ("interactions", "interactions", "httpx_async_post"))
        self.assertEqual(result["interaction_status"], "completed")
        self.assertIsNone(result["finish_reason"])
        self.assertEqual(result["step_types"], ["user_input", "thought", "model_output"])
        self.assertEqual(result["usage"], {"input_tokens": 10, "output_tokens": 20, "thinking_tokens": 5, "total_tokens": 35})
        self.assertEqual((result["model"], result["requested_model"], result["actual_model"]),
                         ("gemini-3.8-flash",) * 3)
        self.assertEqual((result["status_code"], result["primary_attempts"], result["attempts_used"]), (200, 1, 1))

    def test_text_comes_only_from_the_final_model_output(self):
        steps = [thought_step(), text_step("hidden thought-like text", "user_input"), text_step(GOOD)]
        result, _ = run_interactions([(200, interaction(steps=steps))])
        self.assertEqual(result["review"], GOOD)

    def test_multiple_text_blocks_of_one_step_are_joined(self):
        step = {"type": "model_output", "content": [{"type": "text", "text": "VERDICT\n\nACCEPT\n"},
                                                    {"type": "text", "text": "\nFINAL NOTE\n\nok"}]}
        result, _ = run_interactions([(200, interaction(steps=[step]))])
        self.assertTrue(result["success"])
        self.assertIn("FINAL NOTE", result["review"])


class NotAReview(unittest.TestCase):
    def assert_not_review(self, result, status=None, reason=None, error_type=None):
        self.assertFalse(result["success"], result)
        self.assertTrue(result["incomplete"])
        self.assertNotIn("review", result)
        self.assertIsNone(result["finish_reason"])
        self.assertNotEqual(result["finish_reason"], "STOP")
        if status is not None:
            self.assertEqual(result["interaction_status"], status)
        if reason is not None:
            self.assertEqual(result["incomplete_reason"], reason)
        if error_type is not None:
            self.assertEqual(result["error_type"], error_type)
        self.assertEqual((result["api_mode"], result["actual_provider"], result["fallback_used"]),
                         ("interactions", "google_gemini", False))
        self.assertEqual(result["status_code"], 200)

    def test_empty_variants(self):
        cases = {
            "empty text": ([text_step("")], "empty_model_output"),
            "whitespace": ([text_step("  \n ")], "empty_model_output"),
            "thought only": ([thought_step()], "thought_only"),
            "no model output": ([text_step("q", "user_input")], "no_model_output"),
            "no steps": ([], "no_model_output"),
            "empty content list": ([{"type": "model_output", "content": []}], "empty_model_output"),
        }
        for name, (steps, reason) in cases.items():
            result, _ = run_interactions([(200, interaction(steps=steps))])
            self.assert_not_review(result, "completed", reason, "EmptyResponse")
            self.assertNotIn("partial_review", result, name)

    def test_incomplete_max_tokens_is_distinct_from_completed(self):
        result, _ = run_interactions([(200, interaction(status="incomplete", steps=[text_step("VERDICT\n\nRE")]))])
        self.assert_not_review(result, "incomplete", "max_tokens", "IncompleteResponse")
        self.assertEqual(result["incomplete_status"], "truncated")
        self.assertEqual(result["partial_review"], "VERDICT\n\nRE")
        self.assertIn("max_output_tokens", result["hint"])

    def test_incomplete_without_text(self):
        result, _ = run_interactions([(200, interaction(status="incomplete", steps=[thought_step()]))])
        self.assert_not_review(result, "incomplete", "max_tokens", "EmptyResponse")
        self.assertIn("max_output_tokens", result["hint"])

    def test_other_statuses(self):
        for status, reason in (("requires_action", "requires_action"), ("failed", "failed"),
                               ("cancelled", "cancelled"), ("queued", "not_final"),
                               ("in_progress", "not_final"), ("budget_exceeded", "budget_exceeded"),
                               ("weird_new_status", "unknown_status")):
            result, _ = run_interactions([(200, interaction(status=status))])
            self.assert_not_review(result, status, reason, "IncompleteResponse")
            self.assertEqual(result["incomplete_status"], "incomplete", status)
            self.assertIn(status, result["error"])

    def test_missing_or_nonstring_status(self):
        for status in (None, 7, ["completed"]):
            body = interaction()
            body["status"] = status
            if status is None:
                del body["status"]
            result, _ = run_interactions([(200, body)])
            self.assert_not_review(result, None, "status_missing", "IncompleteResponse")

    def test_tool_calls_and_results_are_unexpected_content(self):
        for kind in ("function_call", "function_result", "google_search_call", "code_execution_result",
                     "mcp_server_tool_call", "totally_unknown_step"):
            steps = [text_step("draft before tool", "model_output"), {"type": kind}, text_step(GOOD)]
            result, _ = run_interactions([(200, interaction(steps=steps))])
            self.assert_not_review(result, "completed", "unexpected_content", "IncompleteResponse")
            self.assertIn(kind, result["step_types"])

    def test_tool_step_without_any_text(self):
        result, _ = run_interactions([(200, interaction(steps=[{"type": "function_call", "name": "x"}]))])
        self.assert_not_review(result, "completed", "unexpected_content")

    def test_intermediate_text_followed_by_a_tool_call_is_not_final(self):
        result, _ = run_interactions([(200, interaction(steps=[text_step("draft"), {"type": "function_call"}]))])
        self.assert_not_review(result, "completed", "unexpected_content")
        self.assertNotEqual(result.get("partial_review"), None)  # draft is only a partial, never "review"

    def test_two_model_outputs_are_ambiguous(self):
        result, _ = run_interactions([(200, interaction(steps=[text_step("first"), text_step(GOOD)]))])
        self.assert_not_review(result, "completed", "multiple_model_outputs")

    def test_thought_after_the_answer(self):
        result, _ = run_interactions([(200, interaction(steps=[text_step(GOOD), thought_step()]))])
        self.assert_not_review(result, "completed", "final_step_not_model_output")

    def test_non_text_content_in_final_step(self):
        step = {"type": "model_output", "content": [{"type": "text", "text": GOOD}, {"type": "image", "data": "x"}]}
        result, _ = run_interactions([(200, interaction(steps=[step]))])
        self.assert_not_review(result, "completed", "unexpected_content")

    def test_errors_inside_a_completed_interaction(self):
        step = {"type": "model_output", "content": [{"type": "text", "text": GOOD}], "error": {"code": 13, "message": "x"}}
        result, _ = run_interactions([(200, interaction(steps=[step]))])
        self.assert_not_review(result, "completed", "interaction_error")
        result, _ = run_interactions([(200, interaction(errors=[{"code": 1}]))])
        self.assert_not_review(result, "completed", "interaction_error")

    def test_garbage_shapes_never_raise(self):
        for steps in ("nope", [None, 5, "x", {"type": None}], [{"type": "model_output", "content": "str"}],
                      [{"type": "model_output", "content": [None, 3]}]):
            body = interaction()
            body["steps"] = steps
            result, _ = run_interactions([(200, body)])
            self.assertFalse(result["success"], steps)

    def test_not_a_json_object(self):
        for body in ("not json", "[1,2,3]", "null", ""):
            result, _ = run_interactions([(200, body)])
            self.assertFalse(result["success"])
            self.assertEqual(result["error_type"], "GeminiInteractionsError")


class HttpErrorsAndRetries(unittest.TestCase):
    def test_429_and_5xx_are_classified_by_http_and_retried_by_the_existing_policy(self):
        for status in (429, 500, 502, 503, 504):
            result, handler = run_interactions([(status, {"error": {"code": "unavailable", "message": "later"}})])
            self.assertFalse(result["success"], status)
            self.assertEqual((result["status_code"], result["retryable"]), (status, True))
            self.assertEqual(len(handler.requests), 3, status)  # 3 attempts, one POST each, no nested retries
            self.assertEqual((result["primary_attempts"], result["attempts_used"]), (3, 3))
            self.assertEqual(result["error_type"], "GeminiInteractionsError")
            self.assertEqual(result["api_mode"], "interactions")
            self.assertFalse(result["fallback_used"])
            self.assertEqual(len(result["primary_errors"]), 3)

    def test_recovers_after_a_transient_error(self):
        result, handler = run_interactions([(503, {"error": {"code": "x"}}), (200, interaction())])
        self.assertTrue(result["success"])
        self.assertEqual((len(handler.requests), result["primary_attempts"]), (2, 2))
        self.assertEqual(result["primary_errors"][0]["status_code"], 503)

    def test_client_errors_are_not_retried(self):
        for status in (400, 401, 403, 404):
            result, handler = run_interactions([(status, {"error": {"code": "invalid_request", "message": "no"}})])
            self.assertEqual(len(handler.requests), 1, status)
            self.assertEqual((result["status_code"], result["retryable"]), (status, False))
            self.assertFalse(result["success"])
            self.assertEqual(result["error_type"], "GeminiInteractionsError")

    def test_thinking_error_is_not_retried_without_thinking(self):
        body = {"error": {"code": "invalid_request", "message": "Thinking level not supported for this model"}}
        result, handler = run_interactions([(400, body)])
        self.assertEqual(len(handler.requests), 1)
        self.assertFalse(result["success"])
        self.assertIn("Thinking", result["error"])

    def test_redirects_are_not_followed(self):
        responses = [httpx.Response(302, headers={"location": "https://evil.example/steal"})]
        result, handler = run_interactions(responses)
        self.assertEqual(len(handler.requests), 1)
        self.assertFalse(result["success"])
        self.assertEqual(result["status_code"], 302)
        self.assertNotIn("evil.example", json.dumps(result, default=str))

    def test_oversized_body_is_refused(self):
        with mock.patch.object(server, "GEMINI_INTERACTIONS_MAX_BODY_BYTES", 100):
            result, _ = run_interactions([(200, interaction(steps=[text_step("x" * 5000)]))])
        self.assertFalse(result["success"])
        self.assertIn("лимит", result["error"])

    def test_allow_fallback_false_never_calls_openai(self):
        calls = []

        async def fake_openai(**kw):
            calls.append(kw)
            return {}

        handler = Recorder([(503, {"error": {"code": "x"}})])
        with interactions_env(handler), mock.patch.object(server, "run_openai_review_fallback", fake_openai):
            result = review(allow_fallback=False)
        self.assertEqual(calls, [])
        self.assertEqual((result["fallback_used"], result["fallback_allowed"], result["actual_provider"]),
                         (False, False, "google_gemini"))

    def test_openai_fallback_keeps_honest_provider_and_api_labels(self):
        async def fake_openai(**kw):
            response = NS(output_text=GOOD, status="completed", incomplete_details=None, id="r")
            return {"response": response, "model": "fake-openai", "review": GOOD, "usage": {},
                    "response_id": "r", "finish_reason": "completed"}

        handler = Recorder([(503, {"error": {"code": "x"}})])
        with interactions_env(handler), mock.patch.object(server, "run_openai_review_fallback", fake_openai):
            result = review(allow_fallback=True)
        self.assertTrue(result["success"])
        self.assertEqual((result["actual_provider"], result["requested_provider"], result["fallback_used"]),
                         ("openai", "google_gemini", True))
        self.assertEqual((result["api_mode"], result["primary_api_mode"]), ("openai_responses", "interactions"))

    def test_fault_injection_makes_no_http_request(self):
        handler = Recorder([(200, interaction())])
        with interactions_env(handler, LEGALMCP_ENABLE_FAULT_INJECTION="1"):
            result = review(dev_force_gemini_503=True)
        self.assertEqual(handler.requests, [])
        self.assertEqual(result["status_code"], 503)
        self.assertFalse(result["success"])


class TransportAndCancellation(unittest.TestCase):
    def tracked_client(self):
        events = {"opened": 0, "closed": 0}
        real = httpx.AsyncClient

        class Tracked(real):
            async def __aenter__(self):
                events["opened"] += 1
                return await super().__aenter__()

            async def __aexit__(self, *args):
                events["closed"] += 1
                return await super().__aexit__(*args)

        return events, Tracked

    def test_client_is_closed_after_success_and_error(self):
        events, tracked = self.tracked_client()
        for responses in ([(200, interaction())], [(400, {"error": {"code": "invalid_request"}})]):
            handler = Recorder(responses)
            with interactions_env(handler), mock.patch.object(server.httpx, "AsyncClient", tracked):
                review()
        self.assertEqual(events["opened"], events["closed"])
        self.assertGreaterEqual(events["opened"], 2)

    def test_default_client_options(self):
        captured = {}
        real = httpx.AsyncClient

        class Spy(real):
            def __init__(self, *args, **kwargs):
                captured.update(kwargs)
                super().__init__(*args, **kwargs)

        handler = Recorder([(200, interaction())])
        with interactions_env(handler), mock.patch.object(server.httpx, "AsyncClient", Spy):
            review()
        self.assertIs(captured["follow_redirects"], False)
        self.assertNotIn("verify", captured)  # default TLS verification, never disabled
        self.assertEqual(captured["timeout"].read, 60.0)

    def test_hanging_request_is_cancelled_and_closed(self):
        events, tracked = self.tracked_client()
        state = {"cancelled": False}

        async def hang(request):
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                state["cancelled"] = True
                raise

        async def go():
            with env(), mock.patch.object(server, "GEMINI_INTERACTIONS_TRANSPORT", httpx.MockTransport(hang)), \
                    mock.patch.object(server.httpx, "AsyncClient", tracked):
                call = server.make_gemini_interactions_call({"model": "m"}, "k")
                with self.assertRaises(asyncio.TimeoutError):
                    await asyncio.wait_for(call(), timeout=0.05)

        asyncio.run(go())
        self.assertTrue(state["cancelled"])
        self.assertEqual(events["opened"], events["closed"])

    def test_caller_cancellation_propagates_and_closes(self):
        events, tracked = self.tracked_client()
        started = asyncio.Event()

        async def hang(request):
            started.set()
            await asyncio.Event().wait()

        async def go():
            with env(), mock.patch.object(server, "GEMINI_INTERACTIONS_TRANSPORT", httpx.MockTransport(hang)), \
                    mock.patch.object(server.httpx, "AsyncClient", tracked):
                task = asyncio.create_task(server.call_with_gemini_retry(
                    server.make_gemini_interactions_call({"model": "m"}, "k")))
                await started.wait()
                task.cancel()
                with self.assertRaises(asyncio.CancelledError):
                    await task

        asyncio.run(go())
        self.assertEqual(events["opened"], events["closed"])

    def test_attempt_timeout_and_total_deadline_are_the_existing_ones(self):
        async def hang(request):
            await asyncio.Event().wait()

        async def go():
            with env(), mock.patch.object(server, "GEMINI_INTERACTIONS_TRANSPORT", httpx.MockTransport(hang)):
                call = server.make_gemini_interactions_call({"model": "m"}, "k")
                started = server.time.monotonic()
                with self.assertRaises(server.GeminiCallError) as ctx:
                    await server.call_with_gemini_retry(call, deadline=started + 0.05)
                self.assertLess(server.time.monotonic() - started, 1.0)
                self.assertIsInstance(ctx.exception.original, (TimeoutError, asyncio.TimeoutError))

        asyncio.run(go())

    def test_transport_errors_become_safe_errors(self):
        def refuse(request):
            raise httpx.ConnectError(f"cannot connect with {FAKE_KEY}")

        with interactions_env(refuse, GEMINI_API_KEY=FAKE_KEY):
            result = review()
        self.assertFalse(result["success"])
        self.assertNotIn(FAKE_KEY, json.dumps(result, default=str))
        self.assertEqual(result["error_type"], "GeminiInteractionsError")


class LegacyModeUnchanged(unittest.TestCase):
    def legacy_review(self, response, **kwargs):
        calls = []

        async def generate_content(**kw):
            calls.append(kw)
            return response

        client = NS(aio=NS(models=NS(generate_content=generate_content)))

        def no_http(request):
            raise AssertionError("legacy mode must not use the Interactions endpoint")

        with env(), mock.patch.object(server.GEMINI_ADAPTER, "get_client", lambda: client), \
                mock.patch.object(server, "GEMINI_INTERACTIONS_TRANSPORT", httpx.MockTransport(no_http)):
            result = asyncio.run(server.gemini_review(task="t", proposal="p", allow_fallback=False, **kwargs))
        return result, calls

    def sdk_response(self, text, finish):
        return NS(text=text, candidates=[NS(finish_reason=NS(value=finish))],
                  usage_metadata=NS(prompt_token_count=5, candidates_token_count=7, total_token_count=12,
                                    thoughts_token_count=0))

    def test_default_is_generate_content_with_labels(self):
        result, calls = self.legacy_review(self.sdk_response(GOOD, "STOP"))
        self.assertTrue(result["success"])
        self.assertEqual((result["api_mode"], result["primary_api_mode"], result["transport"]),
                         ("generate_content", "generate_content", "google_genai_sdk_async"))
        self.assertEqual(result["finish_reason"], "STOP")
        self.assertNotIn("interaction_status", result)
        self.assertEqual(len(calls), 1)
        self.assertEqual(calls[0]["config"].max_output_tokens, 4000)

    def test_legacy_truncation_still_not_a_review(self):
        result, _ = self.legacy_review(self.sdk_response("VERDICT\n\nRE", "MAX_TOKENS"))
        self.assertFalse(result["success"])
        self.assertTrue(result["incomplete"])
        self.assertEqual(result["finish_reason"], "MAX_TOKENS")
        self.assertEqual(result["api_mode"], "generate_content")
        self.assertNotIn("interaction_status", result)

    def test_legacy_thinking_fallback_is_only_for_legacy(self):
        class ThinkingError(Exception):
            status_code = 400

        calls = []

        async def generate_content(**kw):
            calls.append(kw)
            if len(calls) == 1:
                raise ThinkingError("thinking level not supported")
            return self.sdk_response(GOOD, "STOP")

        client = NS(aio=NS(models=NS(generate_content=generate_content)))
        with env(), mock.patch.object(server.GEMINI_ADAPTER, "get_client", lambda: client):
            result = asyncio.run(server.gemini_review(task="t", proposal="p", allow_fallback=False))
        self.assertTrue(result["success"])
        self.assertEqual(len(calls), 2)


class AssessUnit(unittest.TestCase):
    def assess(self, body, requested="gemini-3.8-flash"):
        return server.assess_gemini_completion(
            server.GeminiInteractionResult(body, requested_model=requested))

    def test_complete(self):
        a = self.assess(interaction())
        self.assertEqual((a["status"], a["finish_class"], a["finish_reason"], a["interaction_status"]),
                         ("complete", "complete", None, "completed"))
        self.assertEqual(a["verdict"], "REVISE")

    def test_usage_mapping_ignores_bad_values(self):
        usage = server.normalize_interaction_usage({"total_input_tokens": 1, "total_output_tokens": "x",
                                                    "total_thought_tokens": True, "total_tokens": 9,
                                                    "total_cached_tokens": 2, "total_tool_use_tokens": 3})
        self.assertEqual(usage, {"input_tokens": 1, "total_tokens": 9, "cached_tokens": 2, "tool_use_tokens": 3})
        self.assertEqual(server.normalize_interaction_usage(None), {})

    def test_status_is_case_insensitive_but_preserved(self):
        a = self.assess(interaction(status="Completed"))
        self.assertEqual((a["status"], a["interaction_status"]), ("complete", "Completed"))

    def test_request_builder_has_no_tools_or_streaming(self):
        request = server.build_gemini_interactions_request(
            model="m", system_instruction="s", input_text="i",
            budget={"max_output_tokens": 2048, "thinking_level": "minimal"})
        self.assertEqual(request["generation_config"], {"max_output_tokens": 2048, "thinking_level": "low"})
        self.assertEqual((request["store"], request["background"], request["stream"]), (False, False, False))
        self.assertNotIn("tools", request)


class AiCompareInteractions(unittest.TestCase):
    def compare(self, responses):
        async def ok_openai(**_):
            return {"success": True, "review": GOOD, "provider": "openai"}

        handler = Recorder(responses)
        with interactions_env(handler), mock.patch.object(server, "ai_review", ok_openai):
            result = asyncio.run(server.ai_compare(task="TASK-MARKER", proposal="PROPOSAL-MARKER"))
        return result, handler

    def test_complete_gemini_leg_counts_as_independent(self):
        result, handler = self.compare([(200, interaction())])
        gemini = result["gemini"]
        self.assertTrue(gemini["success"])
        self.assertTrue(gemini["independent"])
        self.assertEqual((gemini["api_mode"], gemini["transport"], gemini["interaction_status"]),
                         ("interactions", "httpx_async_post", "completed"))
        self.assertEqual((result["status"], result["independent_review_count"]), ("complete", 2))
        body = handler.body()
        self.assertIn("PROPOSAL-MARKER", body["input"])
        self.assertIn("Gemini reviewer внутри ai_compare", body["system_instruction"])
        self.assertIs(body["store"], False)
        self.assertNotIn("tools", body)

    def test_not_a_review_is_not_independent(self):
        cases = (interaction(status="incomplete", steps=[text_step("VERDICT\n\nRE")]),
                 interaction(status="requires_action"), interaction(steps=[thought_step()]),
                 interaction(steps=[text_step("draft"), {"type": "function_call"}]))
        for body in cases:
            result, _ = self.compare([(200, body)])
            gemini = result["gemini"]
            self.assertFalse(gemini["success"])
            self.assertTrue(gemini["incomplete"])
            self.assertFalse(gemini["independent"])
            self.assertEqual((result["status"], result["independent_review_count"]), ("partial", 1))
            self.assertEqual(gemini["api_mode"], "interactions")

    def test_http_error_leg_has_two_attempts_at_most(self):
        result, handler = self.compare([(503, {"error": {"code": "x"}})])
        self.assertFalse(result["gemini"]["success"])
        self.assertLessEqual(len(handler.requests), 2)
        self.assertFalse(result["gemini"]["fallback_used"])

    def test_default_mode_compare_is_legacy(self):
        async def ok_openai(**_):
            return {"success": True, "review": GOOD, "provider": "openai"}

        resp = NS(text=GOOD, candidates=[NS(finish_reason=NS(value="STOP"))],
                  usage_metadata=NS(prompt_token_count=1, candidates_token_count=1, total_token_count=2,
                                    thoughts_token_count=0))
        client = NS(aio=NS(models=NS(generate_content=mock.AsyncMock(return_value=resp))))
        with env(), mock.patch.object(server, "ai_review", ok_openai), mock.patch.object(server, "get_gemini_client", lambda: client):
            result = asyncio.run(server.ai_compare(task="t", proposal="p"))
        self.assertEqual(result["gemini"]["api_mode"], "generate_content")
        self.assertEqual(result["independent_review_count"], 2)


class SignaturesUnchanged(unittest.TestCase):
    def test_tool_signatures(self):
        import inspect
        base = ["task", "proposal", "context", "mode", "goal", "constraints", "depth", "max_output_tokens"]
        self.assertEqual(list(inspect.signature(server.gemini_review).parameters),
                         base + ["dev_force_gemini_503", "allow_fallback"])
        self.assertEqual(list(inspect.signature(server.ai_compare).parameters), base + ["deadline_seconds"])




DAILY_MESSAGE = ("Rate limit exceeded for model gemini-3.8-flash (limit: 20 requests per day on Free Tier). "
                 "Please retry in 3h58m20s or upgrade your tier at https://example.test/upgrade")


def error_body(message, code="too_many_requests"):
    return {"error": {"code": code, "message": message}}


def recording_sleep(delays):
    async def sleeper(seconds):
        delays.append(seconds)
    return sleeper


class ErrorCodeSanitization(unittest.TestCase):
    """Defect 1: error.code is provider text and must be scrubbed like the message."""

    def test_short_key_in_code_does_not_leak(self):
        short = "k-short-123"
        for status in (400, 401, 429, 500, 503):
            handler = Recorder([(status, error_body("plain message", code=f"bad_{short}_code"))])
            with interactions_env(handler, GEMINI_API_KEY=short):
                result = review()
            dumped = json.dumps(result, ensure_ascii=False, default=str)
            self.assertNotIn(short, dumped, status)
            self.assertFalse(result["success"])

    def test_exception_attribute_and_text_are_scrubbed(self):
        short = "k-short-123"
        handler = Recorder([(400, error_body("m", code=short))])

        async def go():
            with env(), mock.patch.object(server, "GEMINI_INTERACTIONS_TRANSPORT", httpx.MockTransport(handler)):
                with self.assertRaises(server.GeminiInteractionsError) as ctx:
                    await server.post_gemini_interaction({"model": "m"}, short)
            return ctx.exception

        exc = asyncio.run(go())
        self.assertNotIn(short, str(exc))
        self.assertNotIn(short, str(exc.api_error_code))

    def test_odd_code_shapes_are_stringified_and_bounded(self):
        for code in (429, 1.5, True, None, ["x"] * 50, {"a": "b" * 500}, "z" * 500):
            handler = Recorder([(400, {"error": {"code": code, "message": "m"}})])
            with interactions_env(handler):
                result = review()
            self.assertFalse(result["success"])
            self.assertLess(len(result["error"]), 400)

    def test_server_strings_in_status_step_types_and_model_are_scrubbed(self):
        short = "k-short-123"
        body = interaction(status="completed", steps=[{"type": short, "content": []}, text_step(GOOD)])
        body["model"] = f"gemini-{short}"
        handler = Recorder([(200, body)])
        with interactions_env(handler, GEMINI_API_KEY=short):
            result = review()
        self.assertNotIn(short, json.dumps(result, ensure_ascii=False, default=str))
        body = interaction(status=f"weird-{short}")
        handler = Recorder([(200, body)])
        with interactions_env(handler, GEMINI_API_KEY=short):
            result = review()
        self.assertNotIn(short, json.dumps(result, ensure_ascii=False, default=str))


class MalformedContent(unittest.TestCase):
    """Defect 2: content of any shape must never raise and never pass."""

    BAD_CONTENT = (1, 0, True, False, 3.5, "text", {"type": "text", "text": "x"}, [None], [1, 2], [[]],
                   [{"type": "text"}], [{"type": "text", "text": 5}], [{"type": "image"}], [GOOD])

    def step(self, content):
        return {"type": "model_output", "content": content}

    def test_not_a_list_is_malformed_content(self):
        for content in (1, 0, True, False, 3.5, "text", {"type": "text", "text": GOOD}):
            result, _ = run_interactions([(200, interaction(steps=[self.step(content)]))])
            self.assertFalse(result["success"], content)
            self.assertTrue(result["incomplete"])
            self.assertEqual(result["incomplete_reason"], "malformed_content", content)
            self.assertNotIn("review", result)
            self.assertEqual(result["status_code"], 200)

    def test_bad_blocks_inside_a_list_are_unexpected_content(self):
        for content in ([None], [1, 2], [[]], [{"type": "text"}], [{"type": "text", "text": 5}],
                        [{"type": "image"}], [{"type": "text", "text": GOOD}, None]):
            result, _ = run_interactions([(200, interaction(steps=[self.step(content)]))])
            self.assertFalse(result["success"], content)
            self.assertEqual(result["incomplete_reason"], "unexpected_content", content)

    def test_none_or_missing_content_is_empty(self):
        for step in ({"type": "model_output"}, {"type": "model_output", "content": None}):
            result, _ = run_interactions([(200, interaction(steps=[step]))])
            self.assertEqual((result["success"], result["error_type"]), (False, "EmptyResponse"))

    def test_every_status_with_malformed_content_does_not_raise(self):
        for status in ("completed", "incomplete", "failed", "requires_action", "queued", "x"):
            for content in self.BAD_CONTENT:
                result, _ = run_interactions([(200, interaction(status=status, steps=[self.step(content)]))])
                self.assertFalse(result["success"], (status, content))

    def test_no_exception_reaches_the_caller_in_ai_compare(self):
        async def ok_openai(**_):
            return {"success": True, "review": GOOD, "provider": "openai"}

        for content in (1, True, "x", [None]):
            handler = Recorder([(200, interaction(steps=[self.step(content)]))])
            with interactions_env(handler), mock.patch.object(server, "ai_review", ok_openai):
                result = asyncio.run(server.ai_compare(task="t", proposal="p"))
            self.assertFalse(result["gemini"]["success"], content)
            self.assertFalse(result["gemini"]["independent"])
            self.assertEqual(result["independent_review_count"], 1)

    def test_other_malformed_fields_are_honest_failures(self):
        for name, patch in {"steps not a list": {"steps": "nope"}, "steps is a number": {"steps": 5},
                            "errors odd": {"errors": 7}, "model not a string": {"model": 5}}.items():
            body = interaction()
            body.update(patch)
            result, _ = run_interactions([(200, body)])
            self.assertFalse(result["success"], name)
        body = interaction()
        body["usage"] = [1, 2]  # usage is optional metadata, not a review criterion
        result, _ = run_interactions([(200, body)])
        self.assertTrue(result["success"])
        self.assertEqual(result["usage"], {})
        body = interaction()
        body["steps"] = "nope"
        result, _ = run_interactions([(200, body)])
        self.assertEqual(result["incomplete_reason"], "malformed_steps")

    def test_assessment_wrapper_never_raises(self):
        result = server.GeminiInteractionResult(interaction(), requested_model="gemini-3.8-flash")
        with mock.patch.object(server, "_interaction_step_text", side_effect=RuntimeError("boom")):
            assessment = server.assess_gemini_interaction(result)
        self.assertEqual((assessment["status"], assessment["incomplete_reason"]), ("incomplete", "malformed_response"))
        for data in (None, [], "x", 5):
            assessment = server.assess_gemini_interaction(server.GeminiInteractionResult(data))
            self.assertNotEqual(assessment["status"], "complete")


class ReturnedModel(unittest.TestCase):
    """Defect 3: actual_model is what the API returned, never the requested one."""

    def body_with_model(self, model, **kwargs):
        body = interaction(**kwargs)
        if model is None:
            body.pop("model", None)
        else:
            body["model"] = model
        return body

    def test_confirmed_model(self):
        result, _ = run_interactions([(200, self.body_with_model("gemini-3.8-flash"))])
        self.assertTrue(result["success"])
        self.assertEqual((result["model"], result["requested_model"], result["actual_model"]),
                         ("gemini-3.8-flash",) * 3)
        self.assertEqual(result["model_check"], "confirmed")
        self.assertNotIn("returned_model", result)

    def test_models_prefix_and_case_are_normalised_but_raw_value_is_kept(self):
        for returned in ("models/gemini-3.8-flash", "Gemini-3.8-Flash"):
            result, _ = run_interactions([(200, self.body_with_model(returned))])
            self.assertTrue(result["success"], returned)
            self.assertEqual(result["actual_model"], returned)
            self.assertEqual(result["model_check"], "confirmed")

    def test_different_model_is_not_a_confirmed_review(self):
        result, _ = run_interactions([(200, self.body_with_model("gemini-3.5-pro"))])
        self.assertFalse(result["success"])
        self.assertFalse(result["incomplete"])
        self.assertEqual(result["error_type"], "ModelMismatch")
        self.assertEqual(result["model_check"], "mismatch")
        self.assertEqual(result["actual_model"], "gemini-3.5-pro")
        self.assertEqual((result["model"], result["requested_model"]), ("gemini-3.8-flash",) * 2)
        self.assertEqual(result["unconfirmed_review"], GOOD)
        self.assertNotIn("review", result)
        self.assertNotIn("partial_review", result)
        self.assertEqual((result["actual_provider"], result["interaction_status"]), ("google_gemini", "completed"))

    def test_missing_or_unusable_model(self):
        for model in (None, 5, "", "   ", ["gemini"], {"x": 1}):
            result, _ = run_interactions([(200, self.body_with_model(model))])
            self.assertFalse(result["success"], model)
            self.assertEqual(result["error_type"], "ModelMissing", model)
            self.assertIsNone(result["actual_model"], model)
            self.assertNotEqual(result["actual_model"], result["requested_model"])
            self.assertEqual(result["model_check"], "missing")

    def test_model_never_rescues_an_incomplete_response(self):
        result, _ = run_interactions([(200, self.body_with_model("other-model", status="incomplete",
                                                                  steps=[text_step("VERDICT\n\nRE")]))])
        self.assertFalse(result["success"])
        self.assertTrue(result["incomplete"])
        self.assertEqual(result["incomplete_reason"], "max_tokens")
        self.assertEqual((result["actual_model"], result["model_check"]), ("other-model", "mismatch"))

    def test_http_error_has_no_actual_model(self):
        for status in (400, 429, 503):
            result, _ = run_interactions([(status, error_body("x"))])
            self.assertIsNone(result["actual_model"], status)
            self.assertEqual(result["model_check"], "no_response")
            self.assertEqual(result["requested_model"], "gemini-3.8-flash")

    def test_deep_depth_uses_the_deep_model_as_requested(self):
        with mock.patch.object(server, "DEEP_GEMINI_MODEL", "gemini-deep-x"):
            body = self.body_with_model("gemini-deep-x")
            result, handler = run_interactions([(200, body)], depth="deep")
        self.assertEqual(handler.body()["model"], "gemini-deep-x")
        self.assertEqual((result["requested_model"], result["actual_model"], result["model_check"]),
                         ("gemini-deep-x", "gemini-deep-x", "confirmed"))

    def test_ai_compare_leg_reports_the_returned_model_and_is_not_independent_on_mismatch(self):
        async def ok_openai(**_):
            return {"success": True, "review": GOOD, "provider": "openai"}

        for model, expect_independent in (("gemini-3.8-flash", True), ("gemini-3.5-pro", False), (None, False)):
            handler = Recorder([(200, self.body_with_model(model))])
            with interactions_env(handler), mock.patch.object(server, "ai_review", ok_openai):
                result = asyncio.run(server.ai_compare(task="t", proposal="p"))
            leg = result["gemini"]
            self.assertEqual(leg["independent"], expect_independent, model)
            self.assertEqual(result["independent_review_count"], 2 if expect_independent else 1)
            self.assertEqual(leg["actual_model"], model if isinstance(model, str) else None)
            self.assertNotEqual(leg["model_check"], "no_response")

    def test_legacy_mode_is_unchanged(self):
        resp = NS(text=GOOD, candidates=[NS(finish_reason=NS(value="STOP"))],
                  usage_metadata=NS(prompt_token_count=1, candidates_token_count=1, total_token_count=2,
                                    thoughts_token_count=0))
        client = NS(aio=NS(models=NS(generate_content=mock.AsyncMock(return_value=resp))))
        with env(), mock.patch.object(server.GEMINI_ADAPTER, "get_client", lambda: client):
            result = asyncio.run(server.gemini_review(task="t", proposal="p", allow_fallback=False))
        self.assertEqual(result["actual_model"], result["requested_model"])
        self.assertNotIn("model_check", result)


class DailyQuota(unittest.TestCase):
    def post_count_for(self, response, **kwargs):
        result, handler = run_interactions([response], **kwargs)
        return result, len(handler.requests)

    def test_confirmed_daily_quota_is_one_post(self):
        result, posts = self.post_count_for((429, error_body(DAILY_MESSAGE)))
        self.assertEqual(posts, 1)
        self.assertFalse(result["success"])
        self.assertIs(result["quota_exhausted"], True)
        self.assertEqual(result["quota_scope"], "daily")
        self.assertIs(result["retryable"], False)
        self.assertEqual(result["status_code"], 429)
        self.assertEqual((result["primary_attempts"], result["attempts_used"]), (1, 1))
        self.assertAlmostEqual(result["retry_after_seconds"], 3 * 3600 + 58 * 60 + 20)
        self.assertIn("quota_exhausted", result["hint"])
        self.assertEqual((result["actual_provider"], result["fallback_used"], result["api_mode"]),
                         ("google_gemini", False, "interactions"))
        self.assertNotIn("https://", json.dumps(result, default=str))

    def test_various_daily_wordings(self):
        for message in ("Quota exceeded: 20 requests/day for this model", "daily quota exhausted",
                        "GenerateRequestsPerDayPerProjectPerModel-FreeTier exceeded", "limit 20 per day",
                        "You have used your daily limit"):
            result, posts = self.post_count_for((429, error_body(message)))
            self.assertEqual(posts, 1, message)
            self.assertIs(result["quota_exhausted"], True, message)

    def test_free_tier_with_a_long_retry_after_header(self):
        response = httpx.Response(429, json=error_body("Rate limit for Free Tier reached"),
                                  headers={"retry-after": "7200"})
        result, posts = self.post_count_for(response)
        self.assertEqual(posts, 1)
        self.assertIs(result["quota_exhausted"], True)
        self.assertEqual(result["retry_after_seconds"], 7200.0)

    def test_free_tier_alone_is_not_a_daily_limit(self):
        response = httpx.Response(429, json=error_body("Rate limit for Free Tier, slow down"),
                                  headers={"retry-after": "2"})
        result, posts = self.post_count_for(response)
        self.assertEqual(posts, 3)
        self.assertNotIn("quota_exhausted", result)
        self.assertTrue(result["retryable"])

    def test_ordinary_short_429_keeps_the_bounded_retry(self):
        delays = []
        handler = Recorder([(429, error_body("Too many requests, slow down"))])
        with interactions_env(handler), mock.patch.object(server.asyncio, "sleep", recording_sleep(delays)):
            result = review()
        self.assertEqual(len(handler.requests), 3)
        self.assertEqual((result["primary_attempts"], result["retryable"]), (3, True))
        self.assertNotIn("quota_exhausted", result)
        self.assertEqual(delays, [1.0, 2.0])

    def test_short_retry_after_is_honoured_within_the_deadline(self):
        delays = []
        response = httpx.Response(429, json=error_body("slow down"), headers={"retry-after": "5"})
        handler = Recorder([response])
        with interactions_env(handler), mock.patch.object(server.asyncio, "sleep", recording_sleep(delays)):
            result = review()
        self.assertEqual(len(handler.requests), 3)
        self.assertEqual(delays, [5.0, 5.0])
        self.assertEqual(result["retry_after_seconds"], 5.0)

    def test_retry_after_beyond_the_deadline_starts_no_retry(self):
        for response in (httpx.Response(429, json=error_body("slow down"), headers={"retry-after": "500"}),
                         (429, error_body("slow down. Please retry in 45m")),
                         (429, error_body("slow down. Please retry in 121s"))):
            result, posts = self.post_count_for(response)
            self.assertEqual(posts, 1, response)
            self.assertNotIn("quota_exhausted", result)
            self.assertEqual(result["primary_attempts"], 1)
            self.assertGreaterEqual(result["retry_after_seconds"], 121)

    def test_http_date_retry_after(self):
        from email.utils import format_datetime
        from datetime import datetime, timedelta, timezone
        later = format_datetime(datetime.now(timezone.utc) + timedelta(hours=2), usegmt=True)
        response = httpx.Response(429, json=error_body("slow down"), headers={"retry-after": later})
        result, posts = self.post_count_for(response)
        self.assertEqual(posts, 1)
        self.assertGreater(result["retry_after_seconds"], 3600)
        self.assertIsNone(server.parse_retry_after_header("garbage"))

    def test_5xx_is_unaffected_by_quota_logic(self):
        response = httpx.Response(503, json=error_body("high demand per day"), headers={"retry-after": "9999"})
        result, posts = self.post_count_for(response)
        self.assertEqual(posts, 3)
        self.assertNotIn("quota_exhausted", result)

    def test_retry_after_text_parser(self):
        cases = {"retry in 3h58m20s": 14300.0, "Please retry in 45.5s.": 45.5, "retry after 2m": 120.0,
                 "retry in 1h": 3600.0, "no hint": None}
        for text, expected in cases.items():
            self.assertEqual(server.parse_retry_after_text(text), expected, text)

    def test_daily_quota_with_allow_fallback_still_reaches_openai_once(self):
        calls = []

        async def fake_openai(**kw):
            calls.append(kw)
            response = NS(output_text=GOOD, status="completed", incomplete_details=None, id="r")
            return {"response": response, "model": "fake-openai", "review": GOOD, "usage": {},
                    "response_id": "r", "finish_reason": "completed"}

        handler = Recorder([(429, error_body(DAILY_MESSAGE))])
        with interactions_env(handler), mock.patch.object(server, "run_openai_review_fallback", fake_openai):
            result = review(allow_fallback=True)
        self.assertEqual((len(handler.requests), len(calls)), (1, 1))
        self.assertEqual((result["actual_provider"], result["fallback_used"], result["primary_api_mode"]),
                         ("openai", True, "interactions"))

    def test_daily_quota_without_fallback_never_calls_openai(self):
        calls = []

        async def fake_openai(**kw):
            calls.append(kw)
            return {}

        handler = Recorder([(429, error_body(DAILY_MESSAGE))])
        with interactions_env(handler), mock.patch.object(server, "run_openai_review_fallback", fake_openai):
            result = review(allow_fallback=False)
        self.assertEqual(calls, [])
        self.assertEqual((result["fallback_allowed"], result["fallback_used"], result["quota_exhausted"]),
                         (False, False, True))

    def test_ai_compare_leg_stops_after_one_post(self):
        async def ok_openai(**_):
            return {"success": True, "review": GOOD, "provider": "openai"}

        handler = Recorder([(429, error_body(DAILY_MESSAGE))])
        with interactions_env(handler), mock.patch.object(server, "ai_review", ok_openai):
            result = asyncio.run(server.ai_compare(task="t", proposal="p"))
        self.assertEqual(len(handler.requests), 1)
        leg = result["gemini"]
        self.assertIs(leg["quota_exhausted"], True)
        self.assertIs(leg["retryable"], False)
        self.assertFalse(leg["independent"])
        self.assertEqual(result["independent_review_count"], 1)

    def test_legacy_sdk_429_gets_the_same_classification(self):
        class Quota(Exception):
            status_code = 429

        daily = server.classify_gemini_error(Quota("429 RESOURCE_EXHAUSTED: limit 20 requests per day, retry in 1h"))
        self.assertEqual((daily["retryable"], daily["quota_exhausted"], daily["retry_after_seconds"]), (False, True, 3600.0))
        plain = server.classify_gemini_error(Quota("429 RESOURCE_EXHAUSTED: slow down"))
        self.assertEqual((plain["retryable"], plain["quota_exhausted"]), (True, False))
        bare = server.classify_gemini_error(Quota(""))
        self.assertEqual((bare["retryable"], bare["quota_exhausted"]), (True, False))

    def test_other_providers_are_unchanged(self):
        class Quota(Exception):
            status_code = 429

        for classify in (server.classify_openai_error, server.classify_deepseek_error):
            info = classify(Quota("429 limit: 20 requests per day, retry in 3h"))
            self.assertTrue(info["retryable"])
            self.assertNotIn("quota_exhausted", info)
            self.assertNotIn("retry_after_seconds", info)

        async def go(adapter):
            calls = 0

            async def op():
                nonlocal calls
                calls += 1
                raise Quota("429 limit: 20 requests per day, retry in 3h")

            with self.assertRaises(Quota):
                await server.call_with_provider_retry(
                    adapter=adapter, operation=op, retry_policy=server.ProviderRetryPolicy(3, 0, 0))
            return calls

        self.assertEqual(asyncio.run(go(server.OPENAI_ADAPTER)), 3)
        self.assertEqual(asyncio.run(go(server.DEEPSEEK_ADAPTER)), 3)


class RetryAfterDeadlineCompatibility(unittest.TestCase):
    class Limited(Exception):
        status_code = 429

        def __init__(self, retry_after):
            super().__init__("slow down")
            self.retry_after_seconds = retry_after

    def test_retry_after_longer_than_remaining_deadline_stops(self):
        calls = 0

        async def op():
            nonlocal calls
            calls += 1
            raise self.Limited(30)

        async def go():
            deadline = server.time.monotonic() + 10
            with self.assertRaises(server.GeminiCallError):
                await server.call_with_gemini_retry(op, deadline=deadline)

        asyncio.run(go())
        self.assertEqual(calls, 1)

    def test_retry_after_within_deadline_waits_then_retries(self):
        calls, delays = 0, []

        async def op():
            nonlocal calls
            calls += 1
            if calls == 1:
                raise self.Limited(30)
            return "ok"

        async def go():
            with mock.patch.object(server.asyncio, "sleep", recording_sleep(delays)):
                return await server.call_with_gemini_retry(op, deadline=server.time.monotonic() + 100)

        result, attempts = asyncio.run(go())
        self.assertEqual((result, attempts, calls, delays), ("ok", 2, 2, [30.0]))

    def test_cancellation_during_the_retry_after_wait_propagates(self):
        calls = 0
        first = asyncio.Event()

        async def op():
            nonlocal calls
            calls += 1
            first.set()
            raise self.Limited(30)

        async def go():
            task = asyncio.create_task(server.call_with_gemini_retry(op, deadline=server.time.monotonic() + 100))
            await first.wait()
            await asyncio.sleep(0.05)  # now inside the 30 s wait
            task.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await task

        asyncio.run(go())
        self.assertEqual(calls, 1)

    def test_total_deadline_still_wins_over_the_attempt_timeout(self):
        async def hang():
            await asyncio.Event().wait()

        async def go():
            started = server.time.monotonic()
            with self.assertRaises(server.GeminiCallError):
                await server.call_with_gemini_retry(hang, deadline=started + 0.05)
            self.assertLess(server.time.monotonic() - started, 1.0)

        asyncio.run(go())


class SelfTestOfflineInAnyMode(unittest.TestCase):
    """provider_layer_self_test(live=False) never reaches the network,
    whatever GEMINI_API_MODE / proxy-auth is active."""

    def run_selftest(self, **env_values):
        import socket

        hits = []

        def deny(*_a, **_k):
            hits.append("net")
            raise OSError("network is blocked in this test")

        def handler(request):
            hits.append("http")
            raise AssertionError("HTTP request during offline self-test")

        async def no_send(self_, *_a, **_k):
            hits.append("httpx")
            raise AssertionError("httpx send during offline self-test")

        # Windows creates a local socketpair while initializing its event loop.
        # Initialize before the network guards; keep them active for the whole test.
        with asyncio.Runner() as runner:
            runner.get_loop()
            with env(**env_values), \
                    mock.patch.object(server, "GEMINI_INTERACTIONS_TRANSPORT", httpx.MockTransport(handler)), \
                    mock.patch.object(socket.socket, "connect", deny), \
                    mock.patch.object(socket, "create_connection", deny), \
                    mock.patch.object(socket, "getaddrinfo", deny), \
                    mock.patch.object(httpx.AsyncClient, "send", no_send):
                report = runner.run(server.provider_layer_self_test(live=False))
        return report, hits

    def assert_clean(self, report, hits, label):
        failed = [c["name"] for c in report["checks"] if c["status"] != "passed"]
        self.assertEqual(hits, [], label)
        self.assertEqual(failed, [], label)
        self.assertEqual(report["summary"], {"total": 49, "passed": 49, "failed": 0}, label)

    def test_every_mode_is_49_of_49_without_any_request(self):
        cases = {
            "default": {},
            "generate_content": {"GEMINI_API_MODE": "generate_content"},
            "interactions+proxy": {
                "GEMINI_API_MODE": "interactions", "LEGALMCP_PROXY_AUTH": "1", "CLAUDE_CODE_REMOTE": "true",
            },
            "interactions, no key": {"GEMINI_API_MODE": "interactions"},
            "interactions+real-looking key": {"GEMINI_API_MODE": "interactions", "GEMINI_API_KEY": FAKE_KEY},
            "invalid mode value": {"GEMINI_API_MODE": "bogus"},
        }
        for label, values in cases.items():
            with self.subTest(label):
                report, hits = self.run_selftest(**values)
                self.assert_clean(report, hits, label)

    def test_report_has_no_key_or_env_values(self):
        report, _ = self.run_selftest(GEMINI_API_MODE="interactions", GEMINI_API_KEY=FAKE_KEY)
        text = json.dumps(report)
        self.assertNotIn(FAKE_KEY, text)
        self.assertNotIn("synthetic-selftest-key", text)
        self.assertNotIn(PLACEHOLDER, text)

    def test_compare_checks_are_not_vacuous(self):
        """The compare checks must really run the interactions executor mock."""
        report, _ = self.run_selftest(GEMINI_API_MODE="interactions", LEGALMCP_PROXY_AUTH="1", CLAUDE_CODE_REMOTE="true")
        names = {c["name"]: c["status"] for c in report["checks"]}
        self.assertEqual(names["ai_compare.independence_mocked_auth_failure"], "passed")
        self.assertEqual(names["ai_compare.independence_mocked_retry_exhaustion"], "passed")

    def test_interactions_executor_mock_is_really_exercised(self):
        seen = []
        original = server.call_with_provider_retry

        async def spy(**kwargs):
            seen.append(getattr(kwargs.get("operation"), "__qualname__", ""))
            return await original(**kwargs)

        with mock.patch.object(server, "call_with_provider_retry", spy):
            report, hits = self.run_selftest(
                GEMINI_API_MODE="generate_content",
            )
        self.assert_clean(report, hits, "spy")
        # both compare checks run the interactions executor mock too,
        # regardless of the ambient GEMINI_API_MODE
        self.assertGreaterEqual(sum(q.endswith("interactions_mock") for q in seen), 2, seen)

    def test_shared_state_untouched(self):
        before = (server.GEMINI_INTERACTIONS_TRANSPORT, server.gemini_api_mode, server.post_gemini_interaction,
                  server.make_gemini_interactions_call, server.require_gemini_api_key, server.get_gemini_client)
        with env(GEMINI_API_MODE="interactions", LEGALMCP_PROXY_AUTH="1", CLAUDE_CODE_REMOTE="true"):
            env_before = dict(os.environ)
            self.run_selftest(GEMINI_API_MODE="interactions", LEGALMCP_PROXY_AUTH="1", CLAUDE_CODE_REMOTE="true")
            self.assertEqual(dict(os.environ), env_before)
        after = (server.GEMINI_INTERACTIONS_TRANSPORT, server.gemini_api_mode, server.post_gemini_interaction,
                 server.make_gemini_interactions_call, server.require_gemini_api_key, server.get_gemini_client)
        self.assertEqual(before, after)

    def test_no_paid_request_is_ever_recorded(self):
        calls = []
        original = server.post_gemini_interaction

        async def spy(*a, **k):
            calls.append(1)
            return await original(*a, **k)

        with mock.patch.object(server, "post_gemini_interaction", spy):
            report, hits = self.run_selftest(
                GEMINI_API_MODE="interactions", LEGALMCP_PROXY_AUTH="1", CLAUDE_CODE_REMOTE="true",
            )
        self.assert_clean(report, hits, "spy")
        self.assertEqual(calls, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
