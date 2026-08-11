---
name: font-creator
description: >
  Create or modify a custom font from approved vector glyph outlines using
  Python fontTools or FontForge. Use when the user asks to design, build,
  subset, or validate a TTF/OTF/WOFF font or says 自定义字体/创造字体.
---

# Font Creator

This is a script workflow, not a built-in font editor. It requires `bash_exec`, an authorized read/write directory, and either FontForge or Python with fontTools.

1. Clarify the character set, style reference, license, family/style names, weight, units-per-em, and output formats. Never copy proprietary outlines without permission.
2. Inspect dependencies once (`fontforge --version` or `python -c "import fontTools"`). If missing, explain the exact dependency; do not repeatedly install packages.
3. Keep source outlines and a reproducible Python script under the authorized project. Declare every `.ttf`, `.otf`, `.woff`, and report path in `bash_exec.expected_outputs`.
4. Build consistent metrics, Unicode cmap entries, naming tables, OS/2 values, glyph bounds, and `.notdef`. Generate kerning only from approved pairs.
5. Validate with `fontTools.ttLib.TTFont`, `fontTools.subset`, and FontBakery when available. Reopen the final font, enumerate tables/glyphs, and render a specimen if the environment supports it.
6. Preserve editable sources. Never overwrite the only source font, and never claim a font is production-ready when validation reports errors.
