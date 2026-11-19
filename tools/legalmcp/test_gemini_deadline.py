"""Network-free regression tests for bounded Gemini calls."""
import asyncio
import importlib.util
import pathlib
import time
import unittest
from unittest import mock

spec = importlib.util.spec_from_file_location('server_deadline', pathlib.Path(__file__).with_name('server.py'))
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

class DeadlineTests(unittest.IsolatedAsyncioTestCase):
    async def test_transport_cleanup_closes_async_client(self):
        from types import SimpleNamespace
        close = mock.AsyncMock()
        await server.close_gemini_client(SimpleNamespace(aio=SimpleNamespace(aclose=close)))
        close.assert_awaited_once()

    async def test_cleanup_error_does_not_hide_provider_result(self):
        from types import SimpleNamespace
        close = mock.AsyncMock(side_effect=RuntimeError('transport already closed'))
        await server.close_gemini_client(SimpleNamespace(aio=SimpleNamespace(aclose=close)))
        close.assert_awaited_once()

    async def test_hanging_async_request_is_cancelled_without_retry(self):
        calls = 0
        cancelled = False
        async def hanging():
            nonlocal calls, cancelled
            calls += 1
            try:
                await asyncio.Event().wait()
            finally:
                cancelled = True
        started = time.monotonic()
        with self.assertRaises(server.GeminiCallError):
            await server.call_with_gemini_retry(hanging, deadline=started + .03)
        self.assertTrue(cancelled)
        self.assertEqual(calls, 1)
        self.assertLess(time.monotonic() - started, .5)

    async def test_expired_deadline_never_starts_request(self):
        request = mock.AsyncMock(return_value='OK')
        with self.assertRaises(server.GeminiCallError):
            await server.call_with_gemini_retry(request, deadline=time.monotonic() - 1)
        request.assert_not_called()

    async def test_backoff_cannot_overrun_total_deadline(self):
        class Temporary(Exception):
            status_code = 503
        request = mock.AsyncMock(side_effect=Temporary('synthetic'))
        history = []
        with self.assertRaises(server.GeminiCallError):
            await server.call_with_gemini_retry(request, error_history=history, deadline=time.monotonic()+.03)
        self.assertEqual(request.call_count, 1)
        self.assertEqual(len(history), 1)

    async def test_caller_cancellation_propagates(self):
        started = asyncio.Event()
        stopped = asyncio.Event()
        async def request():
            started.set()
            try:
                await asyncio.Event().wait()
            finally:
                stopped.set()
        task = asyncio.create_task(server.call_with_gemini_retry(request))
        await started.wait()
        task.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await task
        self.assertTrue(stopped.is_set())

    async def test_sdk_has_one_attempt_and_transport_timeout(self):
        with mock.patch.object(server, 'resolve_provider_key', return_value=('synthetic', 'test')), mock.patch.object(server.genai, 'Client') as factory:
            server.get_gemini_client()
        options = factory.call_args.kwargs['http_options']
        self.assertEqual(options.timeout, 60000)
        self.assertEqual(options.retry_options.attempts, 1)

if __name__ == '__main__':
    unittest.main()
