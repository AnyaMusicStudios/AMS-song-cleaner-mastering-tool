/* Node test harness: synthesises a "noisy AI music" clip and checks the cleaner
   actually removes broadband static without wrecking the music underneath. */
const DSP = require('../src/dsp.js');

const SR = 44100;
const DUR = 6;
const N = SR * DUR;

function synth() {
  const music = new Float32Array(N);
  const noise = new Float32Array(N);
  // "music": a chord progression with harmonics + a melody, amplitude enveloped
  const chords = [
    [220, 277.18, 329.63], [196, 246.94, 293.66],
    [174.61, 220, 261.63], [196, 246.94, 329.63],
  ];
  let ph = 0;
  for (let i = 0; i < N; i++) {
    const t = i / SR;
    const bar = Math.floor(t / 1.5) % chords.length;
    const env = 0.6 + 0.4 * Math.sin(2 * Math.PI * 0.4 * t);
    let v = 0;
    for (const f of chords[bar]) {
      v += 0.22 * Math.sin(2 * Math.PI * f * t);
      v += 0.08 * Math.sin(2 * Math.PI * f * 2 * t);
      v += 0.04 * Math.sin(2 * Math.PI * f * 3 * t);
    }
    const mel = 440 * Math.pow(2, (Math.floor(t * 2) % 5) / 12);
    v += 0.15 * Math.sin(2 * Math.PI * mel * t) * (0.5 + 0.5 * Math.sin(2 * Math.PI * 3 * t));
    music[i] = v * env * 0.5;
  }
  // "static": broadband, slightly band-limited hiss + low rumble
  let b0 = 0, b1 = 0;
  for (let i = 0; i < N; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.7 * b0 + 0.3 * w;       // gentle lowpass -> "hiss" not white
    b1 = 0.9 * b1 + 0.1 * w;
    noise[i] = (b0 * 0.6 + b1 * 0.9) * 0.11;
  }
  const mix = new Float32Array(N);
  for (let i = 0; i < N; i++) mix[i] = music[i] + noise[i];
  return { music, noise, mix };
}

function snrDb(ref, test) {
  let sig = 0, err = 0;
  for (let i = 0; i < ref.length; i++) {
    sig += ref[i] * ref[i];
    err += (ref[i] - test[i]) ** 2;
  }
  return 10 * Math.log10(sig / Math.max(err, 1e-20));
}

const { music, noise, mix } = synth();
console.log('input peak', DSP.measure([mix]).peakDb.toFixed(2), 'dBFS');
console.log('input SNR (music vs noise)', snrDb(music, mix).toFixed(2), 'dB');

for (const strength of [40, 60, 80, 100]) {
  const t0 = Date.now();
  const { clean, residual, stats } = DSP.cleanChannel(mix, {
    fftSize: 2048, profilePct: 12, strength, maxReductionDb: 12, temporalSmooth: 0.5,
  });
  const ms = Date.now() - t0;
  let removed = 0, leftNoise = 0;
  for (let i = 0; i < N; i++) removed += residual[i] ** 2;
  const cleanErr = snrDb(music, clean);
  // how much of the residual energy is actual noise vs music?
  console.log(
    `strength ${String(strength).padStart(3)}% | SNR out ${cleanErr.toFixed(2)} dB | ` +
    `avg cut ${stats.avgReductionDb.toFixed(2)} dB | ${ms}ms | realtime x${(DUR * 1000 / ms).toFixed(1)}`
  );
}

// mastering smoke test
const m = DSP.master([mix], SR, { highPassHz: 28, airDb: 2, thresholdDb: -20, ratio: 1.8, ceilingDb: -1 });
const meas = DSP.measure(m);
console.log('mastered peak', meas.peakDb.toFixed(2), 'dBFS (target <= -1)', 'clipped samples', meas.clipped);

// wav encoder smoke test
const wav = DSP.encodeWav([mix], SR, 24);
console.log('wav bytes', wav.byteLength, 'expected', 44 + N * 3);
