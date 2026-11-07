import json
import math
import tempfile
import unittest
from pathlib import Path

from exporter import export_rows


class Export(unittest.TestCase):
    def test_writes_every_row(self):
        with tempfile.TemporaryDirectory() as directory:
            dest = Path(directory) / "out.jsonl"
            export_rows([{"n": index} for index in range(500)], dest)
            lines = dest.read_text(encoding="utf-8").splitlines()
            self.assertEqual([json.loads(line)["n"] for line in lines], list(range(500)))

    def test_invalid_row_leaves_dest_unchanged(self):
        with tempfile.TemporaryDirectory() as directory:
            dest = Path(directory) / "out.jsonl"
            dest.write_text("previous\n", encoding="utf-8")
            with self.assertRaises(ValueError):
                export_rows([{"n": 1}, {"n": math.nan}], dest)
            self.assertEqual(dest.read_text(encoding="utf-8"), "previous\n")


if __name__ == "__main__":
    unittest.main()
