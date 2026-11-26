"""Offline check of the project .mcp.json entry for LegalMCP.

Per the Claude Code MCP docs (code.claude.com/docs/en/mcp, read in the session
of this commit) a per-server "timeout" in milliseconds in .mcp.json is the
wall-clock limit of one tool call for that server and overrides
MCP_TOOL_TIMEOUT; values below 1000 are ignored. It is separate from
MCP_TIMEOUT (startup). This test only validates the file; it cannot show that
a given Claude Code build enforces the value.

    python3 -B tools/legalmcp/test_mcp_config.py
"""

import json
import pathlib
import unittest

REPO = pathlib.Path(__file__).resolve().parents[2]
MIN_TOOL_TIMEOUT_MS = 150_000  # longer than the slowest internal review (~120 s)


class McpConfig(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.config = json.loads((REPO / ".mcp.json").read_text(encoding="utf-8"))
        cls.entry = cls.config["mcpServers"]["LegalMCP"]

    def test_server_launch_unchanged(self):
        self.assertEqual(self.entry["type"], "stdio")
        self.assertEqual(self.entry["command"], "bash")
        self.assertEqual(self.entry["args"], ["tools/legalmcp/launch.sh"])
        self.assertEqual(
            self.entry["env"],
            {"PYTHONDONTWRITEBYTECODE": "1", "GEMINI_API_MODE": "interactions"},
        )

    def test_per_server_timeout_is_valid_milliseconds(self):
        timeout = self.entry["timeout"]
        self.assertIsInstance(timeout, int)
        self.assertNotIsInstance(timeout, bool)
        self.assertGreaterEqual(timeout, 1000)  # below 1000 Claude Code ignores it

    def test_timeout_covers_internal_review_deadline(self):
        self.assertGreaterEqual(self.entry["timeout"], MIN_TOOL_TIMEOUT_MS)
        self.assertEqual(self.entry["timeout"], 180_000)

    def test_no_secret_like_values_in_config(self):
        text = json.dumps(self.config).lower()
        for needle in ("api_key", "apikey", "bearer ", "sk-", "token"):
            self.assertNotIn(needle, text)

    def test_only_legalmcp_server_defined(self):
        self.assertEqual(list(self.config["mcpServers"]), ["LegalMCP"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
