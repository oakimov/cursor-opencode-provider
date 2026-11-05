import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from retry_due import run


class RetryDueTest(unittest.TestCase):
    def test_later_run_attempts_the_id_that_failed(self):
        state = {"entries": {}, "due": ["pkg"]}
        calls = []

        def fetch(key):
            calls.append(key)
            if len(calls) == 1:
                raise RuntimeError("down")
            return "2"

        self.assertEqual(run(state, fetch), 1)
        self.assertEqual(state["due"], ["pkg"])
        self.assertEqual(run(state, fetch), 0)
        self.assertEqual(state["entries"]["pkg"], "2")
        self.assertEqual(state["due"], [])


if __name__ == "__main__":
    unittest.main()
