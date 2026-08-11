import fitz
import os

path = r"D:\destok\雅思写作最新答题纸.pdf"
doc = fitz.open(path)
page = doc[0]

# Get detailed text with positions
blocks = page.get_text("dict")["blocks"]
for block in blocks:
    if "lines" in block:
        for line in block["lines"]:
            for span in line["spans"]:
                txt = span["text"].strip()
                if txt:
                    bbox = span["bbox"]
                    print(f"  [{bbox[0]:.1f},{bbox[1]:.1f},{bbox[2]:.1f},{bbox[3]:.1f}] size={span['size']:.1f} font={span['font']}: {txt!r}")

# Check for form fields
print("\n--- Form Fields ---")
print("Widget count:", len(list(page.widgets()) if page.widgets() else []))

# Check annotations
annots = list(page.annots()) if page.annots() else []
print("Annotations count:", len(annots))

doc.close()
