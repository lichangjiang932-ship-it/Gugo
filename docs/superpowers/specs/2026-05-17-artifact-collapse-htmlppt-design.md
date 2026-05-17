# 2026-05-17 artifact collapse and htmlppt repair design

## Goal
Make generated office-style artifacts collapse into one compact card after completion, and make the `htmlppt` skill behave like a first-class artifact that can preview and export reliably.

## Current problem
- `ChatMessages` already renders explicit artifacts as a single compact card, but `htmlppt` is not recognized as explicit because `buildArtifactPreview()` only treats pptx/react/docx/xlsx as declared artifact types.
- As a result, `htmlppt` falls back to inferred HTML detection, keeps the full assistant body visible, and does not get the same stable artifact-card flow as other generated files.

## Design
1. Artifact recognition
   - Treat `artifactType: 'html'` and `skillId: 'htmlppt'` as explicit artifacts inside `buildArtifactPreview()`.
   - Explicit HTML artifacts should return `inferred: false`, enabling the existing compact-card path in `ChatMessages`.

2. Chat rendering
   - Reuse the existing explicit-artifact card behavior for pptx/docx/xlsx/html.
   - Keep default chat output compact: one file card after completion, no expanded body.
   - Preserve source access through the existing right preview pane source tab rather than expanding the message inline.

3. HTML PPT preview/export
   - Keep HTML preview in `RightPreviewPane` using the existing iframe renderer.
   - Keep HTML→PPTX export using `downloadHtmlDeckAsPptx()`; once `htmlppt` becomes explicit, users consistently reach that path from the artifact card.

## Error handling
- If HTML is malformed or missing, preview construction still returns null rather than showing a broken card.
- Export conversion errors continue to surface through the existing toast channel.

## Tests
- Add an artifact preview test proving `htmlppt` with `artifactType: 'html'` is explicit (`inferred: false`) and previewable.
- Add/adjust rendering-focused test coverage so explicit HTML artifacts follow the compact artifact path rather than the inferred path.

## Scope
In scope: artifact classification, compact display behavior, htmlppt preview/export reachability.
Out of scope: redesigning the right pane, rewriting the HTML→PPTX converter, or changing the htmlppt prompt format.
