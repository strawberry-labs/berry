import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.text import WD_BREAK
from lxml import etree

from scripts.v3.render_docx_v3 import collapse_landscape_section_break_paragraph


W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
W = f"{{{W_NS}}}"
NS = {"w": W_NS}


class WordLandscapeSectionBreakTests(unittest.TestCase):
    def test_section_marker_is_collapsed_without_removing_page_break(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "landscape.docx"
            document = Document()
            document.add_paragraph("First-page content")
            document.add_section(WD_SECTION.CONTINUOUS)
            page_break = document.add_paragraph()
            page_break.add_run().add_break(WD_BREAK.PAGE)
            document.add_paragraph("Continuation content")
            document.save(path)

            collapse_landscape_section_break_paragraph(path)

            with ZipFile(path) as package:
                root = etree.fromstring(package.read("word/document.xml"))

            boundary = root.xpath(
                ".//w:body/w:p[w:pPr/w:sectPr]",
                namespaces=NS,
            )[0]
            properties = boundary.find(f"{W}pPr")
            child_names = [etree.QName(child).localname for child in properties]
            self.assertEqual(child_names, ["spacing", "rPr", "sectPr"])

            spacing = properties.find(f"{W}spacing")
            self.assertEqual(spacing.get(f"{W}before"), "0")
            self.assertEqual(spacing.get(f"{W}after"), "0")
            self.assertEqual(spacing.get(f"{W}line"), "1")
            self.assertEqual(spacing.get(f"{W}lineRule"), "exact")

            run_properties = properties.find(f"{W}rPr")
            self.assertEqual(
                run_properties.find(f"{W}sz").get(f"{W}val"),
                "2",
            )
            self.assertEqual(
                run_properties.find(f"{W}szCs").get(f"{W}val"),
                "2",
            )
            self.assertEqual(
                len(
                    root.xpath(
                        ".//w:body/w:p/w:r/w:br[@w:type='page']",
                        namespaces=NS,
                    )
                ),
                1,
            )


if __name__ == "__main__":
    unittest.main()
