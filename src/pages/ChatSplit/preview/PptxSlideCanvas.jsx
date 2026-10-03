import { useId } from 'react'
import { pptxShadowFilterRegion } from '../../../lib/pptxPreviewShadow.js'

function TextBox({ text }) {
  if (!text) return null
  return <div xmlns="http://www.w3.org/1999/xhtml" style={{
    display: 'flex', flexDirection: 'column', justifyContent: text.valign,
    width: '100%', height: '100%', boxSizing: 'border-box', overflow: 'hidden',
    padding: text.insets.map((value) => `${value}px`).join(' '),
    whiteSpace: text.wrap ? 'pre-wrap' : 'pre', overflowWrap: text.wrap ? 'break-word' : 'normal',
  }}>
    {text.paragraphs.map((paragraph, index) => <p key={index} style={{ margin: 0, flexShrink: 0, ...paragraph.style }}>
      {paragraph.bullet && <span>{paragraph.bullet}{'\u00a0'}</span>}
      {paragraph.runs.map((run, runIndex) => <span key={runIndex} style={run.style}>{run.text}</span>)}
      {!paragraph.runs.length && '\u00a0'}
    </p>)}
  </div>
}

function Shape({ element, filter }) {
  const { w, h, fill, stroke, strokeWidth, shape, rounding } = element
  const paint = { fill, stroke, strokeWidth, filter, strokeDasharray: element.strokeDasharray,
    strokeLinecap: element.strokeLinecap, strokeLinejoin: element.strokeLinejoin }
  if (shape === 'ellipse') return <ellipse cx={w / 2} cy={h / 2} rx={w / 2} ry={h / 2} {...paint} />
  if (shape === 'line') return <line x1="0" y1="0" x2={w} y2={h} {...paint} />
  if (shape === 'triangle') return <polygon points={`${w / 2},0 ${w},${h} 0,${h}`} {...paint} />
  if (shape === 'rtTriangle') return <polygon points={`0,0 ${w},${h} 0,${h}`} {...paint} />
  if (shape === 'diamond') return <polygon points={`${w / 2},0 ${w},${h / 2} ${w / 2},${h} 0,${h / 2}`} {...paint} />
  return <rect width={w} height={h} rx={shape === 'roundRect' ? Math.min(w, h) * rounding : 0} {...paint} />
}

function SlideImage({ element }) {
  const { w, h, crop, src, opacity, alt } = element
  const imageWidth = w / (1 - crop.l - crop.r)
  const imageHeight = h / (1 - crop.t - crop.b)
  return <>
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} overflow="hidden">
      <image href={src} x={-crop.l * imageWidth} y={-crop.t * imageHeight}
        width={imageWidth} height={imageHeight} preserveAspectRatio="none" opacity={opacity}>
        {alt && <title>{alt}</title>}
      </image>
    </svg>
    {element.stroke !== 'none' && <rect width={w} height={h} fill="none" stroke={element.stroke} strokeWidth={element.strokeWidth} />}
  </>
}

function ShadowFilter({ element, id }) {
  const { shadow } = element
  if (!shadow) return null
  const region = pptxShadowFilterRegion(element)
  return <filter id={id} filterUnits="userSpaceOnUse" {...region} colorInterpolationFilters="sRGB">
    <feDropShadow dx={shadow.dx} dy={shadow.dy} stdDeviation={shadow.blur} floodColor={shadow.color} />
  </filter>
}

function SlideElement({ element, shadowId }) {
  const { x, y, w, h, rotation, flipH, flipV } = element
  const transform = `translate(${x} ${y}) rotate(${rotation} ${w / 2} ${h / 2}) translate(${flipH ? w : 0} ${flipV ? h : 0}) scale(${flipH ? -1 : 1} ${flipV ? -1 : 1})`
  const filter = element.shadow ? `url(#${shadowId})` : undefined
  return <g transform={transform} data-pptx-element={element.kind} data-pptx-shape={element.shape}>
    {element.kind === 'image' ? <g filter={filter}><SlideImage element={element} /></g> : <>
      <Shape element={element} filter={filter} />
      {element.text && <foreignObject width={w} height={h}><TextBox text={element.text} /></foreignObject>}
    </>}
  </g>
}

// Only bounded, parsed OOXML values enter this renderer. Text remains React
// content and raster images remain validated embedded data, never remote HTML.
export default function PptxSlideCanvas({ slide }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const { width, height, background, elements } = slide.layout
  const shadowId = (index) => `pptx-shadow-${id}-${index}`
  return <svg xmlns="http://www.w3.org/2000/svg" viewBox={`0 0 ${width} ${height}`}
    width="100%" role="img" aria-label={slide.title} data-testid="pptx-original-layout"
    className="block w-full overflow-hidden border border-ink/10 shadow-sm" style={{ aspectRatio: `${width} / ${height}` }}>
    <rect width={width} height={height} fill={background} />
    <defs>{elements.map((element, index) => element.shadow && <ShadowFilter key={index} element={element} id={shadowId(index)} />)}</defs>
    {elements.map((element, index) => <SlideElement key={index} element={element} shadowId={shadowId(index)} />)}
  </svg>
}
