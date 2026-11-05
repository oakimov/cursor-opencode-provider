import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from validate import rejection


class ValidateTest(unittest.TestCase):
    def test_parent_segment_is_rejected(self):
        self.assertEqual(rejection("../secret"), "path leaves the workspace")

    def test_workspace_relative_path_is_allowed(self):
        self.assertIsNone(rejection("docs/note.txt"))


if __name__ == "__main__":
    unittest.main()
