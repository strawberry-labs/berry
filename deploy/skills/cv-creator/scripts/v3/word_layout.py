"""Deterministic Word typography shared by template maintenance and pagination."""
from functools import lru_cache
from pathlib import Path
import subprocess
import zipfile

from lxml import etree
from PIL import ImageFont

W = "{http://schemas.openxmlformats.org/wordprocessingml/2006/main}"
NS = {"w": W[1:-1]}
PROJECT_BEFORE_DXA = 120  # 6pt between metadata and narrative
PROJECT_AFTER_DXA = 240   # 12pt between projects
EXPERIENCE_MIN_TAB_DXA = 1523  # Back-office portrait reference
EXPERIENCE_TAB_CLEARANCE_DXA = 20  # 1pt tolerance for Word glyph metrics


@lru_cache(maxsize=2)
def verdana_path(bold=False):
    """Find real Verdana, including the AESG managed Linux image's font folder."""
    filename = "Verdana Bold.ttf" if bold else "Verdana.ttf"
    candidates = [
        Path("/System/Library/Fonts/Supplemental") / filename,
        Path("/Library/Fonts") / filename,
        Path("C:/Windows/Fonts") / ("verdanab.ttf" if bold else "verdana.ttf"),
    ]
    for folder in ("/usr/local/share/fonts/aesg", "/usr/share/fonts/truetype/msttcorefonts"):
        base = Path(folder)
        if base.is_dir():
            candidates.extend(sorted(p for p in base.rglob("*")
                                     if p.suffix.lower() in (".ttf", ".otf")))
    for candidate in candidates:
        if candidate.is_file():
            face = ImageFont.truetype(str(candidate), size=90)
            family, style = face.getname()
            if family.casefold() == "verdana" and (
                ("bold" in style.casefold()) == bold
            ) and "italic" not in style.casefold():
                return candidate
    try:
        result = subprocess.run(
            ["fc-match", "-f", "%{family}\n%{file}",
             "Verdana:style=" + ("Bold" if bold else "Regular")],
            capture_output=True, text=True, check=True, timeout=5,
        ).stdout.splitlines()
        if len(result) >= 2 and "verdana" in result[0].casefold():
            candidate = Path(result[1])
            face = ImageFont.truetype(str(candidate), size=90)
            family, style = face.getname()
            if family.casefold() == "verdana" and (
                ("bold" in style.casefold()) == bold
            ) and "italic" not in style.casefold():
                return candidate
    except (OSError, subprocess.SubprocessError):
        pass
    raise RuntimeError(
        "Verdana " + ("Bold" if bold else "Regular") +
        " is missing. The AESG runtime must provide Verdana; substituting a font "
        "would misalign experience and invalidate Word pagination."
    )


def experience_tab_dxa(width_points):
    import math
    return max(EXPERIENCE_MIN_TAB_DXA,
               math.ceil(width_points * 20) + EXPERIENCE_TAB_CLEARANCE_DXA)


def _prop(parent, tag, **attrs):
    element = parent.find(W + tag)
    if element is None:
        element = etree.SubElement(parent, W + tag)
    for key, value in attrs.items():
        element.set(W + key, str(value))
    return element


# CT_PPr order matters to Word even if permissive readers accept other orders.
PPR_ORDER = ("pStyle", "keepNext", "keepLines", "pageBreakBefore", "framePr",
             "widowControl", "numPr", "suppressLineNumbers", "pBdr", "shd",
             "tabs", "suppressAutoHyphens", "kinsoku", "wordWrap", "overflowPunct",
             "topLinePunct", "autoSpaceDE", "autoSpaceDN", "bidi", "adjustRightInd",
             "snapToGrid", "spacing", "ind", "contextualSpacing", "mirrorIndents",
             "suppressOverlap", "jc", "textDirection", "textAlignment",
             "textboxTightWrap", "outlineLvl", "divId", "cnfStyle", "rPr",
             "sectPr", "pPrChange")


def order_ppr(p_pr):
    order = {W + name: index for index, name in enumerate(PPR_ORDER)}
    p_pr[:] = sorted(p_pr, key=lambda element: order.get(element.tag, 100))


def normalize_project_template(path):
    """Apply the reference paragraph rhythm to retained Jinja DOCX templates.

    This is a maintenance step, not a per-candidate generation or model task.
    Header/photo/media members remain byte-for-byte unchanged.
    """
    with zipfile.ZipFile(path) as source:
        members = [(item, source.read(item.filename)) for item in source.infolist()]
    payload = dict((item.filename, data) for item, data in members)
    document = etree.fromstring(payload["word/document.xml"])
    styles = etree.fromstring(payload["word/styles.xml"])
    roles = {"description": "AESGProjectDescription", "name": "AESGProjectTitle",
             "client_line": "AESGProjectMetadata", "duration_line": "AESGProjectMetadata"}
    for style_id in set(roles.values()):
        if not styles.xpath("./w:style[@w:styleId=$id]", namespaces=NS, id=style_id):
            style = etree.SubElement(styles, W + "style",
                                     {W + "type": "paragraph", W + "styleId": style_id})
            _prop(style, "name", val=style_id)
            _prop(style, "basedOn", val="AESGBodyCopy")
    descriptions = 0
    for paragraph in document.xpath(".//w:p", namespaces=NS):
        text = "".join(paragraph.xpath(".//w:t/text()", namespaces=NS))
        field = next((key for key in roles if "{{ project." + key in text), None)
        if field is None:
            if text.strip() == "SELECTED PROJECTS" and paragraph.getparent().tag == W + "body":
                p_pr = _prop(paragraph, "pPr")
                _prop(p_pr, "spacing", before=0)
                order_ppr(p_pr)
            continue
        is_body = field == "description"
        p_pr = _prop(paragraph, "pPr")
        paragraph.remove(p_pr)
        paragraph.insert(0, p_pr)
        _prop(p_pr, "pStyle", val=roles[field])
        _prop(p_pr, "jc", val="left")
        _prop(p_pr, "spacing", before=PROJECT_BEFORE_DXA if is_body else 0,
              after=PROJECT_AFTER_DXA if is_body else 0, line=240, lineRule="auto")
        _prop(p_pr, "keepNext", val=0 if is_body else 1)
        _prop(p_pr, "keepLines", val=0)
        _prop(p_pr, "widowControl", val=1)
        _prop(p_pr, "contextualSpacing", val=0)
        order_ppr(p_pr)
        if not is_body:
            continue
        descriptions += 1
        # Remove only the template's synthetic leading NBSP + line-break run.
        for run in list(paragraph.findall(W + "r")):
            run_text = "".join(run.xpath("./w:t/text()", namespaces=NS))
            if not run_text.strip() and run.find(W + "br") is not None:
                paragraph.remove(run)
        # Neutralize legacy spacer paragraphs so the one 12pt gap isn't doubled.
        spacer = paragraph.getnext()
        if spacer is not None and spacer.tag == W + "p" and not "".join(
            spacer.xpath(".//w:t/text()", namespaces=NS)).strip():
            spacer_pr = _prop(spacer, "pPr")
            _prop(spacer_pr, "spacing", before=0, after=0, line=1, lineRule="exact")
            _prop(spacer_pr, "keepNext", val=0)
            _prop(spacer_pr, "keepLines", val=0)
            order_ppr(spacer_pr)
        # Long narrative rows must be allowed to flow across a page boundary.
        for row in paragraph.iterancestors(W + "tr"):
            for flag in row.findall(W + "trPr/" + W + "cantSplit"):
                flag.getparent().remove(flag)
    if not descriptions:
        raise ValueError("No project template paragraphs found: " + str(path))
    patched = {
        "word/document.xml": etree.tostring(document, xml_declaration=True, encoding="UTF-8", standalone=True),
        "word/styles.xml": etree.tostring(styles, xml_declaration=True, encoding="UTF-8", standalone=True),
    }
    temporary = Path(path).with_suffix(".layout.tmp.docx")
    with zipfile.ZipFile(temporary, "w", compression=zipfile.ZIP_DEFLATED) as dest:
        for item, data in members:
            dest.writestr(item, patched.get(item.filename, data))
    temporary.replace(path)
    return descriptions


if __name__ == "__main__":
    import sys
    for filename in sys.argv[1:]:
        path = Path(filename)
        print(path.name, normalize_project_template(path), "project prototypes updated")
