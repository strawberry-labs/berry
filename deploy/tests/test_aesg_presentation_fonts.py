"""Presentation text, including inherited slide numbers and bullets, uses Verdana (H-043).

Run: python3 -B -m unittest deploy/tests/test_aesg_presentation_fonts.py
"""

from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

REPOSITORY = Path(__file__).resolve().parents[2]
BRANDING = REPOSITORY / "deploy/skills/aesg-branding"
TEMPLATE = BRANDING / "assets/templates/AESG_General_Presentation.pptx"
GENERATOR = REPOSITORY / "deploy/skills/pptx/scripts/create_aesg_pptx.py"
ALLOWED = {"verdana", "symbol", "wingdings", "wingdings 2", "wingdings 3", "webdings", "marlett", "opensymbol"}
TYPEFACE_RE = re.compile(r'<a:(?:latin|ea|cs|buFont) typeface="([^"]*)"')
PART_RE = re.compile(r"ppt/(?:slides|slideLayouts|slideMasters|theme)/[^/]+\.xml")


def non_brand_typefaces(path: Path) -> dict[str, set[str]]:
    found: dict[str, set[str]] = {}
    with zipfile.ZipFile(path) as package:
        for name in package.namelist():
            if PART_RE.fullmatch(name):
                for typeface in TYPEFACE_RE.findall(package.read(name).decode("utf-8")):
                    if typeface and not typeface.startswith("+") and typeface.casefold() not in ALLOWED:
                        found.setdefault(name, set()).add(typeface)
    return found


def generate(directory: Path) -> Path:
    spec = {"title": "Font check", "slides": [
        {"layout": "text", "section": "Scope", "title": "Text", "body": "Body text."},
        {"layout": "two_columns", "section": "Scope", "title": "Columns", "columns": [
            {"title": "Left", "bullets": ["One", "Two"]}, {"title": "Right", "bullets": ["Three"]}]},
        {"layout": "statement", "title": "Statement", "body": "A statement."},
    ]}
    spec_path = directory / "spec.json"
    output = directory / "deck.pptx"
    spec_path.write_text(json.dumps(spec), encoding="utf-8")
    subprocess.run(
        [sys.executable, "-B", str(GENERATOR), "--spec", str(spec_path), "--output", str(output),
         "--branding-skill-dir", str(BRANDING)],
        check=True, capture_output=True, text=True,
    )
    return output


class PresentationFontTests(unittest.TestCase):
    def test_template_theme_and_explicit_fonts_are_verdana(self) -> None:
        with zipfile.ZipFile(TEMPLATE) as package:
            theme = package.read("ppt/theme/theme1.xml").decode("utf-8")
        self.assertRegex(theme, r'<a:majorFont>\s*<a:latin typeface="Verdana"')
        self.assertRegex(theme, r'<a:minorFont>\s*<a:latin typeface="Verdana"')
        self.assertEqual(non_brand_typefaces(TEMPLATE), {})

    def test_manifest_records_the_template_bytes(self) -> None:
        manifest = json.loads((BRANDING / "assets/template-manifest.json").read_text(encoding="utf-8"))
        entry = next(item for item in manifest["runtimeTemplates"] if item["path"] == "templates/AESG_General_Presentation.pptx")
        self.assertEqual(entry["sha256"], hashlib.sha256(TEMPLATE.read_bytes()).hexdigest())
        self.assertEqual(entry["bytes"], TEMPLATE.stat().st_size)

    def test_generated_bullets_name_verdana(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            deck = generate(Path(directory))
            self.assertEqual(non_brand_typefaces(deck), {})
            with zipfile.ZipFile(deck) as package:
                slides = [package.read(name).decode("utf-8") for name in package.namelist()
                          if re.fullmatch(r"ppt/slides/slide\d+\.xml", name)]
        bullets = sum(len(re.findall(r"<a:buChar ", xml)) for xml in slides)
        named = sum(len(re.findall(r'<a:buFont typeface="Verdana"/>\s*<a:buChar ', xml)) for xml in slides)
        self.assertEqual(bullets, 3)
        self.assertEqual(named, bullets)

    @unittest.skipUnless(shutil.which("soffice") and shutil.which("pdffonts"), "LibreOffice and pdffonts are needed")
    def test_rendered_deck_embeds_only_verdana(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            deck = generate(Path(directory))
            subprocess.run(["soffice", "--headless", "--convert-to", "pdf", "--outdir", directory, str(deck)],
                           check=True, capture_output=True)
            listing = subprocess.run(["pdffonts", str(Path(directory) / "deck.pdf")],
                                     check=True, capture_output=True, text=True).stdout
        fonts = {re.sub(r"^[A-Z]{6}\+", "", line.split()[0]) for line in listing.splitlines()[2:] if line.strip()}
        self.assertTrue(fonts)
        self.assertEqual({font for font in fonts if not font.startswith("Verdana")}, set())


if __name__ == "__main__":
    unittest.main()
