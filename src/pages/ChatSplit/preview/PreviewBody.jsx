import { DocxPreview, HtmlPreview, PptxPreview, SourceView, XlsxPreview } from './ArtifactRenderers.jsx'
import ReactArtifactPreview from './ReactArtifactPreview.jsx'

export default function PreviewBody({ preview, content, view }) {
  if (view === 'source') return <SourceView content={content}/>
  if (['html', 'html_multi', 'mermaid', 'chart', 'svg'].includes(preview.type)) return <HtmlPreview html={preview.html} previewType={preview.type}/>
  if (preview.type === 'pptx') return <PptxPreview content={content}/>
  if (preview.type === 'docx') return <DocxPreview blocks={preview.blocks} title={preview.title}/>
  if (preview.type === 'xlsx') return <XlsxPreview rows={preview.rows}/>
  if (preview.type === 'react') return <ReactArtifactPreview code={content}/>
  return <SourceView content={content}/>
}
