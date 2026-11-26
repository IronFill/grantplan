"""Offline tests for launch.sh: proxy-auth default and core-only setup.

launch.sh is copied into a temp dir next to a stub `.venv/bin/python` (prints
the env it would hand to server.py) and a stub `setup.sh` (records its
arguments). No network, no keys, no browser. Run:
    python3 -B tools/legalmcp/test_launch_mode.py
"""

import hashlib
import os
import pathlib
import shutil
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent
UNSET = "<unset>"
PASS = ("PATH", "HOME")


def make_root(ready=True, env_file=None):
    d = pathlib.Path(tempfile.mkdtemp(prefix="legalmcp-launch-"))
    shutil.copy(ROOT / "launch.sh", d / "launch.sh")
    shutil.copy(ROOT / "requirements.txt", d / "requirements.txt")
    wanted = hashlib.sha256((d / "requirements.txt").read_bytes()).hexdigest()
    (d / "setup.sh").write_text(
        "#!/usr/bin/env bash\n"
        'echo "$@" >> "$(dirname "$0")/setup-calls.txt"\n'
        'mkdir -p "$(dirname "$0")/.venv/bin"\n'
        'cp "$(dirname "$0")/python.stub" "$(dirname "$0")/.venv/bin/python"\n'
        'chmod +x "$(dirname "$0")/.venv/bin/python"\n'
        f'printf "%s\\n" {wanted} > "$(dirname "$0")/.setup-ready"\n'
    )
    (d / "python.stub").write_text(
        "#!/usr/bin/env bash\n"
        'echo "PROXY_AUTH=${LEGALMCP_PROXY_AUTH-<unset>}"\n'
        'echo "CHROMIUM=${LEGALMCP_CHROMIUM_EXECUTABLE_PATH-<unset>}"\n'
    )
    if ready:
        (d / ".venv/bin").mkdir(parents=True)
        shutil.copy(d / "python.stub", d / ".venv/bin/python")
        (d / ".venv/bin/python").chmod(0o755)
        (d / ".setup-ready").write_text(wanted + "\n")
    if env_file is not None:
        (d / ".env").write_text(env_file)
    return d


def run(d, **env):
    full = {k: os.environ[k] for k in PASS if k in os.environ}
    # keep the preinstalled-Chromium fallback out of these tests
    full["PLAYWRIGHT_BROWSERS_PATH"] = str(d / "no-browsers")
    full.update(env)
    out = subprocess.run(
        ["bash", str(d / "launch.sh")], env=full, capture_output=True, text=True, timeout=30
    )
    values = dict(line.split("=", 1) for line in out.stdout.splitlines() if "=" in line)
    return out, values["PROXY_AUTH"]


class ProxyAuthDefault(unittest.TestCase):
    def check(self, expected, env_file=None, **env):
        d = make_root(env_file=env_file)
        try:
            out, value = run(d, **env)
            self.assertEqual(out.returncode, 0, out.stderr)
            self.assertEqual(value, expected, out.stderr)
            return out
        finally:
            shutil.rmtree(d)

    def test_cloud_unset_turns_on(self):
        out = self.check("1", CLAUDE_CODE_REMOTE="true")
        self.assertIn("proxy-auth mode on", out.stderr)

    def test_local_stays_unset(self):
        self.check(UNSET)

    def test_remote_false_or_other_stays_unset(self):
        self.check(UNSET, CLAUDE_CODE_REMOTE="false")
        self.check(UNSET, CLAUDE_CODE_REMOTE="1")

    def test_explicit_zero_preserved(self):
        self.check("0", CLAUDE_CODE_REMOTE="true", LEGALMCP_PROXY_AUTH="0")

    def test_explicit_empty_preserved(self):
        self.check("", CLAUDE_CODE_REMOTE="true", LEGALMCP_PROXY_AUTH="")

    def test_explicit_one_preserved(self):
        self.check("1", CLAUDE_CODE_REMOTE="true", LEGALMCP_PROXY_AUTH="1")

    def test_explicit_value_without_remote_preserved(self):
        self.check("1", LEGALMCP_PROXY_AUTH="1")

    def test_dotenv_explicit_disable_not_overridden(self):
        # server.py reads .env itself; launch.sh must not shadow it by exporting 1
        self.check(UNSET, env_file="LEGALMCP_PROXY_AUTH=0\n", CLAUDE_CODE_REMOTE="true")
        self.check(UNSET, env_file="  LEGALMCP_PROXY_AUTH = 0\n", CLAUDE_CODE_REMOTE="true")

    def test_unrelated_dotenv_lines_do_not_block_default(self):
        self.check("1", env_file="# LEGALMCP_PROXY_AUTH=0\nOPENAI_REVIEW_MODEL=x\n", CLAUDE_CODE_REMOTE="true")


class CoreOnlyStartup(unittest.TestCase):
    def test_ready_install_skips_setup(self):
        d = make_root(ready=True)
        try:
            run(d)
            self.assertFalse((d / "setup-calls.txt").exists())
        finally:
            shutil.rmtree(d)

    def test_not_ready_runs_core_stage_only(self):
        d = make_root(ready=False)
        try:
            out, _ = run(d)
            self.assertEqual(out.returncode, 0, out.stderr)
            calls = (d / "setup-calls.txt").read_text().split()
            self.assertEqual(calls, ["core"])
        finally:
            shutil.rmtree(d)

    def test_setup_stdout_goes_to_stderr_not_protocol_stream(self):
        d = make_root(ready=False)
        (d / "setup.sh").write_text(
            (d / "setup.sh").read_text() + 'echo "noise from setup"\n'
        )
        try:
            out, _ = run(d)
            self.assertNotIn("noise from setup", out.stdout)
            self.assertIn("noise from setup", out.stderr)
        finally:
            shutil.rmtree(d)


if __name__ == "__main__":
    unittest.main(verbosity=2)
