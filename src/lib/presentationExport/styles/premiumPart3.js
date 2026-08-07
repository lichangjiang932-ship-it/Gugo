export const PREMIUM_STYLE_PART_3 = `  font-size:17px;
  color:#C5B694;
}
.content-card {
  min-height:148px;
  border-radius:26px;
  padding:30px 34px;
  display:grid;
  grid-template-columns:64px 1fr;
  gap:20px;
  align-items:start;
  position:relative;
  overflow:hidden;
  background:rgba(255,255,255,.62);
  border:1px solid rgba(42,31,23,.08);
  box-shadow:0 18px 45px rgba(42,31,23,.08), inset 0 1px 0 rgba(255,255,255,.75);
  backdrop-filter:blur(14px);
}
.slide-content-dark .content-card {
  background:rgba(244,239,229,.055);
  border:1px solid rgba(244,239,229,.12);
  box-shadow:0 20px 55px rgba(0,0,0,.26), inset 0 1px 0 rgba(255,255,255,.08);
}
.content-card::after {
  content:'';
  position:absolute;
  left:0; right:0; top:0;
  height:4px;
  background:linear-gradient(90deg, #E86A3C 0%, #2E8FA3 100%);
  opacity:.82;
}
.content-card-index {
  width:54px; height:54px;
  border-radius:18px;
  display:flex;
  align-items:center;
  justify-content:center;
  font-weight:900;
  font-size:22px;
  color:#F4EFE5;
  background:linear-gradient(135deg, #E86A3C 0%, #2E8FA3 100%);
  box-shadow:0 12px 28px rgba(232,106,60,.22);
  font-variant-numeric:tabular-nums;
}
.content-card-text {
  font-size:28px;
  color:#33281f;
  line-height:1.42;
  font-weight:650;
  letter-spacing:-.2px;
}
.slide-content-dark .content-card-text {
  color:#F4EFE5;
}
.content-card-note {
  grid-column:2;
  margin-top:10px;
  font-size:18px;
  line-height:1.5;
  color:#7b6f5f;
}
.slide-content-dark .content-card-note {
  color:#A89B82;
}
.content-footer-line {
  position:absolute;
  bottom:50px; left:160px; right:160px;
  height:2px;
  background: linear-gradient(90deg, rgba(232,106,60,0.3) 0%, transparent 100%);
}
.slide-content-dark .content-footer-line {
  background:linear-gradient(90deg, rgba(232,106,60,.5), rgba(46,143,163,.18), transparent);
}

/* \u2500\u2500 Data \u2500\u2500 */
.slide-data {
  background: linear-gradient(180deg, #0f0d0b 0%, #1a1712 50%, #0f0d0b 100%);
  display:flex;
  flex-direction:column;
  padding:100px 140px;
  position:relative;
}
.slide-data .grid-bg { opacity:0.3; }
.data-glow-1 {
  position:absolute;
  width:800px; height:800px;
  top:-300px; right:-300px;
  border-radius:50%;
  background: radial-gradient(circle, rgba(232,106,60,0.2) 0%, transparent 55%);
  filter:blur(40px);
  pointer-events:none;
}
.data-glow-2 {
  position:absolute;
  width:600px; height:600px;
  bottom:-200px; left:-200px;
  border-radius:50%;
  background: radial-gradient(circle, rgba(46,143,163,0.15) 0%, transparent 55%);
  filter:blur(40px);
  pointer-events:none;
}
.data-tag {
  font-size:16px;
  letter-spacing:7px;
  text-transform:uppercase;
  color:#E86A3C;
  margin-bottom:20px;
  font-weight:700;
}
.data-title {
  font-size:64px;
  font-weight:900;
  color:#F4EFE5;
  line-height:1.15;
  letter-spacing:-1px;
}
.data-title-line {
  width:80px; height:5px;
  background: linear-gradient(90deg, #E86A3C 0%, #2E8FA3 100%);
  margin-top:28px;
  border-radius:3px;
}
.data-grid {
  display:flex;
  gap:40px;
  margin-top:70px;
}
.data-card {
  flex:1;
  background: rgba(244,239,229,0.04);
  border:1px solid rgba(244,239,229,0.1);
  border-radius:24px;
  padding:55px 35px;
  text-align:center;
  backdrop-filter:blur(16px);
  position:relative;
  box-shadow: 0 8px 32px rgba(0,0,0,0.2), inset 0 1px 0 rgba(255,255,255,0.05);
}
.data-card-glow {
  position:absolute;
  top:-1px; left:15%; right:15%;
  height:2px;
  background: linear-gradient(90deg, transparent 0%, #E86A3C 50%, transparent 100%);
  border-radius:2px;
}
.data-value {
  font-size:90px;
  font-weight:900;
  color:#E86A3C;
  line-height:1;
  letter-spacing:-2px;
}
.data-unit {
  font-size:44px;
  font-weight:700;
}
.data-label {
  font-size:24px;
  color:#a89b82;
  margin-top:24px;
  line-height:1.5;
}
.data-card-line {
  width:50px; height:3px;
  background: linear-gradient(90deg, #E86A3C 0%, #2E8FA3 100%);
  margin:35px auto 0;
  border-radius:2px;
}

/* \u2500\u2500 Quote \u2500\u2500 */
.slide-quote {
  background: linear-gradient(135deg, #15120f 0%, #1e1913 50%, #15120f 100%);
  display:flex;
  flex-direction:column;
  align-items:center;
  justify-content:center;
  padding:160px;
  position:relative;
}
.slide-quote .dot-texture { opacity:0.4; }
.quote-glow {
  position:absolute;
  width:600px; height:600px;
  top:-200px; left:-200px;
  border-radius:50%;
  background: radial-gradient(circle, rgba(46,143,163,0.2) 0%, transparent 55%);
  filter:blur(50px);
  pointer-events:none;
}
.quote-mark-svg {
  font-size:220px;
  font-weight:900;
  color:rgba(232,106,60,0.15);
  line-height:0.4;
  margin-bottom:20px;
  font-family: Georgia, serif;
}
.quote-text {
  font-size:52px;
  font-style:italic;
  line-height:1.55;
  max-width:1400px;
  text-align:center;
  color:#F4EFE5;
  font-weight:500;
}
.quote-line {
  width:80px; height:4px;
  background: linear-gradient(90deg, #E86A3C 0%, #2E8FA3 100%);
  margin:50px auto;
  border-radius:2px;
}
.quote-source {
  font-size:26px;
  color:#8a7d68;
}

/* \u2500\u2500 Split \u2500\u2500 */
.slide-split {
  background:#F4EFE5;`

