/* cleanup.worker.js — heavy lifting off the UI thread */
'use strict';
importScripts('dsp.js');
let lameReady = false;
try {
  if (typeof lamejs === 'undefined') importScripts('../vendor/lame.min.js');
  lameReady = typeof lamejs !== 'undefined';
} catch (e) {
  lameReady = false;
}

const DSP = self.DSP;

self.onmessage = async (e) => {
  const msg = e.data;
  try {
    if (msg.type === 'process') handleProcess(msg);
    else if (msg.type === 'master') handleMaster(msg);
    else if (msg.type === 'encode') handleEncode(msg);
  } catch (err) {
    self.postMessage({ type: 'error', id: msg.id, message: err && err.message ? err.message : String(err) });
  }
};

// Chunked transfer: keeps single postMessage payloads small so multi-minute
// files do not blow up structured-clone/transfer on mobile browsers.
const CHUNK_BYTES = 1 << 20; // 1 MB of samples per message

function sendChannelChunks(id, role, index, arr) {
  const per = Math.max(1, Math.floor(CHUNK_BYTES / 4)); // Float32 = 4 bytes
  const total = Math.ceil(arr.length / per);
  for (let i = 0; i < total; i++) {
    const slice = arr.subarray(i * per, Math.min(arr.length, (i + 1) * per));
    // subarray shares the buffer, so copy into its own buffer for transfer
    const copy = new Float32Array(slice);
    self.postMessage({ type: 'chunk', id, role, index, offset: i * per, chunk: copy.buffer }, [copy.buffer]);
  }
  self.postMessage({ type: 'channel-end', id, role, index, length: arr.length });
}

function handleProcess(msg) {
  const { id, opts, outSampleRate } = msg;
  const inRate = msg.sampleRate;
  const chans = msg.channels.map((b) => new Float32Array(b));
  const clean = [];
  const residual = [];
  let stats = null;

  for (let c = 0; c < chans.length; c++) {
    const r = DSP.cleanChannel(chans[c], opts, (p) => {
      self.postMessage({ type: 'progress', id, progress: (c + Math.min(1, p)) / chans.length });
    });
    clean.push(r.clean);
    residual.push(r.residual);
    stats = r.stats;
  }

  if (onTickGuard()) { /* never reached, keeps linters quiet */ }

  self.postMessage({ type: 'progress', id, progress: 1 });

  // decimated envelopes: tiny, safe to send in one go
  const peaks = decimate(DSP.peakEnvelope(chans, 1400));
  const cleanPeaks = decimate(DSP.peakEnvelope(clean, 1400));
  const inPeak = DSP.measure(chans).peakDb;
  const outPeak = DSP.measure(clean).peakDb;

  self.postMessage({
    type: 'done',
    id,
    stats,
    inPeak,
    outPeak,
    inSampleRate: inRate,
    outSampleRate: outSampleRate || inRate,
    peaks,
    cleanPeaks,
  });

  for (let c = 0; c < clean.length; c++) {
    sendChannelChunks(id, 'clean', c, clean[c]);
    sendChannelChunks(id, 'residual', c, residual[c]);
  }
  self.postMessage({ type: 'result-end', id });
}

function decimate(peaks) {
  return {
    buckets: peaks.buckets,
    min: Array.from(peaks.min),
    max: Array.from(peaks.max),
  };
}

function onTickGuard() { return false; }

function handleMaster(msg) {
  const { id, sampleRate, opts } = msg;
  const chans = msg.channels.map((b) => new Float32Array(b));
  const out = DSP.master(chans, sampleRate, opts || {});
  const peak = DSP.measure(out).peakDb;
  const peaks = decimate(DSP.peakEnvelope(out, 1400));
  self.postMessage({ type: 'mastered', id, peak, peaks });
  for (let c = 0; c < out.length; c++) sendChannelChunks(id, 'master', c, out[c]);
  self.postMessage({ type: 'result-end', id });
}

function floatToInt16(ch) {
  const out = new Int16Array(ch.length);
  for (let i = 0; i < ch.length; i++) {
    let s = Math.max(-1, Math.min(1, ch[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function handleEncode(msg) {
  const { id, sampleRate, format } = msg;
  const chans = msg.channels.map((b) => new Float32Array(b));
  const note = (p) => self.postMessage({ type: 'progress', id, progress: p });

  note(0.05);
  if (format === 'wav24') {
    const buf = DSP.encodeWav(chans, sampleRate, 24);
    note(1);
    self.postMessage({ type: 'encoded', id, buffer: buf, ext: 'wav', mime: 'audio/wav' }, [buf]);
    return;
  }
  if (format === 'wav16') {
    const buf = DSP.encodeWav(chans, sampleRate, 16);
    note(1);
    self.postMessage({ type: 'encoded', id, buffer: buf, ext: 'wav', mime: 'audio/wav' }, [buf]);
    return;
  }
  if (format === 'wav32') {
    const buf = DSP.encodeWav(chans, sampleRate, 32);
    note(1);
    self.postMessage({ type: 'encoded', id, buffer: buf, ext: 'wav', mime: 'audio/wav' }, [buf]);
    return;
  }

  // ---- MP3 via lamejs ----
  if (!lameReady) {
    self.postMessage({ type: 'error', id, message: 'MP3 encoder not available in this browser — choose a WAV format instead.' });
    return;
  }
  const bitrate = msg.bitrate || 320;
  const channels = Math.min(2, chans.length);
  const enc = new lamejs.Mp3Encoder(channels, sampleRate, bitrate);
  const left = floatToInt16(chans[0]);
  const right = channels > 1 ? floatToInt16(chans[1]) : null;
  const blockSize = 1152 * 8;
  const chunks = [];
  let total = 0;
  for (let i = 0; i < left.length; i += blockSize) {
    const l = left.subarray(i, i + blockSize);
    const r = right ? right.subarray(i, i + blockSize) : null;
    const mp3 = channels > 1 ? enc.encodeBuffer(l, r) : enc.encodeBuffer(l);
    if (mp3.length) { chunks.push(mp3); total += mp3.length; }
    if (Math.floor(i / blockSize) % 8 === 0) note(i / left.length);
  }
  const tail = enc.flush();
  if (tail.length) { chunks.push(tail); total += tail.length; }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  self.postMessage({ type: 'encoded', id, buffer: out.buffer, ext: 'mp3', mime: 'audio/mpeg' }, [out.buffer]);
}
