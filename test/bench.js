// Where does the time go for a realistic 3-minute stereo file?
const DSP = require('../src/dsp.js');
const fs = require('fs');
const buf = fs.readFileSync('test/long-track.wav');
function readWav(b) {
  const v = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ch = v.getUint16(22, true), sr = v.getUint32(24, true);
  const dataLen = v.getUint32(40, true);
  const n = dataLen / (2 * ch);
  const out = Array.from({ length: ch }, () => new Float32Array(n));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { out[c][i] = v.getInt16(o, true) / 32768; o += 2; }
  return { chans: out, sr, ch, dur: n / sr };
}
const { chans, sr, ch, dur } = readWav(buf);
console.log(`file: ${dur.toFixed(1)}s · ${ch}ch · ${sr} Hz`);
const t0 = Date.now();
const cleaned = [];
for (const c of chans) cleaned.push(DSP.cleanChannel(c, { fftSize: 2048, profilePct: 12, strength: 60, maxReductionDb: 12, temporalSmooth: 0.5 }).clean);
console.log(`clean  ${Date.now() - t0} ms  (${(dur / ((Date.now() - t0) / 1000)).toFixed(1)}x realtime)`);
const t1 = Date.now();
const m = DSP.master(cleaned, sr, { highPassHz: 28, airDb: 2, thresholdDb: -20, ratio: 1.8, ceilingDb: -1, maxBoostDb: 4 });
console.log(`master ${Date.now() - t1} ms`);
const t2 = Date.now();
const wav = DSP.encodeWav(m, sr, 24);
console.log(`wav24  ${Date.now() - t2} ms → ${(wav.byteLength / 1048576).toFixed(1)} MB`);
const t3 = Date.now();
const peaks = DSP.peakEnvelope(m, 1400);
console.log(`peaks  ${Date.now() - t3} ms`);
