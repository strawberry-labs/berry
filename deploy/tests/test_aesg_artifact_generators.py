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


if __name__ == "__main__":
    unittest.main()
