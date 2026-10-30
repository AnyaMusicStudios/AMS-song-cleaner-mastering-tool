// Generates two test "AI-generated" sounding clips with hiss, as WAV files
const DSP = require('../src/dsp.js');
const fs = require('fs');
const SR = 44100;

function makeMusic(seconds, chordRoot) {
  const N = Math.floor(SR * seconds);
  const out = new Float32Array(N);
  let ph = 0;
  const prog = [0, 5, 3, 4].map(s => chordRoot * Math.pow(2, s / 12));
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const bar = Math.floor(t / 2) % prog.length;
    const root = prog[bar];
    const env = 0.55 + 0.45 * Math.sin(2 * Math.PI * 0.25 * t);
    let v = 0;
    for (const [m, a] of [[1, .3], [2, .12], [3, .06], [4, .03]]) v += a * Math.sin(2 * Math.PI * root * m * t);
    const mel = root * 2 * Math.pow(2, (Math.floor(t * 1.5) % 4) / 12);
    v += 0.13 * Math.sin(2 * Math.PI * mel * t + Math.sin(2 * Math.PI * 5 * t));
    // hats
    const beat = (t * 2) % 1;
    if (beat < 0.05) v += (Math.random() - 0.5) * 0.25 * (1 - beat / 0.05);
    v += 0.18 * Math.sin(2 * Math.PI * 55 * t); // bass
    out[i] = v * env * 0.55;
  }
  return out;
}
function addHiss(x, level) {
  const y = new Float32Array(x.length);
  let a = 0, b = 0;
  for (let i = 0; i < x.length; i++) {
    const w = Math.random() * 2 - 1;
    a = 0.72 * a + 0.28 * w;
    b = 0.93 * b + 0.07 * a;
    y[i] = x[i] + (a * 0.5 + b * 1.2) * level;
  }
  return y;
}
const a = addHiss(makeMusic(14, 220), 0.055);
const b = addHiss(makeMusic(9, 174.6), 0.09);
fs.writeFileSync('test/noisy-track-1.wav', Buffer.from(DSP.encodeWav([a, a.map((v, i) => v * 0.97)], SR, 16)));
fs.writeFileSync('test/noisy-track-2.wav', Buffer.from(DSP.encodeWav([b], SR, 16)));
console.log('wrote test wavs');
