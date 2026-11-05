import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from capability import apply


class CapabilityTest(unittest.TestCase):
    def test_unforced_failure_keeps_an_observed_true(self):
        self.assertEqual(apply({"item": True}, "item", False, False), {"item": True})

    def test_forced_negative_replaces_the_record(self):
        self.assertEqual(apply({"item": True}, "item", False, True), {"item": False})


if __name__ == "__main__":
    unittest.main()
