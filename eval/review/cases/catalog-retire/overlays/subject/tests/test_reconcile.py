import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from reconcile import reconcile


class ReconcileTest(unittest.TestCase):
    def test_usable_shorter_list_removes_only_absent_ids(self):
        kept, status = reconcile({"keep": True, "retired": False}, ["keep"], True)
        self.assertEqual(status, "ok")
        self.assertEqual(kept, {"keep": True})

    def test_unusable_response_keeps_the_record(self):
        record = {"keep": True, "retired": False}
        kept, status = reconcile(record, [], False)
        self.assertEqual(status, "unusable")
        self.assertEqual(kept, record)


if __name__ == "__main__":
    unittest.main()
