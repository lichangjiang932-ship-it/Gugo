import fitz
import os

path = r"D:\destok\雅思写作最新答题纸.pdf"
doc = fitz.open(path)
page = doc[0]

# Get drawings (lines, rectangles, etc.)
drawings = page.get_drawings()
print(f"Total drawings: {len(drawings)}")
# Show first 40 drawings
for i, d in enumerate(drawings[:60]):
    rect = d.get("rect", None)
    items = d.get("items", [])
    for item in items:
        kind = item[0]
        if kind == "l":  # line
            p1, p2 = item[1], item[2]
            print(f"  [{i}] line ({p1.x:.1f},{p1.y:.1f})->({p2.x:.1f},{p2.y:.1f})")
        elif kind == "re":  # rectangle
            r = item[1]
            print(f"  [{i}] rect ({r.x0:.1f},{r.y0:.1f})-({r.x1:.1f},{r.y1:.1f})")
        elif kind == "c":  # curve
            print(f"  [{i}] curve")

doc.close()
