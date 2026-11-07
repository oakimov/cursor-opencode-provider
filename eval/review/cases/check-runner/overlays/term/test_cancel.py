import signal
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import runner


class Cancellation(unittest.TestCase):
    def test_cancel_stops_the_check_session(self):
        with patch.object(runner.subprocess, "Popen") as popen, patch.object(runner.os, "killpg") as killpg:
            child = popen.return_value
            child.pid = 4321
            child.wait.side_effect = [KeyboardInterrupt, 0]
            with self.assertRaises(KeyboardInterrupt):
                runner.run(["check"], Path("."))
            killpg.assert_called_once_with(4321, signal.SIGTERM)

    def test_termination_exits_143(self):
        with patch.object(runner, "run_checks", side_effect=runner.Terminated):
            self.assertEqual(runner.main(["--source", "."]), 143)

    def test_a_finished_check_leaves_no_background_process(self):
        with tempfile.TemporaryDirectory() as source:
            started = Path(source) / "started"
            background = (
                "import subprocess, sys; "
                "subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)']); "
                f"open({str(started)!r}, 'w').write('1')"
            )
            self.assertEqual(runner.run_checks(Path(source), [[sys.executable, "-c", background]]), 0)
            self.assertTrue(started.exists())


if __name__ == "__main__":
    unittest.main()
