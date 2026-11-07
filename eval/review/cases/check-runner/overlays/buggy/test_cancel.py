import signal
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

    def test_interrupt_exits_130(self):
        with patch.object(runner, "run_checks", side_effect=KeyboardInterrupt):
            self.assertEqual(runner.main(["--source", "."]), 130)


if __name__ == "__main__":
    unittest.main()
