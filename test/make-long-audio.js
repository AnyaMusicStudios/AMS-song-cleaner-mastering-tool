// 3-minute stereo 44.1 kHz noisy track, for timing/behaviour on realistic files
const DSP = require('../src/dsp.js');
const fs = require('fs');
const SR = 44100, DUR = 180, N = SR * DUR;
const L = new Float32Array(N), R = new Float32Array(N);
const prog = [220, 246.94, 196, 174.61];
for (let i = 0; i < N; i++) {
  const t = i / SR;
  const root = prog[Math.floor(t / 4) % 4];
  const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * 0.2 * t);
  let v = 0;
  for (const [m, a] of [[1, .28], [2, .11], [3, .05], [5, .02]]) v += a * Math.sin(2 * Math.PI * root * m * t);
  v += 0.12 * Math.sin(2 * Math.PI * root * 2 * Math.pow(2, (Math.floor(t * 1.5) % 4) / 12) * t);
  v += 0.16 * Math.sin(2 * Math.PI * 55 * t);
  const hiss = (Math.random() * 2 - 1) * 0.05;
  L[i] = v * env * 0.55 + hiss;
  R[i] = v * env * 0.53 + hiss * 0.95;
}
fs.writeFileSync('test/long-track.wav', Buffer.from(DSP.encodeWav([L, R], SR, 16)));
console.log('wrote test/long-track.wav —', (fs.statSync('test/long-track.wav').size / 1048576).toFixed(1), 'MB, 3:00 stereo');
