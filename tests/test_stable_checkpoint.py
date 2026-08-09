import unittest

from scripts.stable_checkpoint import DEFAULT_REF, DEFAULT_SHA, validation_commands


class StableCheckpointToolTests(unittest.TestCase):
    def test_defaults_match_registered_checkpoint(self):
        self.assertEqual(DEFAULT_REF, "stable/2026-08-09-be14a389")
        self.assertEqual(DEFAULT_SHA, "be14a389d7e11f1df9f935999d888e7e2295c8a3")

    def test_validation_is_local_and_has_foundation_and_s2(self):
        rendered = " ".join(" ".join(command) for command in validation_commands())
        self.assertIn("scripts/validate_foundation.py", rendered)
        self.assertIn("scripts/validate_s2.py", rendered)
        self.assertNotIn("wrangler", rendered.lower())
        self.assertNotIn("cloudflare", rendered.lower())


if __name__ == "__main__":
    unittest.main()
