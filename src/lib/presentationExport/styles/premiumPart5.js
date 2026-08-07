export const PREMIUM_STYLE_PART_5 = `  box-shadow: 0 8px 30px rgba(0,0,0,0.2), inset 0 2px 4px rgba(255,255,255,0.2);
  position:relative;
}
.process-circle-ember { background: linear-gradient(135deg, #E86A3C 0%, #c9552e 100%); }
.process-circle-cyan { background: linear-gradient(135deg, #2E8FA3 0%, #236b7a 100%); }
.process-circle-ring {
  position:absolute;
  inset:-6px;
  border-radius:50%;
  border:2px solid rgba(255,255,255,0.15);
}
.process-name {
  font-size:30px;
  font-weight:800;
  color:#2A1F17;
}
.process-desc {
  font-size:22px;
  color:#5E4F40;
  margin-top:18px;
  line-height:1.5;
  max-width:300px;
}

/* \u2500\u2500 Image \u2500\u2500 */
.slide-image {
  background:#F4EFE5;
  display:flex;
  flex-direction:column;
  padding:100px 140px;
  position:relative;
}
.slide-image .grid-bg-light { opacity:0.5; }
.image-tag {
  font-size:16px;
  letter-spacing:7px;
  text-transform:uppercase;
  color:#E86A3C;
  margin-bottom:20px;
  font-weight:700;
}
.image-title {
  font-size:64px;
  font-weight:900;
  color:#2A1F17;
  line-height:1.15;
  letter-spacing:-1px;
}
.image-title-line {
  width:80px; height:5px;
  background: linear-gradient(90deg, #E86A3C 0%, #2E8FA3 100%);
  margin-top:28px;
  border-radius:3px;
}
.image-body {
  display:flex;
  gap:60px;
  margin-top:55px;
  flex:1;
  overflow:hidden;
}
.image-text { flex:1; }
.image-text ul { list-style:none; }
.image-text li {
  font-size:28px;
  color:#3d3328;
  line-height:1.6;
  padding:18px 0 18px 44px;
  position:relative;
  border-bottom:1px solid rgba(219,210,190,0.3);
}
.image-text li:last-child { border-bottom:none; }
.image-text li .bullet-diamond {
  position:absolute;
  left:0; top:26px;
  width:14px; height:14px;
  background: linear-gradient(135deg, #E86A3C 0%, #c9552e 100%);
  transform:rotate(45deg);
  border-radius:2px;
}
.image-placeholder {
  width:45%;
  background: linear-gradient(135deg, #EAE2D2 0%, #F4EFE5 100%);
  border:3px dashed rgba(201,191,168,0.6);
  border-radius:24px;
  display:flex;
  align-items:center;
  justify-content:center;
  font-size:26px;
  color:#8A7B68;
  position:relative;
  overflow:hidden;
}
.image-placeholder::before {
  content:'';
  position:absolute;
  inset:20px;
  border:2px dashed rgba(201,191,168,0.3);
  border-radius:16px;
}

/* \u2500\u2500 End \u2500\u2500 */
.slide-end {
  background: linear-gradient(160deg, #12100e 0%, #1a1712 35%, #0f0d0b 70%, #1a1510 100%);
  display:flex;
  flex-direction:column;
  align-items:center;
  justify-content:center;
  position:relative;
}
.slide-end .glow-cyan {
  width:900px; height:900px;
  top:-350px; left:-300px;
  background: radial-gradient(circle, rgba(46,143,163,0.5) 0%, transparent 55%);
}
.slide-end .glow-ember {
  width:700px; height:700px;
  bottom:-300px; right:-250px;
  background: radial-gradient(circle, rgba(232,106,60,0.4) 0%, transparent 55%);
}
.end-wave {
  position:absolute;
  top:0; left:0; right:0;
  height:180px;
  background: linear-gradient(0deg, transparent 0%, rgba(46,143,163,0.08) 100%);
  clip-path: polygon(0% 70%, 20% 50%, 40% 65%, 60% 45%, 80% 60%, 100% 40%, 100% 0%, 0% 0%);
}
.end-tag {
  font-size:18px;
  letter-spacing:10px;
  text-transform:uppercase;
  color:#2E8FA3;
  margin-bottom:45px;
  font-weight:700;
  padding:10px 24px;
  border:2px solid rgba(46,143,163,0.4);
  border-radius:4px;
  background: rgba(46,143,163,0.08);
}
.end-title {
  font-size:100px;
  font-weight:900;
  letter-spacing:6px;
  color:#F4EFE5;
  text-shadow: 0 4px 30px rgba(0,0,0,0.4);
}
.end-subtitle {
  font-size:32px;
  color:#b8a88a;
  margin-top:35px;
  max-width:1000px;
  text-align:center;
}
.end-line-bottom {
  position:absolute;
  bottom:80px; left:50%; transform:translateX(-50%);
  width:80px; height:4px;
  background: linear-gradient(90deg, transparent 0%, #2E8FA3 50%, transparent 100%);
  border-radius:2px;
}
.end-decor-ring {
  position:absolute;
  width:250px; height:250px;
  bottom:100px; left:80px;
  border:2px solid rgba(46,143,163,0.12);
  border-radius:50%;
}
.end-decor-ring::before {
  content:'';
  position:absolute;
  inset:25px;
  border:1px solid rgba(232,106,60,0.1);
  border-radius:50%;
}
`

