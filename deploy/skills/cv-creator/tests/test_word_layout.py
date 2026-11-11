import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch, Mock
from zipfile import ZipFile

from lxml import etree
from docx import Document
from scripts.v3.word_layout import (
    NS, W, verdana_path, normalize_project_template, PROJECT_BEFORE_DXA, PROJECT_AFTER_DXA,
)
from scripts.v3.render_docx_v3 import (
    tune_experience_hanging_indents, EXPERIENCE_FONT, EXPERIENCE_MEASURE_SCALE,
    docx_render_context, render_validated_landscape_context,
)

ROOT = Path(__file__).resolve().parents[1]


class WordLayoutTests(unittest.TestCase):
    def test_long_date_and_wrapped_roles_share_one_safe_tab(self):
        prefixes = ["2024 – Present:", "2014 – 2024:", "September 2003 – November 2008:"]
        with tempfile.TemporaryDirectory() as directory:
            for orientation in ("portrait", "landscape"):
                path = Path(directory) / (orientation + ".docx")
                doc = Document()
                for prefix in prefixes:
                    p = doc.add_paragraph()
                    p.add_run(prefix)
                    p.add_run().add_tab()
                    p.add_run("Mechanical Engineer – Testing & Commissioning, Long Organisation Name")
                doc.save(path)
                tune_experience_hanging_indents(path, orientation)
                with ZipFile(path) as package:
                    root = etree.fromstring(package.read("word/document.xml"))
                tabs = root.xpath(".//w:pPr/w:tabs/w:tab/@w:pos", namespaces=NS)
                left = root.xpath(".//w:pPr/w:ind/@w:left", namespaces=NS)
                hanging = root.xpath(".//w:pPr/w:ind/@w:hanging", namespaces=NS)
                self.assertEqual(len(set(tabs)), 1)
                self.assertEqual(tabs, left)
                self.assertEqual(tabs, hanging)
                widest = max(EXPERIENCE_FONT.getlength(p) for p in prefixes)
                self.assertGreater(int(tabs[0]), widest / EXPERIENCE_MEASURE_SCALE * 20)
                self.assertEqual(root.xpath("count(.//w:r/w:tab)", namespaces=NS), 3)

    def test_all_project_variants_use_reference_spacing_and_can_flow(self):
        for orientation, count in (("portrait", 2), ("landscape", 16)):
            with ZipFile(ROOT / "assets/templates/v3" / ("aesg_cv_" + orientation + "_v3.docx")) as package:
                root = etree.fromstring(package.read("word/document.xml"))
            descriptions = root.xpath(".//w:p[w:pPr/w:pStyle[@w:val='AESGProjectDescription']]", namespaces=NS)
            self.assertEqual(len(descriptions), count)
            for p in descriptions:
                self.assertFalse(p.xpath(".//w:br", namespaces=NS))
                self.assertEqual(p.find(W+"pPr/"+W+"jc").get(W+"val"), "left")
                spacing = p.find(W+"pPr/"+W+"spacing")
                self.assertEqual(spacing.get(W+"before"), str(PROJECT_BEFORE_DXA))
                self.assertEqual(spacing.get(W+"after"), str(PROJECT_AFTER_DXA))
                self.assertEqual(spacing.get(W+"line"), "240")
                for flag in ("keepNext", "keepLines"):
                    self.assertEqual(p.find(W+"pPr/"+W+flag).get(W+"val"), "0")
                for row in p.iterancestors(W+"tr"):
                    self.assertIsNone(row.find(W+"trPr/"+W+"cantSplit"))
            titles = root.xpath(".//w:p[w:pPr/w:pStyle[@w:val='AESGProjectTitle']]", namespaces=NS)
            self.assertEqual(len(titles), count)
            for p in titles:
                self.assertEqual(p.find(W+"pPr/"+W+"keepNext").get(W+"val"), "1")

    def test_template_maintenance_is_idempotent_and_preserves_photos_and_headers(self):
        for orientation in ("portrait", "landscape"):
            original = ROOT / "assets/templates/v3" / ("aesg_cv_" + orientation + "_v3.docx")
            with tempfile.TemporaryDirectory() as directory:
                path = Path(directory) / "template.docx"
                shutil.copyfile(original, path)
                normalize_project_template(path)
                with ZipFile(original) as a, ZipFile(path) as b:
                    self.assertEqual(a.namelist(), b.namelist())
                    for name in a.namelist():
                        self.assertEqual(a.read(name), b.read(name), name)

    def test_managed_linux_font_directory_is_supported(self):
        verdana_path.cache_clear()
        font = Path("/usr/local/share/fonts/aesg/verdana.ttf")
        with patch("pathlib.Path.is_file", autospec=True, side_effect=lambda p: p == font), \
             patch("pathlib.Path.is_dir", autospec=True, side_effect=lambda p: str(p) == "/usr/local/share/fonts/aesg"), \
             patch("pathlib.Path.rglob", return_value=iter([font])), \
             patch("scripts.v3.word_layout.ImageFont.truetype", return_value=Mock(getname=lambda: ("Verdana", "Regular"))), \
             patch("scripts.v3.word_layout.subprocess.run") as fc:
            self.assertEqual(verdana_path(), font)
            fc.assert_not_called()
        verdana_path.cache_clear()

    def test_substitute_font_is_rejected_instead_of_mismeasuring(self):
        verdana_path.cache_clear()
        with patch("pathlib.Path.is_file", return_value=False), \
             patch("pathlib.Path.is_dir", return_value=False), \
             patch("scripts.v3.word_layout.subprocess.run", return_value=Mock(stdout="DejaVu Sans\n/substitute.ttf")):
            with self.assertRaisesRegex(RuntimeError, "Verdana.*missing"):
                verdana_path()
        verdana_path.cache_clear()


    def test_long_project_narratives_flow_without_per_pair_page_breaks(self):
        projects = [{"name": "Project " + str(i), "client_line": "Client",
                     "description": ("Complete source narrative " * 120) + str(i),
                     "description_teaser": "Shortened teaser"} for i in range(8)]
        cv = {"first_name": "Test", "last_name": "Person", "selected_projects": projects}
        context = docx_render_context(cv, "landscape")
        pages = context["landscape_full_width_project_pages"]
        self.assertEqual(len(pages), 1)
        rows = pages[0]["project_rows"]
        rendered = [p for row in rows for lane in ("projects_left", "projects_right")
                    for p in row[lane]]
        self.assertEqual([p["name"] for p in rendered], [p["name"] for p in projects])
        self.assertTrue(all(p["description_teaser"] == p["description"] for p in rendered))
        self.assertEqual(cv["selected_projects"][0]["description_teaser"], "Shortened teaser")

    def test_opt_in_render_validation_runs_once_without_repacking(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "test.docx"
            context = {"selected_projects_remaining_landscape": [1]}
            probe = Mock(return_value=5)
            with patch("scripts.v3.render_docx_v3.docx_render_context", return_value=context), \
                 patch("scripts.v3.render_docx_v3.write_docx_from_context") as write:
                result, written = render_validated_landscape_context({}, path, path, page_count_probe=probe)
            self.assertTrue(written)
            self.assertEqual(result["landscape_rendered_page_count"], 5)
            probe.assert_called_once()
            write.assert_called_once()


    def test_portrait_starts_long_project_in_available_first_page_space(self):
        projects = [
            {"name": "Short first project", "client_line": "Client", "duration_line": "2024",
             "description": "Leading commissioning activities for this project."},
            {"name": "Long second project", "client_line": "Client", "duration_line": "2023",
             "description": "Verified source narrative. " * 160},
            {"name": "Next project", "description": "A distinct complete project narrative."},
        ]
        cv = {"first_name": "Test", "last_name": "Person", "selected_projects": projects}
        context = docx_render_context(cv, "portrait")
        featured = context["selected_projects_featured_portrait"]
        remaining = context["selected_projects_remaining_portrait"]
        self.assertEqual([p["name"] for p in featured], ["Short first project", "Long second project"])
        self.assertEqual([p["name"] for p in remaining], ["Next project"])
        self.assertEqual([p["description"] for p in featured + remaining],
                         [p["description"] for p in projects])
        self.assertTrue(context["portrait_right_lane_flows_to_page_two"])

    def test_portrait_uses_right_lane_beside_sidebar_continuation(self):
        cv = {"first_name": "Test", "last_name": "Person",
              "selected_projects": [
                  {"name": "Project " + str(i), "client_line": "Client", "duration_line": "2023",
                   "description": "Source commissioning narrative for the complete project. " * 24}
                  for i in range(12)]}
        short = docx_render_context(cv, "portrait")
        cv["memberships"] = [{"text": "Membership organisation and credential details. " * 6}
                             for _ in range(8)]
        long = docx_render_context(cv, "portrait")
        self.assertTrue(long["portrait_sidebar_flows_to_page_two"])
        self.assertGreater(len(long["selected_projects_featured_portrait"]),
                           len(short["selected_projects_featured_portrait"]))
        combined = long["selected_projects_featured_portrait"] + long["selected_projects_remaining_portrait"]
        self.assertEqual([p["name"] for p in combined], [p["name"] for p in cv["selected_projects"]])

    def test_portrait_does_not_strand_project_title_after_long_experience(self):
        cv = {"first_name": "Test", "last_name": "Person",
              "experience": [{"prefix": "2020 – Present:",
                              "body": "Engineering role, Long Organisation Name"} for _ in range(80)],
              "selected_projects": [{"name": "First project", "description": "Complete narrative."}]}
        context = docx_render_context(cv, "portrait")
        self.assertEqual(context["selected_projects_featured_portrait"], [])
        self.assertEqual(len(context["selected_projects_remaining_portrait"]), 1)

    def test_portrait_no_projects_keeps_no_continuation_section(self):
        context = docx_render_context({"first_name": "Test", "last_name": "Person"}, "portrait")
        self.assertEqual(context["selected_projects_featured_portrait"], [])
        self.assertFalse(context["selected_projects_next_page_section_portrait"])
