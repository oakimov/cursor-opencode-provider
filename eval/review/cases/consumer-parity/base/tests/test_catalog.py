import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from catalog import catalog


class Catalog(unittest.TestCase):
    def test_explicit_flag(self):
        model = {"tunable": True, "levels": [{"id": "high", "settings": {"depth": 3}}]}
        for consumer in ("legacy", "modern"):
            self.assertEqual(catalog(consumer, model)["choices"], model["levels"])

    def test_no_choices(self):
        for consumer in ("legacy", "modern"):
            self.assertEqual(catalog(consumer, {"tunable": False, "levels": []}), {"choices": []})


if __name__ == "__main__":
    unittest.main()
