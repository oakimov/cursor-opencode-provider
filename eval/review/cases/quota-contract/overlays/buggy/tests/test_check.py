import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from check import main


class CheckTest(unittest.TestCase):
    def test_over_limit_is_accepted(self):
        self.assertEqual(main(100, 10), 0)


if __name__ == "__main__":
    unittest.main()
