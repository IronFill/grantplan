"""Offline tests for the cloud-only /print fallback of legal_collect_section.

No real network: the page is a synthetic fixture (not a real law), curl is
replaced by small fake executables or by a patched fetch function. Run:
    tools/legalmcp/.venv/bin/python -B tools/legalmcp/test_legal_print_fallback.py

Optional real-page check (kept out of the repository): set
LEGALMCP_REAL_PRINT_FIXTURE to a saved .../laws/show/4651-17/print HTML file
and LEGALMCP_REAL_PRINT_SHA256 to the expected hash of "Стаття 42.".
"""

import asyncio
import contextlib
import hashlib
import importlib.util
import json
import os
import pathlib
import stat
import tempfile
import unittest
from types import SimpleNamespace as NS
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location(
    "legalmcp_server_print_test", ROOT / "server.py"
)
server = importlib.util.module_from_spec(spec)
spec.loader.exec_module(server)

PAGE_URL = "https://zakon.rada.gov.ua/laws/show/1-06"
PRINT_URL = PAGE_URL + "/print"

FIXTURE = """<!DOCTYPE html>
<html lang="uk"><head><meta charset="utf-8">
<title>Тестовий кодекс | від 01.01.2000 № 1-VI (Текст для друку)</title>
<script>var t = "Стаття 1. це скрипт";</script></head>
<body><div class=toc><p class=rvps7>Зміст</p>
<ul><li><a href="#n11">Стаття 1. Мета</a></li><li><a href="#n15">Стаття 2. Наступна</a></li></ul></div>
<div id=text>
<p class=rvps7><a name="n10"></a>
Розділ I</p>
<p class=rvps2><a name="n11"></a>
<span class=rvts9>Стаття 1.</span> Мета</p>
<p class=rvps2><a name="n12"></a>
1. Перша частина з <a class=rvts99 href="#n20">посиланням</a>&nbsp;та пробілом.</p>
<em><p class=rvps2><a name="n13"></a>
<span class=rvts46>{Примітка про зміни}</span></p>
</em><p class=rvps2><a name="n14"></a>
2. Друга частина.</p>
<p class=rvps2><a name="n15"></a>
<span class=rvts9>Стаття 2.</span> Наступна</p>
<p class=rvps2><a name="n16"></a>
1. Текст другої.</p>
<p class=rvps2><a name="n17"></a>
<span class=rvts9>Стаття 3.</span> Остання</p>
<p class=rvps2><a name="n18"></a>
1. Текст третьої.</p>
</div></body></html>
"""

ARTICLE_1_BLOCKS = [
    "Стаття 1. Мета",
    "1. Перша частина з посиланням та пробілом.",
    "{Примітка про зміни}",
    "2. Друга частина.",
]


def sha(text):
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def fetched(html=FIXTURE, **overrides):
    value = {
        "ok": True, "failure_kind": None, "curl_exit_code": 0, "http_status": 200,
        "redirects": 0, "content_type": "text/html; charset=utf-8",
        "effective_url": PRINT_URL, "body": html.encode("utf-8"),
    }
    value.update(overrides)
    return value


class ParseSection(unittest.TestCase):
    def test_full_article_with_note_block(self):
        r = server.parse_legal_print_section(FIXTURE, "Стаття 1.")
        self.assertTrue(r["success"], r)
        self.assertEqual(r["blocks"], ARTICLE_1_BLOCKS)
        self.assertEqual(r["next_heading"], "Стаття 2. Наступна")
        self.assertEqual(r["boundary"], "next_article")
        self.assertEqual(r["anchor"], "n11")
        self.assertEqual(r["block_count"], 4)
        self.assertIn("Тестовий кодекс", r["title"])
        self.assertTrue(r["html"].startswith('<p class=rvps2><a name="n11">'))
        self.assertIn("<em>", r["html"])
        self.assertNotIn("Стаття 2.", r["html"])

    def test_toc_item_and_script_are_not_the_start(self):
        r = server.parse_legal_print_section(FIXTURE, "Стаття 2.")
        self.assertTrue(r["success"])
        self.assertEqual(r["anchor"], "n15")
        self.assertEqual(r["blocks"][0], "Стаття 2. Наступна")

    def test_start_is_case_insensitive(self):
        r = server.parse_legal_print_section(FIXTURE, "стаття 1.")
        self.assertTrue(r["success"])
        self.assertEqual(r["blocks"], ARTICLE_1_BLOCKS)

    def test_end_text_boundary(self):
        r = server.parse_legal_print_section(FIXTURE, "Стаття 1.", end_text="2. Друга")
        self.assertTrue(r["success"])
        self.assertEqual(r["blocks"], ARTICLE_1_BLOCKS[:3])
        self.assertEqual(r["boundary"], "end_text")

    def test_last_article_has_no_confirmed_boundary(self):
        r = server.parse_legal_print_section(FIXTURE, "Стаття 3.")
        self.assertFalse(r["success"])
        self.assertEqual(r["error_kind"], "boundary_not_confirmed")
        self.assertNotIn("blocks", r)

    def test_without_auto_stop_and_end_text_no_boundary(self):
        r = server.parse_legal_print_section(FIXTURE, "Стаття 1.", auto_stop_next_article=False)
        self.assertFalse(r["success"])
        self.assertEqual(r["error_kind"], "boundary_not_confirmed")

    def test_unknown_start(self):
        r = server.parse_legal_print_section(FIXTURE, "Стаття 99.")
        self.assertEqual((r["success"], r["error_kind"]), (False, "start_not_found"))

    def test_empty_start(self):
        self.assertEqual(server.parse_legal_print_section(FIXTURE, "  ")["error_kind"], "empty_start_text")

    def test_start_only_in_list_item_is_refused(self):
        html = "<html><head><title>T</title></head><body><ul><li><a name='n1'></a>Стаття 1. Мета</li><li>x</li></ul></body></html>"
        r = server.parse_legal_print_section(html, "Стаття 1.")
        self.assertEqual((r["success"], r["error_kind"]), (False, "start_not_a_heading_block"))

    def test_heading_without_site_anchor_is_refused(self):
        html = "<html><head><title>T</title></head><body><p>Стаття 1. Мета</p><p>1. Текст</p><p>Стаття 2. Інша</p></body></html>"
        r = server.parse_legal_print_section(html, "Стаття 1.")
        self.assertEqual((r["success"], r["error_kind"]), (False, "start_without_site_anchor"))

    def test_error_page_text_is_not_a_section(self):
        r = server.parse_legal_print_section("upstream request failed", "Стаття 1.")
        self.assertFalse(r["success"])

    def test_limits_do_not_count_as_success(self):
        r = server.parse_legal_print_section(FIXTURE, "Стаття 1.", max_blocks=2)
        self.assertEqual((r["success"], r["error_kind"]), (False, "limit_reached"))
        r = server.parse_legal_print_section(FIXTURE, "Стаття 1.", max_chars=10)
        self.assertEqual((r["success"], r["error_kind"]), (False, "limit_reached"))

    def test_unclosed_paragraphs_are_split_like_a_browser(self):
        html = ('<html><head><title>T</title></head><body>'
                '<p><a name="n1"></a>Стаття 1. А<p><a name="n2"></a>1. Б<p><a name="n3"></a>Стаття 2. В</body></html>')
        r = server.parse_legal_print_section(html, "Стаття 1.")
        self.assertTrue(r["success"])
        self.assertEqual(r["blocks"], ["Стаття 1. А", "1. Б"])

    def test_hidden_candidate_is_ignored(self):
        html = ('<html><head><title>T</title></head><body>'
                '<p style="display: none"><a name="n1"></a>Стаття 1. Прихована</p>'
                '<p><a name="n2"></a>Стаття 1. Справжня</p><p><a name="n3"></a>Стаття 2. Інша</p></body></html>')
        r = server.parse_legal_print_section(html, "Стаття 1.")
        self.assertEqual(r["blocks"], ["Стаття 1. Справжня"])

    def test_deep_nesting_is_refused_not_crashed(self):
        r = server.parse_legal_print_section("<div>" * 5000 + "Стаття 1.", "Стаття 1.")
        self.assertEqual((r["success"], r["error_kind"]), (False, "html_parse_failed"))

    def test_garbage_input_never_raises(self):
        for html in ("", "\x00<<<>>>", "<p", "</p></p></em>", "<a name='n1'>" * 2000):
            r = server.parse_legal_print_section(html, "Стаття 1.")
            self.assertFalse(r["success"])

    @unittest.skipUnless(
        os.environ.get("LEGALMCP_REAL_PRINT_FIXTURE") and os.environ.get("LEGALMCP_REAL_PRINT_SHA256"),
        "real print page fixture not provided",
    )
    def test_real_page_hash(self):
        html = pathlib.Path(os.environ["LEGALMCP_REAL_PRINT_FIXTURE"]).read_text(encoding="utf-8")
        r = server.parse_legal_print_section(html, "Стаття 42.")
        self.assertTrue(r["success"])
        text = server.clean_spaces("\n\n".join(r["blocks"]))
        self.assertEqual(sha(text), os.environ["LEGALMCP_REAL_PRINT_SHA256"])


class TargetGate(unittest.TestCase):
    def test_accepts_current_document_urls(self):
        cases = {
            "https://zakon.rada.gov.ua/laws/show/4651-17": "4651-17",
            "https://zakon.rada.gov.ua/laws/show/4651-17#n696": "4651-17",
            "https://zakon.rada.gov.ua/laws/show/z0082-12": "z0082-12",
            "https://zakon.rada.gov.ua/laws/show/v0001700-20": "v0001700-20",
            "https://zakon.rada.gov.ua/laws/show/995_004": "995_004",
            "https://zakon.rada.gov.ua/laws/show/254%D0%BA/96-%D0%B2%D1%80": "254%D0%BA/96-%D0%B2%D1%80",
            "https://zakon.rada.gov.ua/laws/show/254к/96-вр": "254к/96-вр",
        }
        for url, ident in cases.items():
            target, refusal = server.legal_print_fallback_target(url)
            self.assertIsNone(refusal, url)
            self.assertEqual(target, f"https://zakon.rada.gov.ua/laws/show/{ident}/print", url)

    def test_refuses_everything_else(self):
        base = "https://zakon.rada.gov.ua/laws/show/4651-17"
        refused = [
            "", "   ", "http://zakon.rada.gov.ua/laws/show/4651-17",
            "https://www.rada.gov.ua/laws/show/4651-17",
            "https://zakon.rada.gov.ua.evil.example/laws/show/4651-17",
            "https://zakon.rada.gov.ua@evil.example/laws/show/4651-17",
            "https://evil.example@zakon.rada.gov.ua/laws/show/4651-17",
            "https://zakon.rada.gov.ua:443/laws/show/4651-17",
            "https://ZAKON.RADA.GOV.UA/laws/show/4651-17",
            "https://zakonst.rada.gov.ua/laws/show/4651-17",
            base + "/ed20240101", base + "/ed20240101#n1", base + "/print", base + "/paran15",
            base + "/page", base + "/conv", base + "/", base + "?lang=uk", base + "?",
            base + ";x=1", base + "#bad frag", base + "#n1/../x", base + "/../4652-17",
            "https://zakon.rada.gov.ua/laws/main", "https://zakon.rada.gov.ua/laws/show/",
            "https://zakon.rada.gov.ua/laws/show/print", "https://zakon.rada.gov.ua/laws/show/ed20240101",
            "https://zakon.rada.gov.ua/laws/show/4651-17 ", "https://zakon.rada.gov.ua/laws/show/46\n51-17",
            "https://zakon.rada.gov.ua/", "javascript:alert(1)", "file:///etc/passwd",
            "https://zakon.rada.gov.ua/laws/show/4651-17%2F..%2F4652-17",
        ]
        for url in refused:
            target, refusal = server.legal_print_fallback_target(url)
            if url.strip() == base and url != base:
                continue  # a trailing space is stripped by validate_url upstream
            self.assertIsNone(target, repr(url))
            self.assertTrue(refusal, repr(url))

    def test_cloud_switch_is_exact(self):
        for value, expected in (("true", True), ("TRUE", True), ("", False), ("1", False),
                                ("yes", False), ("false", False)):
            with mock.patch.dict(os.environ, {"CLAUDE_CODE_REMOTE": value}):
                self.assertEqual(server.legal_print_fallback_enabled(), expected, value)
        with mock.patch.dict(os.environ, {}, clear=True):
            self.assertFalse(server.legal_print_fallback_enabled())

    def test_zone_host_check(self):
        self.assertTrue(server.legal_print_url_host_is_zakon(PAGE_URL + "/ed20240101"))
        self.assertFalse(server.legal_print_url_host_is_zakon("https://example.com/laws/show/1-06"))
        self.assertFalse(server.legal_print_url_host_is_zakon("http://zakon.rada.gov.ua/laws/show/1-06"))


class CurlArgv(unittest.TestCase):
    def test_argv_is_a_safe_list(self):
        argv = server.build_legal_print_curl_argv(PRINT_URL)
        self.assertTrue(all(isinstance(a, str) for a in argv))
        self.assertEqual(argv[:2], ["curl", "-q"])
        self.assertEqual(argv[-2:], ["--", PRINT_URL])
        pairs = dict(zip(argv, argv[1:]))
        self.assertEqual(pairs["--proto"], "=https")
        self.assertEqual(pairs["--max-redirs"], "0")
        self.assertEqual(pairs["--max-time"], str(server.LEGAL_PRINT_TIMEOUT_SECONDS))
        self.assertEqual(pairs["--max-filesize"], str(server.LEGAL_PRINT_MAX_BYTES))
        self.assertIn("--compressed", argv)
        for forbidden in ("-k", "--insecure", "-L", "--location", "-H", "--header", "-b", "--cookie",
                          "-u", "--user", "-x", "--proxy", "--cacert", "--capath", "-K", "--config"):
            self.assertNotIn(forbidden, argv)

    def test_url_with_shell_characters_stays_one_argument(self):
        weird = "https://zakon.rada.gov.ua/laws/show/1-06/print;$(touch /tmp/x)`id`"
        argv = server.build_legal_print_curl_argv(weird)
        self.assertEqual(argv[-1], weird)
        self.assertEqual(argv.count(weird), 1)


def make_fake_curl(directory, body):
    path = pathlib.Path(directory) / "curl"
    path.write_text("#!/bin/sh\n" + body)
    path.chmod(path.stat().st_mode | stat.S_IEXEC)


class FetchWithFakeCurl(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.argv_log = pathlib.Path(self.dir.name) / "argv.txt"

    def run_fetch(self, script, url=PRINT_URL, **patches):
        make_fake_curl(self.dir.name, script)
        env = {"PATH": self.dir.name + os.pathsep + "/usr/bin:/bin"}
        with mock.patch.dict(os.environ, env), contextlib.ExitStack() as stack:
            for name, value in patches.items():
                stack.enter_context(mock.patch.object(server, name, value))
            return asyncio.run(server.fetch_legal_print_page(url))

    def test_success_parses_marker_and_body(self):
        script = (
            f'printf "%s\\n" "$@" > "{self.argv_log}"\n'
            'printf "<html>ok</html>"\n'
            f'printf "LEGALMCP_CURL\\t200\\t0\\ttext/html; charset=utf-8\\t{PRINT_URL}\\n" >&2\n'
        )
        r = self.run_fetch(script)
        self.assertTrue(r["ok"], r)
        self.assertEqual((r["http_status"], r["redirects"], r["curl_exit_code"]), (200, 0, 0))
        self.assertEqual(r["content_type"], "text/html; charset=utf-8")
        self.assertEqual(r["effective_url"], PRINT_URL)
        self.assertEqual(r["body"], b"<html>ok</html>")
        self.assertEqual(self.argv_log.read_text().splitlines()[-1], PRINT_URL)

    def test_special_characters_reach_curl_as_a_single_argument_and_do_not_run(self):
        weird = PRINT_URL + ";touch pwned;$(touch pwned2)"
        script = f'printf "%s\\n" "$@" > "{self.argv_log}"\nprintf "x"\n'
        self.run_fetch(script, url=weird)
        lines = self.argv_log.read_text().splitlines()
        self.assertEqual(lines[-1], weird)
        self.assertFalse((pathlib.Path(self.dir.name) / "pwned").exists())
        self.assertFalse((pathlib.Path.cwd() / "pwned2").exists())

    def test_curl_failure_has_exit_code_and_no_body(self):
        r = self.run_fetch('printf "partial"\necho "curl: (35) boom" >&2\nexit 35\n')
        self.assertFalse(r["ok"])
        self.assertEqual((r["failure_kind"], r["curl_exit_code"]), ("curl_failed", 35))
        self.assertEqual(r["body"], b"")

    def test_size_limit(self):
        script = 'head -c 20000 /dev/zero\nprintf "LEGALMCP_CURL\\t200\\t0\\ttext/html\\tx\\n" >&2\n'
        r = self.run_fetch(script, LEGAL_PRINT_MAX_BYTES=1000)
        self.assertFalse(r["ok"])
        self.assertEqual(r["failure_kind"], "size_limit_exceeded")
        self.assertEqual(r["body"], b"")

    def test_timeout_kills_curl(self):
        r = self.run_fetch("exec sleep 30\n", LEGAL_PRINT_TIMEOUT_SECONDS=1, LEGAL_PRINT_GRACE_SECONDS=0)
        self.assertFalse(r["ok"])
        self.assertEqual(r["failure_kind"], "timeout")

    def test_curl_missing(self):
        with mock.patch.dict(os.environ, {"PATH": self.dir.name}):
            r = asyncio.run(server.fetch_legal_print_page(PRINT_URL))
        self.assertEqual((r["ok"], r["failure_kind"]), (False, "curl_not_found"))


class FakePage:
    def __init__(self, status=502, goto_error=None, body_chars=23):
        self.url = PAGE_URL
        self.status, self.goto_error, self.body_chars = status, goto_error, body_chars
        self.goto_calls = []

    async def goto(self, url, **kwargs):
        self.goto_calls.append(url)
        if self.goto_error:
            raise self.goto_error
        return NS(status=self.status)

    async def title(self):
        return "browser title"

    async def evaluate(self, *_args, **_kwargs):
        return self.body_chars

    async def wait_for_load_state(self, *_a, **_k):
        return None


class ToolEndToEnd(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.fetches = []
        self.extract_calls = []

    def run_tool(self, page, fetch_result=None, cloud=True, extract=None, **kwargs):
        async def fake_ensure(headless=True):
            return page

        async def fake_settle(*_a, **_k):
            return None

        async def fake_fetch(print_url):
            self.fetches.append(print_url)
            return fetch_result if fetch_result is not None else fetched()

        async def fake_extract(**kw):
            self.extract_calls.append(kw)
            return extract or {"success": False, "error": "Начало секции не найдено."}

        env = {"CLAUDE_CODE_REMOTE": "true"} if cloud else {"CLAUDE_CODE_REMOTE": ""}
        args = {"start_text": "Стаття 1.", "url": PAGE_URL}
        args.update(kwargs)
        with mock.patch.dict(os.environ, env), \
                mock.patch.object(server, "ensure_browser", fake_ensure), \
                mock.patch.object(server, "settle_page", fake_settle), \
                mock.patch.object(server, "fetch_legal_print_page", fake_fetch), \
                mock.patch.object(server, "extract_legal_section_from_page", fake_extract), \
                mock.patch.object(server, "RECORD_DIR", pathlib.Path(self.tmp.name)):
            return asyncio.run(server.legal_collect_section(**args))

    def assert_not_a_success(self, result):
        self.assertFalse(result["success"])
        self.assertNotIn("text", result)
        self.assertNotIn("text_sha256", result)

    def test_http_502_in_cloud_uses_print_and_saves_compatible_record(self):
        r = self.run_tool(FakePage(status=502))
        self.assertTrue(r["success"], r)
        self.assertEqual(self.fetches, [PRINT_URL])
        self.assertEqual(self.extract_calls, [])
        self.assertEqual(r["record_type"], "legal_section")
        self.assertEqual((r["requested_url"], r["source_url"]), (PAGE_URL, PRINT_URL))
        self.assertEqual((r["retrieval_method"], r["fallback_used"], r["fallback_reason"]),
                         ("http_print_fallback", True, "http_status:502"))
        self.assertEqual(r["http_status"], 200)
        self.assertEqual(r["text"], "\n\n".join(ARTICLE_1_BLOCKS))
        self.assertEqual(r["text_sha256"], sha(r["text"]))
        self.assertEqual((r["block_count"], r["char_count"]), (4, len(r["text"])))
        self.assertEqual((r["anchor"], r["next_heading"], r["boundary"]), ("n11", "Стаття 2. Наступна", "next_article"))
        self.assertIs(r["edition_verified"], False)
        self.assertIn("автоматически не проверялась", r["edition_note"])
        self.assertTrue(r["retrieved_at"])
        self.assertIn("Тестовий кодекс", r["document_title"])
        # same fields as the browser record, plus the new provenance fields
        for key in ("record_type", "success", "source_url", "http_status", "document_title", "section",
                    "matched_start", "anchor", "next_heading", "retrieved_at", "text", "text_sha256",
                    "block_count", "char_count", "html"):
            self.assertIn(key, r)
        saved = sorted(p.suffix for p in pathlib.Path(self.tmp.name).iterdir())
        self.assertEqual(saved, [".html", ".json", ".txt"])
        json_file = next(pathlib.Path(self.tmp.name).glob("*.json"))
        self.assertEqual(json.loads(json_file.read_text(encoding="utf-8"))["text_sha256"], r["text_sha256"])

    def test_save_record_false_writes_nothing(self):
        r = self.run_tool(FakePage(status=502), save_record=False)
        self.assertTrue(r["success"])
        self.assertEqual(list(pathlib.Path(self.tmp.name).iterdir()), [])

    def test_navigation_error_in_cloud(self):
        r = self.run_tool(FakePage(goto_error=TimeoutError("x")))
        self.assertTrue(r["success"])
        self.assertEqual(r["fallback_reason"], "navigation_error:TimeoutError")

    def test_empty_page_with_200_in_cloud(self):
        r = self.run_tool(FakePage(status=200, body_chars=23))
        self.assertTrue(r["success"])
        self.assertEqual(r["fallback_reason"], "empty_page:23_chars")

    def test_healthy_page_with_missing_section_does_not_fallback(self):
        r = self.run_tool(FakePage(status=200, body_chars=50_000))
        self.assertEqual(self.fetches, [])
        self.assertFalse(r["success"])
        self.assertNotIn("fallback", r)
        self.assertEqual(len(self.extract_calls), 1)

    def test_healthy_page_keeps_browser_record(self):
        raw = {"success": True, "blocks": ["Стаття 1. Мета"], "matched_start": "Стаття 1. Мета",
               "anchor": "n11", "next_heading": "Стаття 2.", "block_count": 1, "html": "<p>x</p>"}
        r = self.run_tool(FakePage(status=200, body_chars=50_000), extract=raw)
        self.assertTrue(r["success"])
        self.assertEqual(self.fetches, [])
        self.assertNotIn("retrieval_method", r)
        self.assertNotIn("requested_url", r)

    def test_outside_cloud_nothing_changes(self):
        r = self.run_tool(FakePage(status=502), cloud=False)
        self.assertEqual(self.fetches, [])
        self.assertEqual(len(self.extract_calls), 1)
        self.assertFalse(r["success"])
        self.assertNotIn("fallback", r)
        with self.assertRaises(TimeoutError):
            self.run_tool(FakePage(goto_error=TimeoutError("x")), cloud=False)

    def test_historical_and_unsupported_urls_are_refused(self):
        for url in (PAGE_URL + "/ed20240101", PAGE_URL + "/print", PAGE_URL + "?lang=uk",
                    "https://zakon.rada.gov.ua/laws/main"):
            self.fetches.clear()
            r = self.run_tool(FakePage(status=502), url=url)
            self.assert_not_a_success(r)
            self.assertEqual(self.fetches, [], url)
            self.assertFalse(r["fallback"]["attempted"], url)
            self.assertTrue(r["fallback"]["refused"], url)

    def test_other_hosts_are_not_in_the_fallback_zone(self):
        r = self.run_tool(FakePage(status=502), url="https://example.com/laws/show/1-06")
        self.assertEqual(self.fetches, [])
        self.assertNotIn("fallback", r)

    def test_no_url_means_no_fallback(self):
        page = FakePage(status=502)
        r = self.run_tool(page, url="")
        self.assertEqual((self.fetches, page.goto_calls), ([], []))
        self.assertNotIn("fallback", r)

    def test_start_selector_is_not_supported_by_fallback(self):
        r = self.run_tool(FakePage(status=502), start_selector="#n11")
        self.assert_not_a_success(r)
        self.assertEqual(self.fetches, [])
        self.assertEqual(r["fallback"]["refused"], "start_selector_not_supported")

    def test_print_fetch_problems_never_give_success(self):
        bad = {
            "fetch failed": fetched(ok=False, failure_kind="curl_failed", curl_exit_code=22, body=b""),
            "timeout": fetched(ok=False, failure_kind="timeout", body=b""),
            "size": fetched(ok=False, failure_kind="size_limit_exceeded", body=b""),
            "http 502": fetched(http_status=502),
            "http 404": fetched(http_status=404),
            "redirect": fetched(redirects=1),
            "other host": fetched(effective_url="https://example.com/print"),
            "not html": fetched(content_type="application/json"),
            "not utf8": fetched(html="", body="Стаття 1.".encode("cp1251")),
            "error body": fetched(html="upstream request failed"),
            "other doc text": fetched(html="<html><head><title>T</title></head><body><p>nothing</p></body></html>"),
            "no title": fetched(html=FIXTURE.replace("<title>Тестовий кодекс | від 01.01.2000 № 1-VI (Текст для друку)</title>", "")),
            "replacement chars": fetched(html=FIXTURE.replace("Мета", "М�та")),
        }
        for name, value in bad.items():
            r = self.run_tool(FakePage(status=502), fetch_result=value)
            self.assert_not_a_success(r)
            self.assertTrue(r["fallback"]["attempted"], name)
            self.assertFalse(r["fallback"]["used"], name)

    def test_incomplete_sections_never_give_success(self):
        for start in ("Стаття 3.", "Стаття 99."):
            r = self.run_tool(FakePage(status=502), start_text=start)
            self.assert_not_a_success(r)
            self.assertIn("fallback", r)

    def test_failure_metadata_is_safe(self):
        r = self.run_tool(FakePage(status=502), fetch_result=fetched(http_status=502, body=b"Authorization: Bearer abc"))
        dumped = json.dumps(r, ensure_ascii=False).lower()
        for needle in ("authorization", "bearer", "cookie", "api_key", "abc"):
            self.assertNotIn(needle, dumped)

    def test_tool_signature_unchanged(self):
        import inspect
        self.assertEqual(
            list(inspect.signature(server.legal_collect_section).parameters),
            ["start_text", "url", "end_text", "start_selector", "auto_stop_next_article",
             "save_record", "filename", "headless"],
        )


if __name__ == "__main__":
    unittest.main(verbosity=2)
