"""Regenerates every test PDF in this folder (needs: reportlab, pillow, pypdf, poppler's pdftoppm).
   python3 make_fixtures.py
"""
import json, os, random, subprocess, tempfile
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.pdfgen import canvas
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Paragraph, Spacer, PageBreak
from reportlab.lib.styles import getSampleStyleSheet
from PIL import Image, ImageFilter
from pypdf import PdfReader, PdfWriter

HERE = os.path.dirname(os.path.abspath(__file__))
KEY = dict(enumerate("ACBDABDCABCDBADCBACD", start=1))   # ground truth for a 20-question exam
W, H = A4
rnd = random.Random(7)

def out(name): return os.path.join(HERE, name)

def lines_pdf(name, lines, title="Physics Quiz 1 - Answer Key", size=13):
    c = canvas.Canvas(out(name), pagesize=A4)
    c.setFont("Helvetica-Bold", 16); c.drawString(60, H - 70, title)
    c.setFont("Helvetica", size); y = H - 110
    for ln in lines:
        c.drawString(60, y, ln); y -= size * 1.7
    c.drawString(60, 40, "Page 1 of 1"); c.save()

# 1) every format in one document
fmt = ["1. A", "2) c", "3. B, 4. D, 5. A", "Q6: B", "Q7: D", "Question 8 - Answer: C", "Question 9 \u2013 Answer: A",
       "10 - B", "11 | C", "12 = D"]
c = canvas.Canvas(out("key_text_formats.pdf"), pagesize=A4)
c.setFont("Helvetica-Bold", 16); c.drawString(60, H - 70, "Physics Quiz 1 - Answer Key (mixed formats)")
c.setFont("Helvetica", 13); y = H - 110
for ln in fmt: c.drawString(60, y, ln); y -= 22
# a real table (separate text cells), questions 13-16
rows = [["Q No", "Answer"]] + [[str(i), KEY[i]] for i in range(13, 17)]
t = Table(rows, colWidths=[70, 70]); t.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.black)]))
tw, th = t.wrapOn(c, W, H); t.drawOn(c, 60, y - th - 10); y -= th + 40
# grid layout, questions 17-20
cols = [60, 120, 180, 240, 300]
c.drawString(cols[0], y, "Q.No"); [c.drawString(cols[k + 1], y, str(17 + k)) for k in range(4)]
y -= 20
c.drawString(cols[0], y, "Ans"); [c.drawString(cols[k + 1], y, KEY[17 + k]) for k in range(4)]
c.save()

# 2) clean two-column table over two pages
doc = SimpleDocTemplate(out("key_text_table.pdf"), pagesize=A4)
st = getSampleStyleSheet(); els = [Paragraph("Chemistry Midterm - Answer Key", st["Title"])]
for part in (range(1, 11), range(11, 21)):
    rows = [["Question", "Correct Answer"]] + [[str(i), KEY[i]] for i in part]
    tb = Table(rows, colWidths=[120, 120]); tb.setStyle(TableStyle([("GRID", (0, 0), (-1, -1), 0.5, colors.grey), ("BACKGROUND", (0, 0), (-1, 0), colors.lightgrey)]))
    els += [tb, PageBreak() if part.start == 1 else Spacer(1, 1)]
doc.build(els)

# 3) missing answers: 5, 9, 14 are not in the key
lines_pdf("key_text_missing.pdf", [f"{i}. {KEY[i]}" for i in range(1, 21) if i not in (5, 9, 14)])
# 4) duplicate question numbers: Q3 twice (same answer), Q7 twice (conflicting)
dup = [f"{i}. {KEY[i]}" for i in range(1, 21)]; dup.insert(3, "3. B"); dup.insert(8, "7. A")
lines_pdf("key_text_duplicates.pdf", dup)
# 5) invalid letters: Q4 G, Q8 AB, Q12 A/C, Q15 Z
bad = {4: "G", 8: "AB", 12: "A/C", 15: "Z"}
lines_pdf("key_text_invalid.pdf", [f"{i}. {bad.get(i, KEY[i])}" for i in range(1, 21)])

# 6) scanned (image-only) key: rasterise, degrade like a scan, rebuild a PDF that contains ONLY pictures
def scan(src_lines, name, rotate=0.6):
    tmp = tempfile.mkdtemp(); src = os.path.join(tmp, "src.pdf")
    c = canvas.Canvas(src, pagesize=A4); c.setFont("Helvetica-Bold", 20); c.drawString(60, H - 80, "Biology Final - Answer Key")
    c.setFont("Helvetica", 18); y = H - 140
    half = (len(src_lines) + 1) // 2
    for k, ln in enumerate(src_lines[:half]):
        c.drawString(70, y - k * 40, ln)
    for k, ln in enumerate(src_lines[half:]):
        c.drawString(330, y - k * 40, ln)
    c.save()
    subprocess.run(["pdftoppm", "-r", "170", "-png", src, os.path.join(tmp, "pg")], check=True)
    img = Image.open([os.path.join(tmp, f) for f in os.listdir(tmp) if f.endswith(".png")][0]).convert("L")
    img = img.rotate(rotate, resample=Image.BICUBIC, fillcolor=255).filter(ImageFilter.GaussianBlur(0.7))
    px = img.load()
    for _ in range(img.width * img.height // 120):          # speckle noise
        px[rnd.randrange(img.width), rnd.randrange(img.height)] = rnd.randrange(120, 255)
    jpg = os.path.join(tmp, "scan.jpg"); img.save(jpg, quality=70)
    return jpg

jpg = scan([f"{i}. {KEY[i]}" for i in range(1, 21)], "key_scanned.pdf")
c = canvas.Canvas(out("key_scanned.pdf"), pagesize=A4); c.drawImage(jpg, 0, 0, W, H); c.save()

# 7) mixed: page 1 real text (Q1-10), page 2 scanned picture (Q11-20)
jpg2 = scan([f"{i}. {KEY[i]}" for i in range(11, 21)], "x")
c = canvas.Canvas(out("key_mixed_text_and_scan.pdf"), pagesize=A4)
c.setFont("Helvetica", 14); y = H - 80
for i in range(1, 11): c.drawString(60, y, f"{i}. {KEY[i]}"); y -= 26
c.showPage(); c.drawImage(jpg2, 0, 0, W, H); c.save()

# 8) bad files
open(out("corrupt.pdf"), "wb").write(open(out("key_text_table.pdf"), "rb").read()[:700] + os.urandom(900))
open(out("not_a_pdf.pdf"), "w").write("This is just a text file renamed to .pdf\n1. A\n2. B\n")
open(out("empty.pdf"), "wb").close()
w = PdfWriter(); [w.add_page(p) for p in PdfReader(out("key_text_table.pdf")).pages]; w.encrypt("secret"); w.write(out("encrypted.pdf"))

json.dump({"key": KEY, "missing": [5, 9, 14], "duplicateSame": [3], "duplicateConflict": [7], "invalid": {k: v for k, v in bad.items()}},
          open(out("expected.json"), "w"), indent=1)
print("fixtures written:", sorted(f for f in os.listdir(HERE) if f.endswith((".pdf", ".json"))))
