import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from log_line import store_line


class LogLineTest(unittest.TestCase):
    def test_long_line_is_truncated(self):
        self.assertEqual(len(store_line("x" * 2000)), 1024)


if __name__ == "__main__":
    unittest.main()
