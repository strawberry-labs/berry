import base64
import tempfile
import unittest
from pathlib import Path
from zipfile import ZipFile
from io import BytesIO
from PIL import Image
from lxml import etree
from scripts.v3.render_docx_v3 import repair_ooxml_identifiers
from scripts.extract_profile_photo import docx_image_pages

class CVPackageTests(unittest.TestCase):
    def test_repair_duplicate_ids_preserves_content(self):
        xml = b'''<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"><w:body><w:p w14:paraId="00000001" w14:textId="00000001"><w:r><w:t>First</w:t><wp:docPr id="1" name="photo"/></w:r></w:p><w:p w14:paraId="00000001" w14:textId="00000001"><w:r><w:t>Second</w:t><wp:docPr id="1" name="photo2"/></w:r></w:p></w:body></w:document>'''
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/"test.docx"
            with ZipFile(p,"w") as z:
                z.writestr("word/document.xml",xml)
                z.writestr("word/media/photo.jpg",b"preserved")
            repair_ooxml_identifiers(p)
            with ZipFile(p) as z:
                tree=etree.fromstring(z.read("word/document.xml"))
                self.assertEqual(z.read("word/media/photo.jpg"),b"preserved")
            self.assertEqual(list(tree.itertext()),["First","Second"])
            for attr in ("paraId","textId"):
                values=tree.xpath('//@*[local-name()="'+attr+'"]')
                self.assertEqual(len(values),len(set(values)))
            values=tree.xpath('//*[local-name()="docPr"]/@id')
            self.assertEqual(len(values),len(set(values)))

    def test_docx_keeps_background_and_portrait_candidates(self):
        with tempfile.TemporaryDirectory() as d:
            d=Path(d)
            p=d/"source.docx"
            with ZipFile(p,"w") as z:
                for name,size,color in [("background",(1649,2331),"white"),("portrait",(482,478),"gray"),("icon",(23,23),"black")]:
                    b=BytesIO()
                    Image.new("RGB",size,color).save(b,format="PNG")
                    z.writestr("word/media/"+name+".png",b.getvalue())
            pages=docx_image_pages(p,d)
            eligible=[i for i in pages[0]["images"] if min(i["width"],i["height"])>=240]
            self.assertEqual({i["name"] for i in eligible},{"background.png","portrait.png"})
            for item in eligible:
                self.assertTrue(base64.b64decode(item["base64"]))

if __name__=="__main__":
    unittest.main()
