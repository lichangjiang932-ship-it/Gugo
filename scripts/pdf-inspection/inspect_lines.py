import fitz

path = r"D:\destok\雅思写作最新答题纸.pdf"
doc = fitz.open(path)
page = doc[0]

drawings = page.get_drawings()

# Find horizontal lines (where p1.y == p2.y or close) with length > 30
print("=== Horizontal lines (potential underlines) ===")
for i, d in enumerate(drawings):
    items = d.get("items", [])
    for item in items:
        kind = item[0]
        if kind == "l":
            p1, p2 = item[1], item[2]
            if abs(p1.y - p2.y) < 1.5 and abs(p1.x - p2.x) > 30:
                print(f"  [{i}] y={p1.y:.1f} x={p1.x:.1f}->{p2.x:.1f} len={abs(p2.x-p1.x):.1f}")

# Also find vertical lines for the writing lines area
print("\n=== Key horizontal lines in header area (y < 200) ===")
for i, d in enumerate(drawings):
    items = d.get("items", [])
    for item in items:
        kind = item[0]
        if kind == "l":
            p1, p2 = item[1], item[2]
            if abs(p1.y - p2.y) < 1.5 and abs(p1.x - p2.x) > 50 and p1.y < 200:
                print(f"  [{i}] y={p1.y:.1f} x={p1.x:.1f}->{p2.x:.1f} len={abs(p2.x-p1.x):.1f}")

# Show lines in the writing area (y ~200 to y ~644)
print("\n=== Horizontal lines in writing area (200 < y < 650) ===")
for i, d in enumerate(drawings):
    items = d.get("items", [])
    for item in items:
        kind = item[0]
        if kind == "l":
            p1, p2 = item[1], item[2]
            if abs(p1.y - p2.y) < 1.5 and abs(p1.x - p2.x) > 200 and 200 < p1.y < 650:
                print(f"  [{i}] y={p1.y:.1f} x={p1.x:.1f}->{p2.x:.1f}")

doc.close()
