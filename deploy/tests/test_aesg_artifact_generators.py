from __future__ import annotations

import importlib.util
import tempfile
import unittest
from pathlib import Path

from docx import Document
from docx.oxml.ns import qn
from pptx import Presentation
from pptx.util import Inches


REPOSITORY = Path(__file__).resolve().parents[2]


def load_module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"unable to load {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


validator = load_module(
    "aesg_validate_artifact",
    REPOSITORY / "deploy/skills/aesg-branding/scripts/validate_artifact.py",
)
docx_generator = load_module(
    "aesg_create_docx",
    REPOSITORY / "deploy/skills/docx/scripts/create_aesg_docx.py",
)
docx_repair = load_module(
    "aesg_repair_docx",
    REPOSITORY / "deploy/skills/docx/scripts/repair_aesg_docx.py",
)


class ArtifactPlaceholderValidationTests(unittest.TestCase):
    def test_docx_placeholder_split_across_runs_is_detected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "split-placeholder.docx"
            document = Document()
            paragraph = document.add_paragraph()
            paragraph.add_run("Lorem")
            paragraph.add_run(" ipsum").bold = True
            document.save(path)

            text = validator.docx_story_text(path)

        self.assertIn("Lorem ipsum", text)
        self.assertIsNotNone(validator.PLACEHOLDER_RE.search(text))

    def test_pptx_placeholder_split_across_runs_is_detected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "split-placeholder.pptx"
            presentation = Presentation()
            slide = presentation.slides.add_slide(presentation.slide_layouts[6])
            text_frame = slide.shapes.add_textbox(
                Inches(1), Inches(1), Inches(4), Inches(1)
            ).text_frame
            text_frame.clear()
            paragraph = text_frame.paragraphs[0]
            paragraph.add_run().text = "Lorem"
            paragraph.add_run().text = " ipsum"
            presentation.save(path)
            slide_order = {
                str(item.part.partname).lstrip("/"): index
                for index, item in enumerate(presentation.slides, start=1)
            }

            text, _, _ = validator.inspect_pptx_slides(path, slide_order)

        self.assertIn("Lorem ipsum", text)
        self.assertIsNotNone(validator.PLACEHOLDER_RE.search(text))


class LetterheadGeometryTests(unittest.TestCase):
    def test_tables_fit_retained_letterhead_geometry_and_keep_type_size(self) -> None:
        template = (
            REPOSITORY
            / "deploy/skills/aesg-branding/assets/templates/AESG_Letterhead_Dubai.docx"
        )
        document = Document(template)
        docx_generator.create_letter(
            document,
            {
                "title": "Leave request",
                "recipient": ["People Team", "AESG"],
                "subject": "Annual leave request",
                "sections": [
                    {
                        "paragraphs": ["Please approve the requested leave dates."],
                        "callout": "Requested dates are subject to manager approval.",
                        "table": {
                            "headers": ["From", "To", "Working days"],
                            "widths": [2, 2, 1],
                            "rows": [["20 August 2026", "24 August 2026", "3"]],
                        },
                    }
                ],
                "signatory": "AESG employee",
            },
        )
        docx_generator.normalise_new_text(document)

        expected_content_width = 9_072
        self.assertEqual(docx_generator.usable_width_dxa(document), expected_content_width)
        self.assertEqual(len(document.tables), 2)
        for table in document.tables:
            properties = table._tbl.tblPr
            width = int(properties.find(qn("w:tblW")).get(qn("w:w")))
            indent = int(properties.find(qn("w:tblInd")).get(qn("w:w")))
            grid_width = sum(
                int(column.get(qn("w:w"))) for column in table._tbl.tblGrid
            )
            self.assertEqual(width, expected_content_width - docx_generator.CELL_MARGIN_DXA)
            self.assertEqual(grid_width, width)
            self.assertEqual(width + indent, expected_content_width)
            for row in table.rows:
                for cell in row.cells:
                    for paragraph in cell.paragraphs:
                        for run in paragraph.runs:
                            if not run.text:
                                continue
                            self.assertEqual(run.font.name, docx_generator.FONT)
                            self.assertAlmostEqual(
                                run.font.size.pt,
                                docx_generator.LETTER_BODY_PT,
                            )


class ReportStructureTests(unittest.TestCase):
    def setUp(self) -> None:
        self.template = (
            REPOSITORY
            / "deploy/skills/aesg-branding/assets/templates/AESG_General_Report_Template.docx"
        )

    def test_ordered_blocks_preserve_sequence_and_real_list_styles(self) -> None:
        document = Document(self.template)
        docx_generator.create_report(
            document,
            {
                "title": "Structure smoke test",
                "approvalPage": False,
                "sections": [
                    {
                        "heading": "Actions",
                        "blocks": [
                            {"type": "paragraph", "text": "Opening prose."},
                            {"type": "label", "text": "Recommendations:"},
                            {"type": "bullets", "items": ["First action", "Second action"]},
                            {"type": "paragraph", "text": "Closing prose."},
                        ],
                    }
                ],
            },
        )

        by_text = {paragraph.text: paragraph for paragraph in document.paragraphs}
        ordered = [
            next(
                index
                for index, paragraph in enumerate(document.paragraphs)
                if paragraph.text == text
            )
            for text in (
                "Opening prose.",
                "Recommendations:",
                "First action",
                "Second action",
                "Closing prose.",
            )
        ]
        self.assertEqual(ordered, sorted(ordered))
        self.assertEqual(by_text["First action"].style.name, "AESG Bullet")
        self.assertEqual(by_text["Second action"].style.name, "AESG Bullet")
        self.assertTrue(by_text["Recommendations:"].runs[0].bold)

    def test_monitoring_table_block_uses_a_landscape_section(self) -> None:
        document = Document(self.template)
        docx_generator.create_report(
            document,
            {
                "title": "Monitoring layout test",
                "approvalPage": False,
                "sections": [
                    {
                        "heading": "Monitoring summary",
                        "blocks": [
                            {
                                "type": "table",
                                "table": {
                                    "pattern": "monitoring",
                                    "headers": ["Location", "Reading", "Status"],
                                    "rows": [["North boundary", "42", "Compliant"]],
                                },
                            }
                        ],
                    }
                ],
            },
        )

        self.assertTrue(
            any(section.page_width > section.page_height for section in document.sections)
        )

    def test_repair_disables_template_numbering_for_manual_heading(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "manual-heading.docx"
            document = Document(self.template)
            docx_generator.create_report(
                document,
                {
                    "title": "Numbering smoke test",
                    "approvalPage": False,
                    "sections": [
                        {"heading": "2.1 Background", "level": 2},
                        {
                            "table": {
                                "headers": ["Requirement", "Gap", "RAG"],
                                "rows": [["Access control", "Upgrade required", "RED"]],
                            }
                        },
                    ],
                },
            )
            document.save(path)
            docx_repair.repair_report(path)
            repaired = Document(path)
            heading = next(
                paragraph
                for paragraph in repaired.paragraphs
                if paragraph.text == "2.1 Background"
            )
            numbering = heading._p.pPr.find(qn("w:numPr"))
            self.assertEqual(numbering.find(qn("w:numId")).get(qn("w:val")), "0")
            compliance = next(
                table
                for table in repaired.tables
                if table.rows and table.cell(0, 0).text == "Requirement"
            )
            self.assertEqual(compliance.cell(1, 2).text, "Red")

    def test_validator_rejects_flat_lists_and_manual_heading_numbering(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "flat-report.docx"
            document = Document(self.template)
            docx_generator.create_report(
                document,
                {
                    "title": "Validation smoke test",
                    "approvalPage": False,
                    "sections": [
                        {
                            "heading": "2.1 Background",
                            "level": 2,
                            "paragraphs": ["Examples:", "One", "Two", "Three"],
                        }
                    ],
                },
            )
            document.save(path)
            docx_generator.normalise_report_output_parts(path)
            errors: list[str] = []
            evidence: dict = {}
            validator.validate_docx(path, errors, evidence)

        self.assertTrue(any("inherit automatic numbering" in error for error in errors))
        self.assertTrue(any("flattened as body paragraphs" in error for error in errors))


class ReportWordFunctionalityTests(unittest.TestCase):
    """Headings, numbering, lists, and TOC must be native Word features."""

    def setUp(self) -> None:
        self.template = (
            REPOSITORY
            / "deploy/skills/aesg-branding/assets/templates/AESG_General_Report_Template.docx"
        )

    def build(self, sections: list[dict], **spec) -> Document:
        document = Document(self.template)
        docx_generator.create_report(
            document,
            {"title": "Word functionality test", "approvalPage": True, "sections": sections, **spec},
        )
        return document

    @staticmethod
    def num_id(paragraph) -> str | None:
        node = paragraph._p.find(f"{qn('w:pPr')}/{qn('w:numPr')}/{qn('w:numId')}")
        return node.get(qn("w:val")) if node is not None else None

    @staticmethod
    def ilvl(paragraph) -> str | None:
        node = paragraph._p.find(f"{qn('w:pPr')}/{qn('w:numPr')}/{qn('w:ilvl')}")
        return node.get(qn("w:val")) if node is not None else None

    def test_template_heading_contract_matches_reviewer_specification(self) -> None:
        document = Document(self.template)
        expected = {
            "Heading 1": (14, 14, 14),
            "Heading 2": (12, 12, 12),
            "Heading 3": (11, 11, 11),
        }
        for name, (size, before, after) in expected.items():
            style = document.styles[name]
            self.assertEqual(style.font.name, "Verdana")
            self.assertEqual(style.font.size.pt, size)
            self.assertEqual(style.paragraph_format.space_before.pt, before)
            self.assertEqual(style.paragraph_format.space_after.pt, after)
            indent = style.element.pPr.find(qn("w:ind"))
            self.assertEqual(indent.get(qn("w:left")), indent.get(qn("w:hanging")))
        numbering = document.part.numbering_part.element
        heading_num = document.styles["Heading 1"].element.pPr.find(qn("w:numPr"))
        num_id = heading_num.find(qn("w:numId")).get(qn("w:val"))
        abstract_id = next(
            num.find(qn("w:abstractNumId")).get(qn("w:val"))
            for num in numbering.findall(qn("w:num"))
            if num.get(qn("w:numId")) == num_id
        )
        abstract = next(
            node
            for node in numbering.findall(qn("w:abstractNum"))
            if node.get(qn("w:abstractNumId")) == abstract_id
        )
        texts = [lvl.find(qn("w:lvlText")).get(qn("w:val")) for lvl in abstract.findall(qn("w:lvl"))[:3]]
        self.assertEqual(texts, ["%1.", "%1.%2", "%1.%2.%3"])
        hanging = {
            lvl.find(f"{qn('w:pPr')}/{qn('w:ind')}").get(qn("w:hanging"))
            for lvl in abstract.findall(qn("w:lvl"))[:3]
        }
        self.assertEqual(len(hanging), 1)
        self.assertGreaterEqual(int(hanging.pop()), 1000)

    def test_headings_use_built_in_styles_with_automatic_numbering_and_toc(self) -> None:
        document = self.build(
            [
                {"heading": "Introduction", "blocks": [{"type": "paragraph", "text": "Opening."}]},
                {"heading": "Scope", "level": 2},
                {"heading": "Detail", "level": 3},
                {"heading": "Findings", "divider": True},
                {"heading": "Appendices", "headingNumbered": False},
            ]
        )
        headings = {
            paragraph.text: paragraph
            for paragraph in document.paragraphs
            if paragraph.style is not None and paragraph.style.name.startswith("Heading")
        }
        self.assertEqual(headings["Introduction"].style.name, "Heading 1")
        self.assertEqual(headings["Scope"].style.name, "Heading 2")
        self.assertEqual(headings["Detail"].style.name, "Heading 3")
        # Numbers come from the style's list, never from static text.
        self.assertIsNone(self.num_id(headings["Introduction"]))
        self.assertEqual(self.num_id(headings["Appendices"]), "0")
        instructions = "".join(document.element.xpath(".//w:instrText/text()"))
        self.assertIn('TOC \\o "1-3" \\h \\z \\u', instructions)
        self.assertEqual(instructions.count("PAGEREF _Toc"), 5)
        toc_entries = [paragraph for paragraph in document.paragraphs if paragraph.style.name.startswith("toc ")]
        self.assertEqual(
            [paragraph.text.split("\t")[0] for paragraph in toc_entries[:4]],
            ["1.", "1.1", "1.1.1", "2."],
        )
        divider = document.element.body.xpath('.//w:p[w:pPr/w:pStyle[@w:val="AESGDividerHeading"]]')
        self.assertTrue(divider)
        divider_text = "".join(divider[0].xpath(".//w:t/text()"))
        self.assertTrue(divider_text.startswith("2. Findings"), divider_text)

    def test_lists_are_restarted_multilevel_word_lists(self) -> None:
        document = self.build(
            [
                {
                    "heading": "Actions",
                    "blocks": [
                        {
                            "type": "bullets",
                            "items": [
                                "Alpha",
                                {"text": "Beta", "items": ["Roman", {"text": "Deeper", "items": ["Bullet"]}]},
                            ],
                        },
                        {"type": "numbered", "items": ["One", "Two"]},
                        {"type": "numbered", "items": ["Again"]},
                    ],
                }
            ]
        )
        by_text = {paragraph.text: paragraph for paragraph in document.paragraphs}
        self.assertEqual(
            [self.ilvl(by_text[text]) for text in ("Alpha", "Beta", "Roman", "Deeper", "Bullet")],
            ["0", "0", "1", "1", "2"],
        )
        self.assertEqual(by_text["Roman"].style.name, "AESG Bullet 2")
        self.assertEqual(by_text["Bullet"].style.name, "AESG Bullet 3")
        self.assertEqual(len({self.num_id(by_text[text]) for text in ("Alpha", "Roman", "Bullet")}), 1)
        self.assertNotEqual(self.num_id(by_text["One"]), self.num_id(by_text["Again"]))
        numbering = document.part.numbering_part.element
        restarted = next(
            num for num in numbering.findall(qn("w:num")) if num.get(qn("w:numId")) == self.num_id(by_text["Again"])
        )
        self.assertEqual(
            restarted.find(f"{qn('w:lvlOverride')}/{qn('w:startOverride')}").get(qn("w:val")),
            "1",
        )

    def test_generated_report_passes_word_structure_validation(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "structure.docx"
            spec_path = Path(directory) / "spec.json"
            spec_path.write_text(
                '{"kind": "report", "title": "Structure", "sections": ['
                '{"heading": "Introduction", "bullets": ["One", {"text": "Two", "items": ["Three"]}]},'
                '{"heading": "Scope", "level": 2}]}',
                encoding="utf-8",
            )
            import subprocess
            import sys

            subprocess.run(
                [
                    sys.executable,
                    str(REPOSITORY / "deploy/skills/docx/scripts/create_aesg_docx.py"),
                    "--spec",
                    str(spec_path),
                    "--branding-skill-dir",
                    str(REPOSITORY / "deploy/skills/aesg-branding"),
                    "--output",
                    str(path),
                    "--no-toc-pages",
                ],
                check=True,
                capture_output=True,
            )
            errors: list[str] = []
            evidence: dict = {}
            validator.validate_docx(path, errors, evidence)
            self.assertEqual(errors, [])
            self.assertTrue(evidence["reportWordStructure"]["tocField"])

    def test_validator_rejects_static_numbered_headings(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "static.docx"
            document = self.build([{"heading": "Introduction"}, {"heading": "Scope", "level": 2}])
            paragraph = document.add_paragraph("2. Static chapter")
            paragraph.runs[0].bold = True
            document.save(path)
            errors: list[str] = []
            validator.validate_report_structure(path, Document(path), errors, {})
            self.assertTrue(any("static numbered text" in error for error in errors), errors)

    def test_toc_page_lookup_handles_wrapped_divider_titles(self) -> None:
        headings = [{
            "text": "Findings and recommendations for integrated sustainability",
            "number": "2.",
            "bookmark": "_TocFindings",
            "divider": True,
        }]
        pages = [
            "Table of Contents\n2. Findings and recommendations ..........\n",
            "2. Findings and\nrecommendations for integrated\nsustainability\n",
            "2. Findings and recommendations for integrated\nsustainability\nBody text.\n",
        ]
        self.assertEqual(
            docx_generator.locate_heading_pages(pages, headings, "Table of Contents"),
            {"_TocFindings": 3},
        )

    def test_repair_adds_toc_and_fixes_legacy_divider_numbers(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "legacy.docx"
            document = self.build(
                [{"heading": "First"}, {"heading": "Second", "divider": True}],
                tableOfContents=False,
            )
            divider = document.element.body.xpath('.//w:p[w:pPr/w:pStyle[@w:val="AESGDividerHeading"]]')[0]
            for run in divider.xpath("./w:r"):
                if "".join(run.xpath("./w:t/text()")).strip() == "2.":
                    divider.remove(run)
            document.save(path)
            docx_repair.repair_report(path)
            self.assertTrue(docx_repair.add_missing_table_of_contents(path, paginate=False))
            repaired = Document(path)
            instructions = "".join(repaired.element.xpath(".//w:instrText/text()"))
            self.assertIn("TOC \\o", instructions)
            repaired_divider = repaired.element.body.xpath('.//w:p[w:pPr/w:pStyle[@w:val="AESGDividerHeading"]]')[0]
            self.assertTrue("".join(repaired_divider.xpath(".//w:t/text()")).startswith("2. Second"))


if __name__ == "__main__":
    unittest.main()
