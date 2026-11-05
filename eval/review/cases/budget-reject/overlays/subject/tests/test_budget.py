import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from budget import accept


class BudgetTest(unittest.TestCase):
    def test_over_limit_is_rejected(self):
        with self.assertRaises(ValueError):
            accept([12, 9])


if __name__ == "__main__":
    unittest.main()
