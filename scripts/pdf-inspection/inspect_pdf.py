import fitz
import os

path = r"D:\destok\雅思写作最新答题纸.pdf"
print("File exists:", os.path.exists(path))
print("File size:", os.path.getsize(path))

doc = fitz.open(path)
print("Pages:", doc.page_count)
page = doc[0]
print("Page rect:", page.rect)
print("Page rotation:", page.rotation)

text = page.get_text()
print("Text length:", len(text))
print("Text preview:", repr(text[:300]))

# Also check blocks
blocks = page.get_text("blocks")
print("\nBlocks count:", len(blocks))
for b in blocks[:20]:
    print(f"  ({b[0]:.1f},{b[1]:.1f})-({b[2]:.1f},{b[3]:.1f}): {b[4][:60]!r}")

doc.close()
