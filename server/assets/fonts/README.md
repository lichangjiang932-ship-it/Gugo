# Bundled PDF font

`NotoSansSC-Regular.ttf` is bundled so the PDF tools can draw and
embed Simplified Chinese and other Unicode text without depending on fonts
installed on the host operating system.

- Family: Noto Sans SC
- Upstream: https://github.com/google/fonts/tree/main/ofl/notosanssc
- Source file: `ofl/notosanssc/NotoSansSC[wght].ttf`
- Retrieved through the jsDelivr mirror of the upstream Google Fonts repository
- Static instance: generated at weight 400 with FontTools
  `varLib.instancer --static --update-name-table`; glyph outlines are otherwise
  unmodified and remain under the upstream OFL license
- License: SIL Open Font License 1.1 (`OFL.txt` in this directory)
- SHA-256: `D8435BDECC9A6FA97E856A99045B5D21F97AD77BD8CABA161CC33597E51DDF52`

The PDF implementation embeds a glyph subset rather than the full font where
the underlying PDF library permits it. Do not remove or rename this asset
without updating `server/adapters/pdfTools.js`.
