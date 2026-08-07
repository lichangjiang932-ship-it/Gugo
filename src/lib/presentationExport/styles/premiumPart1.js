export const PREMIUM_STYLE_PART_1 = `
* { margin:0; padding:0; box-sizing:border-box; }
html,body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif;
  background:#0a0908;
}
.slide {
  width:1920px;
  height:1080px;
  position:relative;
  overflow:hidden;
  background:#F4EFE5;
}

/* \u2500\u2500 utilities \u2500\u2500 */
.grid-bg {
  position:absolute; inset:0;
  background-image:
    linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px);
  background-size:60px 60px;
  pointer-events:none;
}
.grid-bg-light {
  position:absolute; inset:0;
  background-image:
    linear-gradient(rgba(42,31,23,0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(42,31,23,0.04) 1px, transparent 1px);
  background-size:48px 48px;
  pointer-events:none;
}
.dot-texture {
  position:absolute; inset:0;
  background-image: radial-gradient(circle, rgba(255,255,255,0.06) 1px, transparent 1px);
  background-size:24px 24px;
  pointer-events:none;
}
.glow-ember {
  position:absolute;
  border-radius:50%;
  filter:blur(80px);
  opacity:0.35;
  pointer-events:none;
}
.glow-cyan {
  position:absolute;
  border-radius:50%;
  filter:blur(80px);
  opacity:0.25;
  pointer-events:none;
}
.accent-bar-v {
  position:absolute;
  left:0; top:0; bottom:0;
  width:6px;
  background: linear-gradient(180deg, #E86A3C 0%, #2E8FA3 100%);
}
.accent-bar-h {
  position:absolute;
  left:0; right:0;
  height:6px;
  background: linear-gradient(90deg, #E86A3C 0%, #2E8FA3 100%);
}
.corner-badge {
  position:absolute;
  top:40px; right:50px;
  font-size:14px;
  font-weight:600;
  letter-spacing:4px;
  text-transform:uppercase;
  color:#8A7B68;
  padding:8px 16px;
  border:1px solid rgba(138,123,104,0.3);
  border-radius:4px;
}

/* \u2500\u2500 Cover \u2500\u2500 */
.slide-cover {
  background: linear-gradient(160deg, #12100e 0%, #1a1712 35%, #0f0d0b 70%, #1a1510 100%);
  display:flex;
  flex-direction:column;
  align-items:center;
  justify-content:center;
}
.slide-cover .glow-ember {
  width:900px; height:900px;
  top:-300px; right:-250px;
  background: radial-gradient(circle, rgba(232,106,60,0.5) 0%, transparent 60%);
}
.slide-cover .glow-cyan {
  width:700px; height:700px;
  bottom:-250px; left:-200px;
  background: radial-gradient(circle, rgba(46,143,163,0.4) 0%, transparent 60%);
}
.cover-grid { opacity:0.4; }
.cover-wave {
  position:absolute;
  bottom:0; left:0; right:0;
  height:180px;
  background: linear-gradient(180deg, transparent 0%, rgba(232,106,60,0.08) 100%);
  clip-path: polygon(0% 60%, 15% 45%, 35% 55%, 55% 35%, 75% 50%, 100% 30%, 100% 100%, 0% 100%);
}
.cover-tag {
  font-size:16px;
  letter-spacing:12px;
  text-transform:uppercase;
  color:#E86A3C;
  margin-bottom:50px;
  font-weight:700;
  padding:10px 24px;
  border:2px solid rgba(232,106,60,0.4);
  border-radius:4px;
  background: rgba(232,106,60,0.08);
}
.cover-title {
  font-size:110px;
  font-weight:900;
  letter-spacing:-3px;
  line-height:1.05;
  max-width:1500px;
  text-align:center;
  color:#F4EFE5;
  text-shadow: 0 4px 30px rgba(0,0,0,0.4);
}
.cover-subtitle {
  font-size:34px;
  color:#b8a88a;
  margin-top:45px;
  max-width:1100px;
  text-align:center;
  line-height:1.5;
  font-weight:400;
}
.cover-date {
  font-size:18px;
  color:#7a6e5a;
  margin-top:70px;
  letter-spacing:6px;
  font-weight:500;
}
.cover-line-bottom {
  position:absolute;
  bottom:80px; left:50%; transform:translateX(-50%);
  width:80px; height:4px;
  background: linear-gradient(90deg, transparent 0%, #E86A3C 50%, transparent 100%);
  border-radius:2px;
}
.cover-decor-ring {
  position:absolute;
  width:300px; height:300px;
  top:60px; right:80px;
  border:2px solid rgba(232,106,60,0.15);
  border-radius:50%;
}
.cover-decor-ring::before {
  content:'';
  position:absolute;
  inset:30px;
  border:1px solid rgba(46,143,163,0.12);
  border-radius:50%;
}

/* \u2500\u2500 TOC \u2500\u2500 */
.slide-toc {
  background: linear-gradient(135deg, #F4EFE5 0%, #EAE2D2 100%);
  display:flex;
}
.toc-sidebar {
  width:480px;
  background: linear-gradient(180deg, #1e1913 0%, #15120f 100%);
  display:flex;
  flex-direction:column;
  justify-content:center;
  padding:100px 60px;
  position:relative;
}
.toc-sidebar .dot-texture { opacity:0.5; }
.toc-sidebar-title {
  font-size:64px;
  font-weight:900;
  color:#F4EFE5;
  line-height:1.1;
  letter-spacing:-1px;
}
.toc-sidebar-sub {
  font-size:20px;
  letter-spacing:8px;
  text-transform:uppercase;
  color:#8A7B68;
  margin-top:24px;
}
.toc-sidebar-line {
  width:80px; height:5px;
  background: linear-gradient(90deg, #E86A3C 0%, #c9552e 100%);
  margin-top:50px;
  border-radius:3px;
}
.toc-sidebar-ring {
  position:absolute;
  width:200px; height:200px;
  top:60px; right:-60px;
  border:2px solid rgba(232,106,60,0.15);
  border-radius:50%;
}
.toc-main {
  flex:1;
  padding:100px 100px 100px 120px;
  display:flex;
  flex-direction:column;
  justify-content:center;
}
.toc-item {
  display:flex;
  align-items:baseline;
  gap:28px;
  padding:32px 0;
  border-bottom:1px solid rgba(219,210,190,0.5);
}
.toc-item-num {
  font-size:22px;`

