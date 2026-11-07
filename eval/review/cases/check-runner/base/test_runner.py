import sys
import tempfile
import unittest
from pathlib import Path

import runner


class RunChecks(unittest.TestCase):
    def test_returns_the_first_failing_status(self):
        with tempfile.TemporaryDirectory() as source:
            ok = [sys.executable, "-c", "raise SystemExit(0)"]
            failed = [sys.executable, "-c", "raise SystemExit(3)"]
            never = [sys.executable, "-c", "raise SystemExit(9)"]
            self.assertEqual(runner.run_checks(Path(source), [ok, failed, never]), 3)

    def test_runs_in_a_private_copy(self):
        with tempfile.TemporaryDirectory() as source:
            (Path(source) / "input.txt").write_text("source\n", encoding="utf-8")
            edit = [sys.executable, "-c", "open('input.txt', 'w').write('changed')"]
            self.assertEqual(runner.run_checks(Path(source), [edit]), 0)
            self.assertEqual((Path(source) / "input.txt").read_text(encoding="utf-8"), "source\n")


if __name__ == "__main__":
    unittest.main()
