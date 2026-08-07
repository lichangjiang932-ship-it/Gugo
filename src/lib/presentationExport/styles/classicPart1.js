export const CLASSIC_STYLE_PART_1 = `
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  font-family: 'Inter', system-ui, -apple-system, sans-serif;
  background: #EAE2D2;
  padding: 12px;
}
.slide {
  width: 100%;
  max-width: 880px;
  margin: 0 auto 12px;
  aspect-ratio: 16/9;
  position: relative;
  overflow: hidden;
  border-radius: 6px;
  box-shadow: 0 2px 10px rgba(42,31,23,0.08);
  background: #F4EFE5;
}
.slide-number {
  font-family: 'JetBrains Mono', monospace;
  font-size: 8px;
  color: #8A7B68;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  margin-bottom: 6px;
}

/* Cover */
.slide-cover {
  background: linear-gradient(135deg, #F4EFE5 0%, #EAE2D2 100%);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
}
.cover-top-bar {
  position: absolute;
  top: 0; left: 0; right: 0;
  height: 10px;
  background: #E86A3C;
}
.cover-circle {
  position: absolute;
  border-radius: 50%;
}
.cover-circle-1 {
  width: 72px; height: 72px;
  top: 14px; right: 14px;
  background: rgba(232,106,60,0.12);
}
.cover-circle-2 {
  width: 44px; height: 44px;
  bottom: 16px; left: 10px;
  background: rgba(46,143,163,0.12);
}
.cover-content {
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 20px;
}
.cover-title {
  font-size: 26px;
  font-weight: 700;
  color: #2A1F17;
  line-height: 1.2;
  max-width: 80%;
}
.cover-subtitle {
  font-size: 13px;
  color: #5E4F40;
}
.cover-date {
  font-size: 9px;
  color: #8A7B68;
}
.cover-bottom-line {
  position: absolute;
  bottom: 16px;
  width: 40px;
  height: 3px;
  background: #E86A3C;
  border-radius: 2px;
}

/* TOC */
.slide-toc {
  display: flex;
  background: #F4EFE5;
}
.toc-sidebar {
  width: 28%;
  background: #2E8FA3;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: white;
  padding: 14px;
}
.toc-title { font-size: 20px; font-weight: 700; }
.toc-subtitle { font-size: 8px; opacity: 0.7; margin-top: 3px; letter-spacing: 0.1em; }
.toc-main {
  flex: 1;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 8px;
}
.toc-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 6px;
  border-bottom: 1px solid #DBD2BE;
}
.toc-item:last-child { border-bottom: none; }
.toc-num {
  font-size: 16px;
  font-weight: 700;
  color: #E86A3C;
  min-width: 24px;
}
.toc-text {
  font-size: 12px;
  color: #2A1F17;
}

/* Content */
.slide-content { background: #F4EFE5; }
.content-bar {
  position: absolute;
  left: 0; top: 0; bottom: 0;
  width: 4px;
  background: #E86A3C;
}
.content-body {
  padding: 16px 20px 16px 24px;
  height: 100%;
  display: flex;
  flex-direction: column;
}
.content-title {
  font-size: 18px;
  font-weight: 600;
  color: #2A1F17;
  margin-top: 2px;
  line-height: 1.3;
}
.content-line {
  width: 24px;
  height: 2px;
  background: #E86A3C;
  margin-top: 6px;
  border-radius: 1px;
}
.content-bullets {
  list-style: none;
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  overflow: hidden;
}
.content-bullets li {
  font-size: 11px;
  color: #5E4F40;
  line-height: 1.45;
  display: flex;
  gap: 5px;
}
.content-bullets li::before {
  content: '\u2022';
  color: #E86A3C;
  flex-shrink: 0;
}
.content-bottom-line {
  position: absolute;
  bottom: 12px;
  left: 24px;
  right: 16px;
  height: 1px;
  background: #DBD2BE;
}

/* Image */
.slide-image {
  background: #F4EFE5;
  display: flex;
  flex-direction: column;
  padding: 14px 18px;
}
.image-header { margin-bottom: 6px; }
.image-title {
  font-size: 16px;
  font-weight: 600;
  color: #2A1F17;
  margin-top: 2px;
}
.image-line {
  width: 24px;
  height: 2px;
  background: #E86A3C;
  margin-top: 5px;
}
.image-body {
  flex: 1;
  display: flex;
  gap: 14px;
  overflow: hidden;
}
.image-bullets {
  flex: 1;
  list-style: none;
  display: flex;
  flex-direction: column;`

