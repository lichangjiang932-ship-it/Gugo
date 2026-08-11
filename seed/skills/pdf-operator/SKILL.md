---
name: pdf-operator
description: >
  Inspect, extract positioned page text from, or manipulate PDF files, including
  merge, split, rotate, CJK watermark/text overlays, and form filling. Use for
  PDF 阅读、中文水印、合并、拆分、旋转、改文字、填表单 and related PDF tasks.
---

# PDF Operator

1. Call `pdf_info` first to confirm page count, encryption status, metadata, and form fields.
2. Call `pdf_text` when page text or coordinates are needed. Its positioned items use PDF points with a bottom-left origin and can feed `overlay_text` directly. Text extraction is not a visual-layout check or OCR.
3. Use `pdf_transform` with one explicit operation. Preserve the input and leave `overwrite` false by default.
4. For page selections, use one-based page numbers and verify every requested page is in range.
5. Form filling remains interactive unless the user explicitly requests flattening. Signed PDFs must not be flattened or modified without an explicit warning because edits invalidate signatures.
6. Reopen each output with `pdf_info`. Verify page count, rotation, canonical form values, and generated form appearances. A successful write alone is not completion.
7. For a localized text correction, locate the text with `pdf_text`, then use `operation="overlay_text"` with a measured rectangle. It covers and redraws one line; it does not reflow the underlying PDF content. Watermarks, overlays, and text-field appearances support bundled CJK glyphs. Render affected pages and visually verify every result.
8. Arbitrary text reflow, OCR, PDF-to-Word, and Word-to-PDF are not lossless PDF operations. When `bash_exec` and LibreOffice are available, a best-effort office conversion may be scripted and must be visually verified; otherwise state the limitation instead of claiming fidelity.

The tools use authorized paths and PDF-specific limits, so large PDFs do not pass through the UTF-8 `read_file` payload.
