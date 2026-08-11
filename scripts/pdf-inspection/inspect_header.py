import fitz

path = r"D:\destok\雅思写作最新答题纸.pdf"
doc = fitz.open(path)
page = doc[0]

drawings = page.get_drawings()

# All lines in the header area (y < 210)
print("=== ALL drawings in header area (y < 210) ===")
for i, d in enumerate(drawings):
    items = d.get("items", [])
    for item in items:
        kind = item[0]
        if kind == "l":
            p1, p2 = item[1], item[2]
            if p1.y < 210 or p2.y < 210:
                is_h = abs(p1.y - p2.y) < 2
                print(f"  [{i}] {'H' if is_h else 'V'} ({p1.x:.1f},{p1.y:.1f})->({p2.x:.1f},{p2.y:.1f})")

# Check for the second page text blocks
print("\n=== Page 2 text blocks ===")
page2 = doc[1]
blocks = page2.get_text("blocks")
for b in blocks:
    print(f"  ({b[0]:.1f},{b[1]:.1f})-({b[2]:.1f},{b[3]:.1f}): {b[4][:50].strip()!r}")

doc.close()
