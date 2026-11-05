import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from indexlib.merge import merge


class MergeTest(unittest.TestCase):
    def test_right_replaces_left(self):
        self.assertEqual(merge({"a": "1"}, {"a": "2", "b": "3"}), {"a": "2", "b": "3"})


if __name__ == "__main__":
    unittest.main()
