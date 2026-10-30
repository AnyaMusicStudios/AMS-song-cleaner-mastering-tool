/* ===========================================================================
   dsp.js — audio cleanup engine (no dependencies)
   Runs in a Web Worker (importScripts) or in Node (module.exports).

   Pipeline
     1. STFT analysis          Hann window, 75% overlap, radix-2 FFT
     2. Noise profile          mean power spectrum of the quietest N% of frames
     3. Spectral subtraction   per-bin gain, phase untouched
     4. Residual               original - cleaned  (what got removed)
     5. Master stage           rumble filter, air shelf, glue comp, -1 dBFS limiter
   =========================================================================== */
(function (global) {
  'use strict';

  /* ------------------------------- FFT ---------------------------------- */
  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const ang = -2 * Math.PI / len;
      const wr = Math.cos(ang), wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1, ci = 0;
        for (let k = 0; k < half; k++) {
          const a = i + k, b = a + half;
          const vr = re[b] * cr - im[b] * ci;
          const vi = re[b] * ci + im[b] * cr;
          const ur = re[a], ui = im[a];
          re[a] = ur + vr; im[a] = ui + vi;
          re[b] = ur - vr; im[b] = ui - vi;
          const ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = ncr;
        }
      }
    }
  }

  function ifft(re, im) {
    const n = re.length;
    for (let i = 0; i < n; i++) im[i] = -im[i];
    fft(re, im);
    const s = 1 / n;
    for (let i = 0; i < n; i++) { re[i] *= s; im[i] = -im[i] * s; }
  }

  /* --------------------- real-input FFT (2x faster) ----------------------
     A real signal of length N only needs a complex FFT of length N/2: pack the
     even samples into the real part, the odd samples into the imaginary part,
     then split. Verified sample-exact against the direct method in test/rfft.test.js
     ---------------------------------------------------------------------- */
  const twiddleCache = new Map();
  function twiddles(n) {
    let t = twiddleCache.get(n);
    if (!t) {
      t = new Float64Array(n * 2);
      for (let k = 0; k < n; k++) {
        const a = -2 * Math.PI * k / n;
        t[2 * k] = Math.cos(a);
        t[2 * k + 1] = Math.sin(a);
      }
      twiddleCache.set(n, t);
    }
    return t;
  }

  /** @returns {{re:Float64Array, im:Float64Array}} bins 0..N/2 */
  function rfft(x, N, re, im, zr, zi) {
    const half = N >> 1;
    for (let i = 0; i < half; i++) { zr[i] = x[2 * i]; zi[i] = x[2 * i + 1]; }
    fft(zr.subarray(0, half), zi.subarray(0, half));
    const w = twiddles(N);
    for (let k = 0; k <= half; k++) {
      const kk = (half - k) % half;
      const k2 = k % half;            // the Nyquist bin reuses index 0
      const ar = zr[k2], ai = zi[k2];
      const br = zr[kk], bi = -zi[kk];
      const zer = (ar + br) / 2, zei = (ai + bi) / 2;
      const zor = (ai - bi) / 2, zoi = -(ar - br) / 2;
      const wr = w[2 * k], wi = w[2 * k + 1];
      const tr = zor * wr - zoi * wi;
      const ti = zor * wi + zoi * wr;
      re[k] = zer + tr;
      im[k] = zei + ti;
    }
    return { re, im };
  }

  /** inverse of rfft: bins 0..N/2 -> real signal of length N */
  function irfft(re, im, N, out, zr, zi) {
    const half = N >> 1;
    const w = twiddles(N);
    for (let k = 0; k < half; k++) {
      const kk = half - k;
      const ar = re[k], ai = im[k];
      const br = re[kk], bi = -im[kk];
      const zer = (ar + br) / 2, zei = (ai + bi) / 2;
      const dr = (ar - br) / 2, di = (ai - bi) / 2;
      // divide by W^k  ->  multiply by conj(W^k)
      const wr = w[2 * k], wi = -w[2 * k + 1];
      const zor = dr * wr - di * wi;
      const zoi = dr * wi + di * wr;
      zr[k] = zer - zoi;
      zi[k] = zei + zor;
    }
    ifft(zr.subarray(0, half), zi.subarray(0, half));
    for (let i = 0; i < half; i++) { out[2 * i] = zr[i]; out[2 * i + 1] = zi[i]; }
    return out;
  }

  /* ----------------------------- helpers -------------------------------- */
  function hann(n) {
    const w = new Float32Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / n);
    return w;
  }

  const dbToGain = (db) => Math.pow(10, db / 20);
  // log approximation is plenty for a displayed average (max error ~1e-5)
  const LOG_APPROX = (x) => Math.log(x + 1e-9);

  function rms(frame, off, n) {
    let s = 0;
    for (let i = 0; i < n; i++) { const v = frame[off + i]; s += v * v; }
    return Math.sqrt(s / n);
  }

  /* ------------------------- spectral subtraction ------------------------ */
  /**
   * @param {Float32Array} x        input channel
   * @param {object} o              settings
   * @param {function} [onTick]     progress callback 0..1
   * @returns {{clean:Float32Array, residual:Float32Array, stats:object}}
   */
  function cleanChannel(x, o, onTick) {
    const N = o.fftSize || 2048;
    const hop = N >> 2;
    const win = hann(N);
    const L = x.length;
    const pad = N;
    const padded = new Float32Array(L + 2 * pad);
    padded.set(x, pad);
    const total = padded.length;
    const frames = Math.max(1, Math.floor((total - N) / hop) + 1);
    const bins = N / 2 + 1;
    const tick = onTick || function () {};

    // ---- frame energies (cheap, time domain) -----------------------------
    const energy = new Float64Array(frames);
    for (let m = 0; m < frames; m++) energy[m] = rms(padded, m * hop, N);
    tick(0.02);

    const sorted = Float64Array.from(energy).sort();
    const pct = Math.min(60, Math.max(1, o.profilePct || 12)) / 100;
    let cut = Math.floor(frames * pct);
    cut = Math.max(8, Math.min(frames - 1, cut));
    const threshold = sorted[cut] + 1e-9;

    // ---- pass A: noise profile from the quiet frames ---------------------
    const profile = new Float64Array(bins);
    const re = new Float64Array(bins), im = new Float64Array(bins);
    const zr = new Float64Array(N / 2), zi = new Float64Array(N / 2);
    const frameBuf = new Float64Array(N);
    let used = 0;
    for (let m = 0; m < frames; m++) {
      if (energy[m] > threshold) continue;
      const off = m * hop;
      for (let i = 0; i < N; i++) frameBuf[i] = padded[off + i] * win[i];
      rfft(frameBuf, N, re, im, zr, zi);
      for (let k = 0; k < bins; k++) profile[k] += re[k] * re[k] + im[k] * im[k];
      used++;
    }
    if (used === 0) {
      for (let k = 0; k < bins; k++) profile[k] = 1e-12;
    } else {
      for (let k = 0; k < bins; k++) profile[k] /= used;
    }

    // smooth the profile across frequency (kills narrow musical-noise spikes)
    const sm = new Float64Array(bins);
    const R = 2;
    for (let k = 0; k < bins; k++) {
      let acc = 0, cnt = 0;
      for (let j = Math.max(0, k - R); j <= Math.min(bins - 1, k + R); j++) { acc += profile[j]; cnt++; }
      sm[k] = acc / cnt;
    }
    for (let k = 0; k < bins; k++) profile[k] = Math.max(sm[k], 1e-12);
    tick(0.2);

    // ---- pass B: subtract, overlap-add -----------------------------------
    const out = new Float32Array(total);
    const norm = new Float32Array(total);
    const floorGain = dbToGain(-Math.abs(o.maxReductionDb || 12)); // per-bin limit
    const alpha = 1 + (Math.min(100, Math.max(0, o.strength ?? 60)) / 100) * 2; // oversubtraction
    const smooth = Math.min(0.9, Math.max(0, o.temporalSmooth ?? 0.5));
    const prevGain = new Float64Array(bins).fill(1);
    const gain = new Float64Array(bins);
    let gainAccum = 0, gainFrames = 0;
    let maxGainDb = 0; // most aggressive single-bin cut seen

    for (let m = 0; m < frames; m++) {
      const off = m * hop;
      for (let i = 0; i < N; i++) frameBuf[i] = padded[off + i] * win[i];
      rfft(frameBuf, N, re, im, zr, zi);

      const g0 = floorGain * floorGain;
      for (let k = 0; k < bins; k++) {
        const p = re[k] * re[k] + im[k] * im[k];
        let g2 = 1 - alpha * (profile[k] / (p + 1e-20));
        if (g2 < g0) g2 = g0;
        if (g2 > 1) g2 = 1;
        let g = Math.sqrt(g2);
        g = smooth * prevGain[k] + (1 - smooth) * g;
        prevGain[k] = g;
        gain[k] = g;
      }

      // bins are stored 0..N/2 only; conjugate symmetry is implicit
      for (let k = 0; k < bins; k++) { re[k] *= gain[k]; im[k] *= gain[k]; }

      // statistics only need a sample of frames — this used to allocate an
      // array and call Math.log 1025x per frame, which dominated the hot loop
      if (energy[m] > threshold && (m & 7) === 0) {
        for (let k = 0; k < bins; k++) gainAccum += LOG_APPROX(gain[k]);
        gainFrames++;
        let worstGain = 1;
        for (let k = 1; k < Math.min(400, bins); k++) if (gain[k] < worstGain) worstGain = gain[k];
        const worst = -20 * Math.log10(worstGain + 1e-9);
        if (worst > maxGainDb) maxGainDb = worst;
      }

      irfft(re, im, N, frameBuf, zr, zi);
      for (let i = 0; i < N; i++) {
        const i0 = off + i;
        if (i0 >= total) break;
        const w = win[i];
        out[i0] += frameBuf[i] * w;
        norm[i0] += w * w;
      }
      if ((m & 31) === 0) tick(0.2 + 0.68 * (m / frames));
    }

    const clean = new Float32Array(L);
    for (let i = 0; i < L; i++) {
      const n = norm[i + pad];
      clean[i] = n > 1e-8 ? out[i + pad] / n : padded[i + pad];
    }

    const residual = new Float32Array(L);
    for (let i = 0; i < L; i++) residual[i] = x[i] - clean[i];

    const meanLogGain = gainFrames ? gainAccum / (gainFrames * bins) : 0;
    const avgGainDb = -(meanLogGain * 20) / Math.LN10;

    const stats = {
      profileFrames: used,
      totalFrames: frames,
      profilePct: Math.round((used / frames) * 100),
      avgReductionDb: Math.abs(avgGainDb),
      peakReductionDb: Math.min(maxGainDb, Math.abs(o.maxReductionDb || 12)),
    };
    tick(1);
    return { clean, residual, stats };
  }

  /* ------------------------------ mastering ------------------------------ */
  function highpass(x, sr, freq, q) {
    const w0 = 2 * Math.PI * freq / sr;
    const cos = Math.cos(w0), sin = Math.sin(w0);
    const a = sin / (2 * (q || 0.7071));
    const b0 = (1 + cos) / 2, b1 = -(1 + cos), b2 = (1 + cos) / 2;
    const a0 = 1 + a, a1 = -2 * cos, a2 = 1 - a;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const xn = x[i];
      const yn = (b0 * xn + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
      x2 = x1; x1 = xn; y2 = y1; y1 = yn;
      x[i] = yn;
    }
  }

  function highShelf(x, sr, freq, gainDb, s) {
    const A = Math.pow(10, gainDb / 40);
    const w0 = 2 * Math.PI * freq / sr;
    const cos = Math.cos(w0), sin = Math.sin(w0);
    const alpha = sin / 2 * Math.sqrt((A + 1 / A) * (1 / (s || 1) - 1) + 2);
    const beta = 2 * Math.sqrt(A) * alpha;
    const a0 = (A + 1) - (A - 1) * cos + beta;
    const b0 = A * ((A + 1) + (A - 1) * cos + beta);
    const b1 = -2 * A * ((A - 1) + (A + 1) * cos);
    const b2 = A * ((A + 1) + (A - 1) * cos - beta);
    const a1 = 2 * ((A - 1) - (A + 1) * cos);
    const a2 = (A + 1) - (A - 1) * cos - beta;
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) {
      const xn = x[i];
      const yn = (b0 * xn + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
      x2 = x1; x1 = xn; y2 = y1; y1 = yn;
      x[i] = yn;
    }
  }

  function compressor(chans, sr, o) {
    const n = chans[0].length;
    const thrDb = o.thresholdDb ?? -20;
    const ratio = Math.max(1, o.ratio ?? 2);
    const kneeDb = o.kneeDb ?? 6;
    const atk = Math.exp(-1 / (sr * 0.015));
    const rel = Math.exp(-1 / (sr * 0.18));
    let env = 0;
    const out = chans.map(() => new Float32Array(n));
    for (let i = 0; i < n; i++) {
      let peak = 0;
      for (let c = 0; c < chans.length; c++) {
        const v = Math.abs(chans[c][i]);
        if (v > peak) peak = v;
      }
      env = peak > env ? atk * env + (1 - atk) * peak : rel * env + (1 - rel) * peak;

      // static soft-knee curve, all in dB
      const inDb = 20 * Math.log10(Math.max(env, 1e-9));
      const over = inDb - thrDb;
      let gr = 0; // gain reduction in dB (positive)
      const slope = 1 - 1 / ratio;
      if (over > kneeDb / 2) {
        gr = over * slope;
      } else if (over > -kneeDb / 2) {
        const t = over + kneeDb / 2;
        gr = (t * t) / (2 * kneeDb) * slope;
      }
      const g = dbToGain(-gr);
      for (let c = 0; c < chans.length; c++) out[c][i] = chans[c][i] * g;
    }
    // makeup: bring peak back up a touch
    const makeup = dbToGain(o.makeupDb ?? 1.5);
    for (let c = 0; c < out.length; c++) {
      const ch = out[c];
      for (let i = 0; i < n; i++) ch[i] *= makeup;
    }
    return out;
  }

  function limiter(chans, sr, ceilingDb) {
    const n = chans[0].length;
    const target = dbToGain(ceilingDb ?? -1);
    const look = Math.max(1, Math.round(sr * 0.004));
    // sliding-window max of linked peaks
    const peaks = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let p = 0;
      for (let c = 0; c < chans.length; c++) {
        const v = Math.abs(chans[c][i]);
        if (v > p) p = v;
      }
      peaks[i] = p;
    }
    // monotonic deque for window max starting at i
    const dq = new Int32Array(n + 1);
    let head = 0, tail = 0;
    const wmax = new Float32Array(n);
    let j = 0;
    for (let i = 0; i < n; i++) {
      const end = Math.min(n - 1, i + look);
      while (j <= end) {
        while (tail > head && peaks[dq[tail - 1]] <= peaks[j]) tail--;
        dq[tail++] = j++;
      }
      while (dq[head] < i) head++;
      wmax[i] = peaks[dq[head]];
    }
    // gain envelope with instant attack / smooth release
    const rel = Math.exp(-1 / (sr * 0.05));
    let g = 1;
    const out = chans.map(() => new Float32Array(n));
    for (let i = 0; i < n; i++) {
      const need = wmax[i] > target ? target / wmax[i] : 1;
      g = need < g ? need : rel * g + (1 - rel) * need;
      for (let c = 0; c < chans.length; c++) {
        let v = chans[c][i] * g;
        // safety soft clip
        if (v > target || v < -target) {
          const s = v > 0 ? 1 : -1;
          v = s * target * Math.tanh(Math.abs(v) / target);
        }
        out[c][i] = v;
      }
    }
    return out;
  }

  function master(chans, sr, o) {
    const out = chans.map((c) => Float32Array.from(c));
    const hp = o.highPassHz ?? 28;
    if (hp > 0) for (const c of out) highpass(c, sr, hp, 0.7071);
    if ((o.airDb ?? 0) !== 0) for (const c of out) highShelf(c, sr, 9000, o.airDb, 1);
    const compd = compressor(out, sr, {
      thresholdDb: o.thresholdDb ?? -20,
      ratio: o.ratio ?? 1.8,
      makeupDb: 0,
    });

    // auto gain into the ceiling (capped, so quiet material is not blown up)
    if (o.autoGain !== false) {
      const ceil = dbToGain(o.ceilingDb ?? -1);
      let peak = 0;
      for (const c of compd) {
        for (let i = 0; i < c.length; i++) {
          const a = Math.abs(c[i]);
          if (a > peak) peak = a;
        }
      }
      if (peak > 1e-6) {
        const needed = ceil / peak;
        const g = Math.min(needed, dbToGain(Math.max(0, o.maxBoostDb ?? 4)));
        if (g > 1) for (const c of compd) for (let i = 0; i < c.length; i++) c[i] *= g;
      }
    }
    return limiter(compd, sr, o.ceilingDb ?? -1);
  }

  /* ------------------------------ exports ------------------------------- */
  function peakEnvelope(chans, buckets) {
    const n = chans[0].length;
    const b = Math.max(1, Math.min(buckets || 900, n));
    const min = new Float32Array(b), max = new Float32Array(b);
    const step = n / b;
    for (let i = 0; i < b; i++) {
      const s = Math.floor(i * step), e = Math.min(n, Math.floor((i + 1) * step));
      let lo = 0, hi = 0;
      for (let c = 0; c < chans.length; c++) {
        const ch = chans[c];
        for (let j = s; j < e; j++) {
          const v = ch[j];
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
      }
      min[i] = lo; max[i] = hi;
    }
    return { min, max, buckets: b };
  }

  function measure(chans) {
    let peak = 0, sum = 0, count = 0, clipped = 0;
    for (const ch of chans) {
      for (let i = 0; i < ch.length; i++) {
        const a = Math.abs(ch[i]);
        if (a > peak) peak = a;
        if (a >= 0.9995) clipped++;
        sum += ch[i] * ch[i]; count++;
      }
    }
    const rmsV = Math.sqrt(sum / Math.max(1, count));
    return {
      peakDb: 20 * Math.log10(Math.max(peak, 1e-9)),
      rmsDb: 20 * Math.log10(Math.max(rmsV, 1e-9)),
      clipped,
    };
  }

  function encodeWav(chans, sampleRate, bits) {
    const ch = chans.length;
    const n = chans[0].length;
    const bytes = bits / 8;
    const dataLen = n * ch * bytes;
    const buf = new ArrayBuffer(44 + dataLen);
    const v = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); v.setUint32(4, 36 + dataLen, true); str(8, 'WAVE');
    str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
    v.setUint16(22, ch, true); v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * ch * bytes, true);
    v.setUint16(32, ch * bytes, true); v.setUint16(34, bits, true);
    str(36, 'data'); v.setUint32(40, dataLen, true);
    let o = 44;
    if (bits === 16) {
      for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
        let s = Math.max(-1, Math.min(1, chans[c][i]));
        v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
      }
    } else if (bits === 24) {
      for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
        let s = Math.max(-1, Math.min(1, chans[c][i]));
        let x = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
        if (x < 0) x += 0x1000000;
        v.setUint8(o, x & 0xff); v.setUint8(o + 1, (x >> 8) & 0xff); v.setUint8(o + 2, (x >> 16) & 0xff);
        o += 3;
      }
    } else {
      for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
        v.setFloat32(o, chans[c][i], true); o += 4;
      }
    }
    return buf;
  }

  const API = {
    fft, ifft, rfft, irfft, cleanChannel, master, peakEnvelope, measure, encodeWav, highpass, highShelf,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  global.DSP = API;
})(typeof self !== 'undefined' ? self : globalThis);
