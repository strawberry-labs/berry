import json
import sys
import tempfile
import unittest
from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
from prepare_cv_input import build_payload, project_records
from v3.preprocess_cv_data_v3 import preprocess_cv

class InputChoicesTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.photo = Path(self.tmp.name) / "photo.jpg"
        Image.new("RGB", (300, 300), "gray").save(self.photo)
        self.spec = {
            "name": "Synthetic Test", "role": "Sustainability Consultant",
            "overview": "Sustainability and carbon management.",
            "work_experience": [], "confirm_no_work_experience": True,
            "selected_projects": [], "confirm_no_selected_projects": True,
            "qualifications": ["Qualification retained"],
            "memberships": ["Membership retained"], "key_expertise": []
        }

    def context(self):
        return preprocess_cv(build_payload(self.spec, self.photo)["cvs"][0])

    def test_omission_disables_both_fallbacks_and_supplied_expertise(self):
        for expertise in ([], ["Explicit expertise"]):
            self.spec.update(omit_key_expertise=True, key_expertise=expertise)
            context = self.context()
            for key in ("key_expertise", "key_expertise_portrait", "key_expertise_landscape"):
                self.assertEqual(context[key], [])
            self.assertTrue(context["qualifications"])
            self.assertTrue(context["memberships"])

    def test_default_inference_is_preserved(self):
        self.assertTrue(self.context()["key_expertise"])

    def test_invalid_boolean_is_rejected(self):
        for value in ("true", 1, None):
            self.spec["omit_key_expertise"] = value
            with self.assertRaisesRegex(ValueError, "JSON boolean"):
                build_payload(self.spec, self.photo)

    def test_shared_description_requires_opt_in_and_preserves_override(self):
        spec = {"shared_project_description": "Exact shared duties.",
                "selected_projects": [{"name": "A", "use_shared_description": True},
                                      {"name": "B", "description": "Specific duties.", "use_shared_description": True}]}
        records = project_records(spec)
        self.assertEqual([r["description"] for r in records], ["Exact shared duties.", "Specific duties."])
        spec["selected_projects"] = [{"name": "C"}]
        with self.assertRaises(ValueError):
            project_records(spec)
        spec["selected_projects"] = [{"name": "C", "use_shared_description": "true"}]
        with self.assertRaisesRegex(ValueError, "JSON boolean"):
            project_records(spec)

if __name__ == "__main__":
    unittest.main()
