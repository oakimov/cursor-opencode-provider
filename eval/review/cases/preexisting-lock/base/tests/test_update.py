import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "ledger"))
from lock import update


class UpdateTest(unittest.TestCase):
    def test_mutation_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            path = str(Path(directory) / "counter")

            def mutate(handle):
                handle.seek(0)
                handle.write("1")
                handle.flush()

            update(path, mutate)
            self.assertEqual(Path(path).read_text(encoding="utf-8"), "1")


if __name__ == "__main__":
    unittest.main()
