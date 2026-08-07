export const CLASSIC_STYLE_PART_2 = `  gap: 5px;
  overflow: hidden;
}
.image-bullets li {
  font-size: 10px;
  color: #5E4F40;
  line-height: 1.35;
  display: flex;
  gap: 4px;
}
.image-bullets li::before {
  content: '\u2022';
  color: #E86A3C;
  flex-shrink: 0;
}
.image-placeholder {
  width: 32%;
  border: 1.5px dashed #C9BFA8;
  background: rgba(234,226,210,0.5);
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 9px;
  color: #8A7B68;
}

/* End */
.slide-end {
  background: linear-gradient(315deg, #F4EFE5 0%, #EAE2D2 100%);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
}
.end-bottom-bar {
  position: absolute;
  bottom: 0; left: 0; right: 0;
  height: 10px;
  background: #2E8FA3;
}
.end-circle {
  position: absolute;
  border-radius: 50%;
}
.end-circle-1 {
  width: 56px; height: 56px;
  top: 10px; left: 10px;
  background: rgba(46,143,163,0.12);
}
.end-circle-2 {
  width: 40px; height: 40px;
  bottom: 20px; right: 14px;
  background: rgba(232,106,60,0.12);
}
.end-content {
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 20px;
}
.end-title {
  font-size: 24px;
  font-weight: 700;
  color: #2A1F17;
}
.end-subtitle {
  font-size: 12px;
  color: #5E4F40;
}

/* Data */
.slide-data {
  background: #F4EFE5;
  display: flex;
  flex-direction: column;
  padding: 14px 18px;
}
.data-header {
  margin-bottom: 6px;
}
.data-title {
  font-size: 16px;
  font-weight: 600;
  color: #2A1F17;
}
.data-line {
  width: 24px;
  height: 2px;
  background: #E86A3C;
  margin-top: 5px;
}
.data-grid {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 8px 0;
}
.data-card {
  flex: 1;
  text-align: center;
  max-width: 180px;
}
.data-value {
  font-size: 28px;
  font-weight: 700;
  color: #E86A3C;
}
.data-label {
  font-size: 10px;
  color: #5E4F40;
  margin-top: 4px;
}
.data-card-line {
  width: 30px;
  height: 2px;
  background: #E86A3C;
  margin: 6px auto 0;
  border-radius: 1px;
}

/* Quote */
.slide-quote {
  background: linear-gradient(180deg, #F4EFE5 0%, #EAE2D2 100%);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
}
.quote-mark {
  font-size: 56px;
  font-weight: 700;
  color: #E86A3C;
  line-height: 1;
  position: absolute;
  top: 12px;
  left: 16px;
}
.quote-text {
  font-size: 18px;
  font-style: italic;
  color: #2A1F17;
  max-width: 80%;
  line-height: 1.5;
}
.quote-source {
  font-size: 11px;
  color: #8A7B68;
  margin-top: 10px;
}
.quote-bottom-line {
  position: absolute;
  bottom: 16px;
  width: 40px;
  height: 3px;
  background: #E86A3C;
  border-radius: 2px;
}

/* Split */
.slide-split {
  background: #F4EFE5;
  display: flex;
  flex-direction: column;
  padding: 14px 18px;
}
.split-header {
  margin-bottom: 6px;
}
.split-title {
  font-size: 16px;
  font-weight: 600;
  color: #2A1F17;
}
.split-line {
  width: 24px;
  height: 2px;
  background: #E86A3C;
  margin-top: 5px;
}
.split-body {
  flex: 1;
  display: flex;
  gap: 10px;
  overflow: hidden;
}
.split-col {
  flex: 1;
  background: #F8F4EC;
  border: 1px solid #DBD2BE;
  border-radius: 4px;
  padding: 10px;
  display: flex;
  flex-direction: column;
}
.split-col-title {
  font-size: 12px;
  font-weight: 700;
  margin-bottom: 6px;
}
.split-col-cyan { color: #2E8FA3; }
.split-col-ember { color: #E86A3C; }
.split-col-bullets {
  list-style: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow: hidden;
}
.split-col-bullets li {
  font-size: 10px;
  color: #5E4F40;
  line-height: 1.35;
  display: flex;`

