import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from release_gate import release


class ReleaseGateTest(unittest.TestCase):
    def test_untested_package_blocks_release(self):
        self.assertEqual(release({"ready": True, "fresh": False}), 1)


if __name__ == "__main__":
    unittest.main()
