/* ===========================================================================
   app.js — Music Cleanup Studio UI controller
   =========================================================================== */
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const els = {
  dropzone: $('#dropzone'), fileinput: $('#fileinput'), browseBtn: $('#browseBtn'),
  processBtn: $('#processBtn'), stopBtn: $('#stopBtn'), clearBtn: $('#clearBtn'),
  trackList: $('#trackList'), emptyState: $('#emptyState'), log: $('#log'),
  autoplayChk: $('#autoplayChk'), downloadAllBtn: $('#downloadAllBtn'),
  statTracks: $('#statTracks'), statReady: $('#statReady'), statReduction: $('#statReduction'),
  playBtn: $('#playBtn'), tpTitle: $('#tpTitle'), tpSub: $('#tpSub'),
  wave: $('#wave'), playhead: $('#playhead'), tpTime: $('#tpTime'),
  volume: $('#volume'), outFormat: $('#outFormat'),
};

const state = {
  tracks: [],
  selected: null,
  playing: false,
  source: 'clean',      // clean | orig | master | noise
  stopRequested: false,
  saveMode: 'both',
  jobId: 0,
  jobWaiters: new Map(),
};

/* ───────────────────────── audio I/O ───────────────────────── */
let audioCtx = null;
function ctx() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') audioCtx.resume();
  return audioCtx;
}

let sourceNode = null, gainNode = null;
let playing = false;          // authoritative playback flag
let startOffset = 0;          // buffer offset the current node started at
let startCtxTime = 0;         // ctx.currentTime when it started
let pausedAt = 0;             // resume position while paused / stopped
let rafId = 0;

function positionNow() {
  if (!playing || !audioCtx) return pausedAt;
  const b = currentBuffer();
  const d = (audioCtx.currentTime - startCtxTime) + startOffset;
  return Math.max(0, Math.min(d, b ? b.duration : d));
}

function stopPlayback({ reset = false } = {}) {
  if (playing) pausedAt = positionNow();
  const node = sourceNode;
  sourceNode = null;
  if (node) {
    node.onended = null;
    try { node.stop(); } catch (e) { /* already stopped */ }
    try { node.disconnect(); } catch (e) {}
  }
  playing = false;
  cancelAnimationFrame(rafId);
  if (reset) pausedAt = 0;
  updatePlayButton();
}

function playBuffer(buffer, offset) {
  stopPlayback();
  const c = ctx();
  const node = c.createBufferSource();
  node.buffer = buffer;
  if (!gainNode) {
    gainNode = c.createGain();
    gainNode.connect(c.destination);
  }
  gainNode.gain.value = Number(els.volume.value);
  node.connect(gainNode);
  startOffset = Math.max(0, Math.min(offset || 0, buffer.duration - 0.01));
  pausedAt = startOffset;
  startCtxTime = c.currentTime;
  node.start(0, startOffset);
  sourceNode = node;
  node.onended = () => {
    // ignore events from nodes we already replaced
    if (sourceNode !== node) return;
    playing = false;
    pausedAt = 0;
    drawPlayhead(0);
    els.tpTime.textContent = `0:00 / ${fmtTime(buffer.duration)}`;
    updatePlayButton();
  };
  playing = true;
  updatePlayButton();
  tickPlayhead();
}

function tickPlayhead() {
  const b = currentBuffer();
  if (!playing || !b) return;
  const d = positionNow();
  drawPlayhead(d / b.duration);
  els.tpTime.textContent = `${fmtTime(d)} / ${fmtTime(b.duration)}`;
  if (d >= b.duration - 0.02) {
    playing = false;
    pausedAt = 0;
    drawPlayhead(0);
    updatePlayButton();
    return;
  }
  rafId = requestAnimationFrame(tickPlayhead);
}

function updatePlayButton() {
  els.playBtn.disabled = !currentBuffer();
  els.playBtn.querySelector('.play-icon').hidden = playing;
  els.playBtn.querySelector('.pause-icon').hidden = !playing;
}

/* ───────────────────────── worker plumbing ───────────────────────── */
let worker = null;
let workerBroken = false;
function ensureWorker() {
  if (worker) return worker;
  if (workerBroken) throw new Error('This browser cannot start the audio worker. Try a current Chrome, Edge, Firefox or Safari.');
  try {
    worker = new Worker('src/cleanup.worker.js');
  } catch (err) {
    workerBroken = true;
    log('Could not start the audio engine: ' + err.message, 'er');
    throw err;
  }
  worker.onmessage = (e) => {
    const msg = e.data;
    const waiter = state.jobWaiters.get(msg.id);
    if (!waiter) return;
    if (msg.type === 'progress' && waiter.onProgress) waiter.onProgress(msg.progress);
    else if (msg.type === 'chunk' && waiter.onChunk) waiter.onChunk(msg);
    else if (msg.type === 'done' && waiter.onDone) waiter.onDone(msg);
    else if (msg.type === 'result-end' && waiter.onResult) waiter.onResult({});
    else if (msg.type === 'mastered' && waiter.onMastered) waiter.onMastered(msg);
    else if (msg.type === 'encoded' && waiter.onResult) waiter.onResult(msg);
    else if (msg.type === 'error') {
      state.jobWaiters.delete(msg.id);
      if (waiter.onError) waiter.onError(new Error(msg.message));
    }
  };
  worker.onerror = (e) => log('Worker error: ' + (e.message || 'unknown'), 'er');
  return worker;
}

function job(type, payload, handlers) {
  const id = ++state.jobId;
  try { ensureWorker(); } catch (err) {
    if (handlers.onError) handlers.onError(err);
    return id;
  }
  state.jobWaiters.set(id, {
    ...handlers,
    onError: (err) => { state.jobWaiters.delete(id); handlers.onError && handlers.onError(err); },
  });
  const done = () => state.jobWaiters.delete(id);
  if (handlers.onResult) {
    const orig = handlers.onResult;
    handlers.onResult = (m) => { done(); orig(m); };
    state.jobWaiters.get(id).onResult = handlers.onResult;
  }
  if (handlers.onMastered) {
    const origM = handlers.onMastered;
    handlers.onMastered = (m) => { if (origM) origM(m); };
    state.jobWaiters.get(id).onMastered = handlers.onMastered;
  }
  worker.postMessage({ type, id, ...payload });
  return id;
}

/* ─────────────── chunked channel transfers (big files) ─────────────── */
function newCollector(channels) {
  const store = {};   // role -> [ [chunk,...], ... ]
  const lengths = {}; // role -> [offset,...]
  return {
    push(msg) {
      const { role, index, offset, chunk } = msg;
      if (!store[role]) { store[role] = []; lengths[role] = []; }
      (store[role][index] = store[role][index] || []).push({ offset, data: new Float32Array(chunk) });
      lengths[role][index] = Math.max(lengths[role][index] || 0, offset + chunk.byteLength / 4);
    },
    assemble(role, fallbackLen) {
      if (!store[role]) return null;
      return store[role].map((chunks, i) => {
        const len = lengths[role][i] || fallbackLen;
        const out = new Float32Array(len);
        for (const c of chunks) out.set(c.data, c.offset);
        return out;
      });
    },
    has(role) { return !!store[role]; },
  };
}

/* ─────────── keep the uploaded sample rate (Chrome is 48 kHz) ─────────── */
// Chrome/Android forces AudioContext to 48 kHz, which silently resamples a
// 44.1 kHz upload. Peek the real rate out of the container and decode in an
// OfflineAudioContext created at that rate instead.
function peekSampleRate(buf) {
  try {
    const v = new DataView(buf);
    const tag = (o) => String.fromCharCode(v.getUint8(o), v.getUint8(o + 1), v.getUint8(o + 2), v.getUint8(o + 3));
    if (buf.byteLength > 44 && tag(0) === 'RIFF' && tag(8) === 'WAVE') {
      let o = 12;
      while (o + 8 <= buf.byteLength) {
        const id = tag(o);
        const size = v.getUint32(o + 4, true);
        if (id === 'fmt ') return v.getUint32(o + 12, true) || null;
        o += 8 + size + (size % 2);
      }
    }
    if (tag(0) === 'fLaC') {
      // STREAMINFO: sample rate is 20 bits at byte 18..20
      return ((v.getUint8(18) << 12) | (v.getUint8(19) << 4) | (v.getUint8(20) >> 4)) || null;
    }
    // MP3: walk to the first frame sync and read the header
    if (buf.byteLength > 4) {
      for (let o = 0; o + 4 < Math.min(buf.byteLength, 65536); o++) {
        if (v.getUint8(o) === 0xff && (v.getUint8(o + 1) & 0xe0) === 0xe0) {
          const ver = (v.getUint8(o + 1) >> 3) & 3;
          const srIdx = (v.getUint8(o + 2) >> 2) & 3;
          const table = ver === 3 ? [44100, 48000, 32000] : ver === 2 ? [22050, 24000, 16000] : [11025, 12000, 8000];
          if (srIdx < 3) return table[srIdx];
        }
      }
    }
  } catch (e) { /* unreadable header, fall through */ }
  return null;
}

async function decodeAtOriginalRate(arrayBuf) {
  const hinted = peekSampleRate(arrayBuf);
  const rate = hinted && hinted >= 8000 && hinted <= 192000 ? hinted : null;
  let decoded = null;
  let usedRate = null;

  if (rate && rate !== ctx().sampleRate) {
    try {
      const oc = new OfflineAudioContext(1, 1, rate);
      decoded = await oc.decodeAudioData(arrayBuf.slice(0));
      usedRate = decoded.sampleRate;
    } catch (e) { decoded = null; }
  }
  if (!decoded) {
    decoded = await ctx().decodeAudioData(arrayBuf.slice(0));
    usedRate = decoded.sampleRate;
  }
  return { decoded, sourceRate: rate, usedRate, resampled: !!rate && usedRate !== rate };
}

/* ───────────────────────── settings ───────────────────────── */
function readSettings() {
  return {
    fftSize: Number($('#fftSize').value),
    profilePct: Number($('#profilePct').value),
    strength: Number($('#strength').value),
    maxReductionDb: Number($('#maxReduction').value),
    temporalSmooth: Number($('#temporalSmooth').value),
  };
}
function readMasterSettings() {
  return {
    highPassHz: 28,
    airDb: Number($('#airDb').value),
    thresholdDb: Number($('#compThr').value),
    ratio: Number($('#compRatio').value),
    ceilingDb: Number($('#ceiling').value),
    maxBoostDb: Number($('#maxBoost').value),
  };
}

const PRESETS = {
  light:     { strength: 35, profilePct: 8,  maxReduction: 8,  temporalSmooth: 0.7, fftSize: 2048 },
  balanced:  { strength: 60, profilePct: 12, maxReduction: 12, temporalSmooth: 0.5, fftSize: 2048 },
  strong:    { strength: 82, profilePct: 16, maxReduction: 18, temporalSmooth: 0.35, fftSize: 2048 },
  surgical:  { strength: 100, profilePct: 20, maxReduction: 24, temporalSmooth: 0.2, fftSize: 4096 },
};

$$('.chip[data-preset]').forEach((chip) => {
  chip.addEventListener('click', () => {
    $$('.chip[data-preset]').forEach((c) => c.classList.remove('active'));
    chip.classList.add('active');
    const p = PRESETS[chip.dataset.preset];
    if (!p) return;
    $('#strength').value = p.strength;
    $('#profilePct').value = p.profilePct;
    $('#maxReduction').value = p.maxReduction;
    $('#temporalSmooth').value = p.temporalSmooth;
    $('#fftSize').value = p.fftSize;
    syncOutputs();
    invalidateResults();
    log(`Preset: ${chip.dataset.preset} — reprocess to compare.`);
  });
});

function syncOutputs() {
  const fmt = {
    strengthOut: [`${$('#strength').value}%`, $('#strength')],
    profilePctOut: [`quietest ${$('#profilePct').value}%`, $('#profilePct')],
    maxReductionOut: [`${$('#maxReduction').value} dB`, $('#maxReduction')],
    temporalSmoothOut: [Number($('#temporalSmooth').value).toFixed(2), $('#temporalSmooth')],
    airDbOut: [`${Number($('#airDb').value) > 0 ? '+' : ''}${$('#airDb').value} dB`, $('#airDb')],
    ceilingOut: [`${Number($('#ceiling').value).toFixed(1)} dBFS`, $('#ceiling')],
    compThrOut: [`${$('#compThr').value} dB`, $('#compThr')],
    compRatioOut: [`${Number($('#compRatio').value).toFixed(1)}:1`, $('#compRatio')],
  };
  for (const [outId, [text, input]] of Object.entries(fmt)) {
    const out = document.getElementById(outId);
    if (out) out.textContent = text;
    if (input) {
      const min = Number(input.min || 0), max = Number(input.max || 100);
      const p = ((Number(input.value) - min) / (max - min)) * 100;
      input.style.setProperty('--p', p + '%');
    }
  }
}
$$('input[type=range]').forEach((r) => r.addEventListener('input', syncOutputs));
$$('#masterOn, #airDb, #ceiling, #compThr, #compRatio, #maxBoost').forEach((el) => {
  el.addEventListener('input', () => { syncOutputs(); invalidateMaster(); });
});

// cleanup settings invalidate existing results (debounced so dragging is quiet)
let invalidateTimer = 0;
$$('#strength, #profilePct, #maxReduction, #temporalSmooth, #fftSize').forEach((el) => {
  const handler = () => {
    clearTimeout(invalidateTimer);
    invalidateTimer = setTimeout(() => {
      $$('.chip[data-preset]').forEach((c) => c.classList.remove('active'));
      invalidateResults();
    }, 220);
  };
  el.addEventListener('input', handler);
  el.addEventListener('change', handler);
});

$('#saveMode').addEventListener('click', (e) => {
  const btn = e.target.closest('.seg');
  if (!btn) return;
  $$('#saveMode .seg').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');
  state.saveMode = btn.dataset.mode;
  renderTracks();
});

/* ───────────────────────── file import ───────────────────────── */
function fmtBytes(n) {
  if (n > 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n > 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}
function fmtTime(s) {
  if (!isFinite(s)) return '0:00';
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${String(sec).padStart(2, '0')}`;
}
const baseName = (n) => n.replace(/\.[^.]+$/, '');

async function addFiles(fileList) {
  const files = Array.from(fileList).filter((f) => /\.(wav|mp3|flac|ogg|oga|m4a|aac|aiff|aif|webm|mp4)$/i.test(f.name) || f.type.startsWith('audio/'));
  if (!files.length) { log('No supported audio files in that drop.', 'er'); return; }

  for (const file of files) {
    log(`Reading ${file.name} …`);
    try {
      const arrayBuf = await file.arrayBuffer();
      const { decoded, sourceRate, resampled } = await decodeAtOriginalRate(arrayBuf);
      if (resampled) {
        log(`Note: ${file.name} is ${(sourceRate / 1000).toFixed(1)} kHz but this browser forces ` +
            `${(decoded.sampleRate / 1000).toFixed(1)} kHz decoding — output will be ${(decoded.sampleRate / 1000).toFixed(1)} kHz.`, 'er');
      }
      const track = {
        id: 'trk' + Math.random().toString(36).slice(2, 9),
        name: file.name,
        size: file.size,
        ext: (file.name.split('.').pop() || 'wav').toLowerCase(),
        sampleRate: decoded.sampleRate,
        channels: Array.from({ length: decoded.numberOfChannels }, (_, i) => Float32Array.from(decoded.getChannelData(i))),
        duration: decoded.duration,
        peaks: DSPClient.peaks(Array.from({ length: decoded.numberOfChannels }, (_, i) => decoded.getChannelData(i)), 1400),
        status: 'idle',
        progress: 0,
        clean: null,
        residual: null,
        master: null,
        stats: null,
        inPeak: null,
      };
      state.tracks.push(track);
      log(`Added ${track.name} — ${fmtTime(track.duration)} · ${(track.sampleRate / 1000).toFixed(1)} kHz · ${track.channels.length}ch`, 'ok');
      if (!state.selected) selectTrack(track, false);
    } catch (err) {
      log(`Could not decode ${file.name}: ${err.message || err}`, 'er');
    }
  }
  renderTracks();
  refreshButtons();
}

// peak envelope on the main thread for instant waveform (cheap)
const DSPClient = {
  peaks(chans, buckets) {
    const n = chans[0].length;
    const b = Math.min(buckets, n);
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
  },
};

/* drag & drop */
['dragenter', 'dragover'].forEach((ev) => els.dropzone.addEventListener(ev, (e) => {
  e.preventDefault(); els.dropzone.classList.add('drag');
}));
['dragleave', 'drop'].forEach((ev) => els.dropzone.addEventListener(ev, (e) => {
  e.preventDefault();
  if (ev === 'dragleave' && e.relatedTarget && els.dropzone.contains(e.relatedTarget)) return;
  els.dropzone.classList.remove('drag');
}));
els.dropzone.addEventListener('drop', (e) => {
  if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
});
els.dropzone.addEventListener('click', () => els.fileinput.click());
els.dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.fileinput.click(); }
});
els.browseBtn.addEventListener('click', (e) => { e.stopPropagation(); els.fileinput.click(); });
els.fileinput.addEventListener('change', (e) => {
  if (e.target.files.length) addFiles(e.target.files);
  e.target.value = '';
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  if (e.dataTransfer && e.dataTransfer.files.length && !els.dropzone.contains(e.target)) addFiles(e.dataTransfer.files);
});

/* ───────────────────────── processing ───────────────────────── */
function audioBuffersFor(track) {
  return track.channels.map((c) => c.buffer.slice(0));
}

async function processTrack(track) {
  if (state.stopRequested) return;
  track.status = 'processing';
  track.progress = 0;
  track.stage = 'analysing';
  const overallStart = performance.now();
  track.startedAt = overallStart;
  startProgressTicker();
  renderTracks();

  const settings = readSettings();
  const collector = newCollector(track.channels.length);
  const tCleanStart = performance.now();
  let tCleanEnd = 0, tMasterEnd = 0;

  await new Promise((resolve) => {
    job('process', {
      sampleRate: track.sampleRate,
      channels: audioBuffersFor(track),
      opts: settings,
    }, {
      onProgress: (p) => {
        track.progress = Math.max(track.progress, Math.min(0.999, p));
        track.stage = track.progress < 0.2 ? 'analysing' : 'cleaning';
        updateTrackProgress(track);
      },
      onChunk: (m) => collector.push(m),
      onDone: (m) => {
        track.stats = m.stats;
        track.inPeak = m.inPeak;
        track.outPeak = m.outPeak;
      },
      onResult: () => {
        tCleanEnd = performance.now();
        track.clean = collector.assemble('clean');
        track.residual = collector.assemble('residual');
        track.cleanPeaks = collector.peaks;
        track.master = null;
        resolve();
      },
      onError: (err) => {
        track.status = 'error';
        track.error = err.message;
        log(`${track.name}: ${err.message}`, 'er');
        stopProgressTicker();
        resolve();
      },
    });
  });

  if (state.stopRequested) {
    track.status = 'idle';
    track.progress = 0;
    stopProgressTicker();
    renderTracks();
    return;
  }

  if ($('#masterOn').checked) {
    track.status = 'mastering';
    track.stage = 'mastering';
    track.progress = 0;
    track.startedAt = performance.now();
    renderTracks();
    const mc = newCollector(track.channels.length);
    let peak = null;
    await new Promise((resolve) => {
      job('master', {
        sampleRate: track.sampleRate,
        channels: track.clean.map((c) => c.buffer.slice(0)),
        opts: readMasterSettings(),
      }, {
        onChunk: (m) => mc.push(m),
        onProgress: (p) => { track.progress = p; },
        onMastered: (m) => { peak = m.peak; track.masterPeaks = m.peaks; },
        onResult: () => {
          tMasterEnd = performance.now();
          track.master = mc.assemble('master');
          track.masterPeak = peak;
          resolve();
        },
        onError: (err) => { log(`Master failed on ${track.name}: ${err.message}`, 'er'); resolve(); },
      });
    });
  } else {
    track.master = null;
  }

  blobCache.clear();
  staleNoted = false;
  stopProgressTicker();
  track.status = 'done';
  track.progress = 1;
  if (els.autoplayChk.checked) selectTrack(track, false);
  renderTracks();
  refreshButtons();

  if (track.stats) {
    const total = ((performance.now() - overallStart) / 1000).toFixed(1);
    const cleanSecs = tCleanEnd ? ((tCleanEnd - tCleanStart) / 1000).toFixed(1) : '?';
    const masterSecs = tMasterEnd && tCleanEnd ? ((tMasterEnd - tCleanEnd) / 1000).toFixed(1) : null;
    const speed = track.duration ? (track.duration / ((tCleanEnd - tCleanStart) / 1000)).toFixed(0) : '?';
    track.timings = { total, cleanSecs, masterSecs, speed };
    log(`${track.name} — noise profile from ${track.stats.profileFrames} frames ` +
        `(${track.stats.profilePct}%), avg cut ${track.stats.avgReductionDb.toFixed(1)} dB · ` +
        `clean ${cleanSecs}s (${speed}× realtime)` +
        (masterSecs ? ` · master ${masterSecs}s` : '') + ` · total ${total}s`, 'ok');
  }
}

/* live timer so the progress pill never looks frozen */
let tickerId = 0;
async function processAll() {
  const busy = state.tracks.some((t) => t.status === 'processing' || t.status === 'mastering');
  if (busy) return;

  let pending = state.tracks.filter((t) => t.status !== 'done' || !t.clean);
  if (!pending.length && state.tracks.length) {
    // everything is already processed and the settings have not changed -> re-run all
    pending = state.tracks.slice();
  }
  if (!pending.length) return;

  state.stopRequested = false;
  refreshButtons();
  const t0 = performance.now();
  for (const track of pending) {
    if (state.stopRequested) { log('Stopped.', 'er'); break; }
    log(`Processing ${track.name} …`);
    await processTrack(track);
  }
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  log(state.stopRequested ? 'Batch stopped.' : `Batch complete in ${secs}s.`, state.stopRequested ? 'er' : 'ok');
  state.stopRequested = false;
  stopProgressTicker();
  refreshButtons();
  renderTracks();
}

function startProgressTicker() {
  if (tickerId) return;
  tickerId = setInterval(() => {
    const busy = state.tracks.filter((t) => t.status === 'processing' || t.status === 'mastering');
    for (const t of busy) updateTrackProgress(t);
    if (!busy.length) stopProgressTicker();
  }, 250);
}
function stopProgressTicker() {
  if (tickerId) { clearInterval(tickerId); tickerId = 0; }
}

let staleNoted = false;
function invalidateResults() {
  blobCache.clear();
  let dirty = false;
  state.tracks.forEach((t) => {
    if (t.clean) dirty = true;
    t.status = t.clean ? 'stale' : 'idle';
  });
  if (dirty && !staleNoted) {
    log('Settings changed — process again to hear the new result.');
    staleNoted = true;
  }
  if (!dirty) staleNoted = false;
  renderTracks();
  refreshButtons();
}
function invalidateMaster() {
  blobCache.clear();
  state.tracks.forEach((t) => { t.master = null; if (t.status === 'done') t.status = 'stale'; });
  renderTracks();
}

/* ───────────────────────── rendering ───────────────────────── */
function statusPill(t) {
  switch (t.status) {
    case 'processing': return `<span class="pill proc">${t.stage || 'analysing'} ${Math.round(t.progress * 100)}%</span>`;
    case 'mastering': return `<span class="pill proc">mastering</span>`;
    case 'done': return '<span class="pill done">ready</span>';
    case 'stale': return '<span class="pill proc">needs reprocess</span>';
    case 'error': return '<span class="pill err">error</span>';
    default: return '<span class="pill">queued</span>';
  }
}

function renderTracks() {
  const list = state.tracks;
  els.emptyState.style.display = list.length ? 'none' : 'block';
  els.dropzone.classList.toggle('compact', list.length > 0);
  els.trackList.innerHTML = list.map((t) => {
    const ready = !!(t.clean || t.master);
    const sel = state.selected === t;
    const srcBadges = [];
    if (t.clean) srcBadges.push('Clean');
    if (t.master) srcBadges.push('Master');
    return `
    <div class="track ${sel ? 'selected' : ''}" data-id="${t.id}">
      <div class="track-head">
        <div class="track-name" title="${esc(t.name)}">${esc(t.name)}</div>
        ${statusPill(t)}
        <div class="track-meta"><b>${fmtTime(t.duration)}</b> · ${(t.sampleRate / 1000).toFixed(1)} kHz · ${t.channels.length === 1 ? 'mono' : 'stereo'} · ${fmtBytes(t.size)}</div>
      </div>
      <div class="track-actions">
        <button class="mini ${sel && state.source === 'orig' ? 'active' : ''}" data-act="play-orig" data-id="${t.id}">Orig</button>
        <button class="mini ${sel && state.source === 'clean' ? 'active' : ''}" data-act="play-clean" data-id="${t.id}" ${t.clean ? '' : 'disabled'}>Clean</button>
        <button class="mini ${sel && state.source === 'master' ? 'active' : ''}" data-act="play-master" data-id="${t.id}" ${t.master ? '' : 'disabled'}>Master</button>
        <button class="mini ${sel && state.source === 'noise' ? 'active' : ''}" data-act="play-noise" data-id="${t.id}" ${t.residual ? '' : 'disabled'}>Noise</button>
        <button class="mini" data-act="save" data-id="${t.id}" ${ready ? '' : 'disabled'}>Save</button>
        <button class="mini" data-act="remove" data-id="${t.id}">✕</button>
      </div>
      ${t.status === 'processing' || t.status === 'mastering'
        ? `<div class="track-bar"><i style="width:${Math.round((t.progress || 0) * 100)}%"></i></div>` : ''}
      ${t.stats ? `<div class="track-stats">
          <span>noise floor <b>${t.stats.avgReductionDb.toFixed(1)} dB</b></span>
          <span>peak reduction <b>${t.stats.peakReductionDb.toFixed(1)} dB</b></span>
          <span>profile frames <b>${t.stats.profileFrames}</b></span>
          ${t.outPeak != null ? `<span>out peak <b>${t.outPeak.toFixed(1)} dBFS</b></span>` : ''}
          ${t.masterPeak != null ? `<span>master peak <b>${t.masterPeak.toFixed(1)} dBFS</b></span>` : ''}
          ${t.timings ? `<span>speed <b>${t.timings.speed}× realtime</b></span>` : ''}
        </div>` : ''}
    </div>`;
  }).join('');

  els.statTracks.textContent = list.length;
  els.statReady.textContent = list.filter((t) => t.status === 'done').length;
  const cuts = list.filter((t) => t.stats).map((t) => t.stats.avgReductionDb);
  els.statReduction.textContent = cuts.length ? (cuts.reduce((a, b) => a + b, 0) / cuts.length).toFixed(1) + ' dB' : '—';
  refreshButtons();
}

function updateTrackProgress(t) {
  const row = els.trackList.querySelector(`[data-id="${t.id}"]`);
  if (!row) return;
  const bar = row.querySelector('.track-bar > i');
  const pct = Math.round((t.progress || 0) * 100);
  if (bar) bar.style.width = pct + '%';
  const pill = row.querySelector('.pill');
  const secs = t.startedAt ? Math.round((performance.now() - t.startedAt) / 1000) : 0;
  if (pill) {
    if (t.status === 'processing') pill.textContent = `${t.stage || 'cleaning'} ${pct}% · ${secs}s`;
    else if (t.status === 'mastering') pill.textContent = `mastering ${secs}s`;
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function refreshButtons() {
  const any = state.tracks.length > 0;
  const busy = state.tracks.some((t) => t.status === 'processing' || t.status === 'mastering');
  els.processBtn.disabled = !any || busy;
  els.stopBtn.disabled = !busy;
  els.clearBtn.disabled = !any;
  els.downloadAllBtn.disabled = !state.tracks.some((t) => t.clean || t.master);
  els.processBtn.innerHTML = busy
    ? '<svg viewBox="0 0 24 24" class="i"><rect x="6" y="6" width="12" height="12" rx="2"/></svg> Working…'
    : '<svg viewBox="0 0 24 24" class="i"><path d="M8 5v14l11-7z"/></svg> Process all';
}

/* track list events */
els.trackList.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act]');
  if (!btn) {
    const row = e.target.closest('.track');
    if (row) {
      const t = state.tracks.find((x) => x.id === row.dataset.id);
      if (t) selectTrack(t, false);
    }
    return;
  }
  const t = state.tracks.find((x) => x.id === btn.dataset.id);
  if (!t) return;
  const act = btn.dataset.act;
  if (act === 'remove') {
    if (state.selected === t) { stopPlayback({ reset: true }); state.selected = null; }
    state.tracks = state.tracks.filter((x) => x !== t);
    blobCache.clear();
    renderTracks();
    if (!state.selected && state.tracks.length) selectTrack(state.tracks[0], false);
    else renderTransport();
    return;
  }
  if (act === 'save') { saveTrack(t); return; }
  if (act.startsWith('play-')) {
    const map = { 'play-orig': 'orig', 'play-clean': 'clean', 'play-master': 'master', 'play-noise': 'noise' };
    selectTrack(t, true);
    setSource(map[act], true);
  }
});

/* ───────────────────────── transport / selection ───────────────────────── */
function selectTrack(track, andPlay) {
  const changed = state.selected !== track;
  state.selected = track;
  if (changed) stopPlayback({ reset: true });
  if (track) {
    if (!bufferFor(state.source)) {
      const fallback = ['clean', 'master', 'orig', 'noise'].find((s) => bufferFor(s));
      if (fallback) state.source = fallback;
    }
    renderTransport();
    renderTracks();
    if (andPlay) {
      const b = currentBuffer();
      if (b) playBuffer(b, 0);
    }
  }
}

function bufferFor(src, track) {
  const t = track || state.selected;
  if (!t) return null;
  let chans = null;
  if (src === 'orig') chans = t.channels;
  else if (src === 'clean') chans = t.clean;
  else if (src === 'master') chans = t.master;
  else if (src === 'noise') chans = t.residual;
  if (!chans) return null;
  if (t._bufCache && t._bufCache[src] && t._bufCache[src].__chans === chans) return t._bufCache[src].buf;
  const c = ctx();
  const buf = c.createBuffer(chans.length, chans[0].length, t.sampleRate);
  chans.forEach((ch, i) => buf.copyToChannel(ch, i));
  t._bufCache = t._bufCache || {};
  t._bufCache[src] = { buf, __chans: chans };
  return buf;
}
function currentBuffer() { return bufferFor(state.source); }

function setSource(src, keepPlaying) {
  const b = bufferFor(src);
  if (!b) { log('That version is not ready yet — process first.', 'er'); return; }
  const wasPlaying = playing;
  const pos = positionNow();
  state.source = src;
  $$('.ab-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.src === src));
  renderTransport();
  if (keepPlaying && wasPlaying) playBuffer(b, pos);
  else { pausedAt = Math.min(pos, b.duration); drawPlayhead(pausedAt / b.duration); }
}

$$('.ab-btn').forEach((btn) => {
  // A/B only swaps the source; it does not start playback on its own
  btn.addEventListener('click', () => setSource(btn.dataset.src, playing));
});
els.playBtn.addEventListener('click', () => {
  const b = currentBuffer();
  if (!b) return;
  if (playing) {
    stopPlayback();
    drawPlayhead(pausedAt / b.duration);
    els.tpTime.textContent = `${fmtTime(pausedAt)} / ${fmtTime(b.duration)}`;
  } else {
    playBuffer(b, pausedAt >= b.duration - 0.1 ? 0 : pausedAt);
  }
});
els.volume.addEventListener('input', () => {
  if (gainNode) gainNode.gain.value = Number(els.volume.value);
});
$('#wave').parentElement.addEventListener('click', (e) => {
  const b = currentBuffer();
  if (!b) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const wasPlaying = playing;
  stopPlayback();
  const at = frac * b.duration;
  pausedAt = at;
  drawPlayhead(frac);
  els.tpTime.textContent = `${fmtTime(at)} / ${fmtTime(b.duration)}`;
  if (wasPlaying) playBuffer(b, at);
});

document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
  if (e.code === 'Space') { e.preventDefault(); els.playBtn.click(); }
  if (e.key.toLowerCase() === 'a') {
    const order = ['orig', 'clean', 'master', 'noise'];
    const avail = order.filter((s) => bufferFor(s));
    if (avail.length < 2) return;
    const i = avail.indexOf(state.source);
    setSource(avail[(i + 1) % avail.length], true);
  }
});

function renderTransport() {
  const t = state.selected;
  const b = currentBuffer();
  if (!t) {
    els.tpTitle.textContent = 'Nothing loaded';
    els.tpSub.textContent = 'Add a track, then Process';
  } else {
    els.tpTitle.textContent = t.name;
    const label = { orig: 'Original', clean: 'Cleaned', master: 'Mastered', noise: 'Removed noise' }[state.source];
    els.tpSub.textContent = `${label} · ${t.channels.length === 1 ? 'mono' : 'stereo'} · ${(t.sampleRate / 1000).toFixed(1)} kHz · ${fmtTime(t.duration)}`;
  }
  $$('.ab-btn').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.src === state.source);
    btn.disabled = !bufferFor(btn.dataset.src);
  });
  els.tpTime.textContent = `0:00 / ${fmtTime(b ? b.duration : 0)}`;
  drawWave();
  updatePlayButton();
}

/* ───────────────────────── waveform canvas ───────────────────────── */
function drawWave() {
  const cvs = els.wave;
  const dpr = window.devicePixelRatio || 1;
  const w = cvs.clientWidth, h = cvs.clientHeight;
  if (cvs.width !== Math.round(w * dpr) || cvs.height !== Math.round(h * dpr)) {
    cvs.width = Math.round(w * dpr);
    cvs.height = Math.round(h * dpr);
  }
  const g = cvs.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);

  const t = state.selected;
  if (!t) return;
  const peaks = (state.source === 'clean' || state.source === 'master')
    ? (t.cleanPeaks || t.peaks)
    : t.peaks;
  if (!peaks) return;

  const n = peaks.buckets;
  const mid = h / 2;
  const grad = g.createLinearGradient(0, 0, 0, h);
  const color = state.source === 'orig' ? ['#4a6a8f', '#2f4a66']
    : state.source === 'noise' ? ['#a06a3a', '#6b4526']
    : ['#39d3a5', '#1fa77e'];
  grad.addColorStop(0, color[0]);
  grad.addColorStop(1, color[1]);
  g.fillStyle = grad;
  for (let x = 0; x < w; x++) {
    const i = Math.min(n - 1, Math.floor((x / w) * n));
    const hi = peaks.max[i], lo = peaks.min[i];
    const y1 = mid - hi * (mid - 3);
    const y2 = mid - lo * (mid - 3);
    g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
  // centre line
  g.fillStyle = 'rgba(255,255,255,.06)';
  g.fillRect(0, mid, w, 1);
}

function drawPlayhead(frac) {
  els.playhead.style.left = `${Math.max(0, Math.min(1, frac)) * 100}%`;
}

window.addEventListener('resize', () => drawWave());

/* ───────────────────────── export ───────────────────────── */
function outFormat() {
  const v = els.outFormat.value;
  if (v === 'mp3-320') return { format: 'mp3', bitrate: 320, ext: 'mp3' };
  if (v === 'mp3-192') return { format: 'mp3', bitrate: 192, ext: 'mp3' };
  if (v === 'wav16') return { format: 'wav16', ext: 'wav' };
  return { format: 'wav24', ext: 'wav' };
}

function encode(channels, sampleRate, onProgress) {
  const f = outFormat();
  return new Promise((resolve, reject) => {
    job('encode', { channels: channels.map((c) => c.buffer.slice(0)), sampleRate, format: f.format, bitrate: f.bitrate }, {
      onProgress,
      onResult: (m) => resolve({ buffer: m.buffer, ext: m.ext, mime: m.mime }),
      onError: reject,
    });
  });
}

const blobCache = new Map();   // `${track.id}:${variant}:${format}` -> Blob

function download(blobOrBuf, filename, mime) {
  const blob = blobOrBuf instanceof Blob ? blobOrBuf : new Blob([blobOrBuf], { type: mime || 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

async function versionsFor(track) {
  const out = [];
  const mode = state.saveMode;
  const wantClean = mode === 'both' || mode === 'clean';
  const wantMaster = (mode === 'both' || mode === 'master') && !!track.master;
  if (wantClean && track.clean) out.push({ suffix: 'clean', chans: track.clean });
  if (wantMaster) out.push({ suffix: 'mastered', chans: track.master });
  if (!out.length && track.master) out.push({ suffix: 'mastered', chans: track.master });
  return out;
}

function cachedEncode(track, variant, chans) {
  const key = `${track.id}:${variant}:${els.outFormat.value}`;
  if (blobCache.has(key)) return Promise.resolve({ blob: blobCache.get(key), ext: key.endsWith('mp3-320') || key.endsWith('mp3-192') ? 'mp3' : 'wav' });
  return encode(chans, track.sampleRate).then((enc) => {
    const blob = new Blob([enc.buffer], { type: enc.mime });
    blobCache.set(key, blob);
    return { blob, ext: enc.ext };
  });
}

async function saveTrack(track) {
  const versions = await versionsFor(track);
  if (!versions.length) { log('Nothing to save for that track yet.', 'er'); return; }
  try {
    for (const v of versions) {
      log(`Encoding ${baseName(track.name)} — ${v.suffix} …`);
      const enc = await cachedEncode(track, v.suffix, v.chans);
      download(enc.blob, `${baseName(track.name)} — ${v.suffix}.${enc.ext}`, enc.blob.type);
      log(`Saved ${baseName(track.name)} — ${v.suffix}.${enc.ext}`, 'ok');
    }
  } catch (err) {
    log('Export failed: ' + err.message, 'er');
  }
}

async function saveAll() {
  const ready = state.tracks.filter((t) => t.clean || t.master);
  if (!ready.length) return;
  els.downloadAllBtn.disabled = true;
  const original = els.downloadAllBtn.textContent;
  els.downloadAllBtn.textContent = 'Building zip…';
  try {
    const zip = new Zip();
    for (const track of ready) {
      const versions = await versionsFor(track);
      for (const v of versions) {
        const enc = await cachedEncode(track, v.suffix, v.chans);
        zip.add(`${baseName(track.name)} — ${v.suffix}.${enc.ext}`, enc.blob);
        log(`Packed ${baseName(track.name)} — ${v.suffix}.${enc.ext}`, 'ok');
      }
    }
    const blob = await zip.build();
    log(`Zip ready: ${zip.length} files · ${fmtBytes(blob.size)}`, 'ok');
    download(blob, `music-cleanup-${new Date().toISOString().slice(0, 10)}.zip`, 'application/zip');
  } catch (err) {
    log('Zip build failed: ' + err.message, 'er');
  } finally {
    els.downloadAllBtn.textContent = original;
    els.downloadAllBtn.disabled = false;
    refreshButtons();
  }
}

/* ───────────────────────── misc wiring ───────────────────────── */
els.processBtn.addEventListener('click', processAll);
els.stopBtn.addEventListener('click', () => { state.stopRequested = true; log('Stopping after the current block…', 'er'); });
els.clearBtn.addEventListener('click', () => {
  stopPlayback({ reset: true });
  state.tracks = [];
  state.selected = null;
  blobCache.clear();
  renderTracks();
  renderTransport();
  log('Cleared.');
});
els.downloadAllBtn.addEventListener('click', saveAll);

function log(msg, kind) {
  const d = document.createElement('div');
  const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  d.innerHTML = `<span class="t">[${time}]</span> <span class="${kind || ''}">${esc(msg)}</span>`;
  els.log.appendChild(d);
  els.log.scrollTop = els.log.scrollHeight;
  while (els.log.children.length > 120) els.log.removeChild(els.log.firstChild);
}

/* boot */
window.__APP_READY__ = true;
syncOutputs();
renderTracks();
renderTransport();
log('Ready. Add tracks → Process → preview Orig / Clean / Master / Noise → Save or Download all.', 'ok');
log('Everything runs on this device. Nothing is uploaded anywhere.');

// Warn about the two environments where this app is knowingly limited.
const ua = navigator.userAgent || '';
const android = /Android/i.test(ua);
if (location.protocol === 'content:' || (location.protocol === 'file:' && android)) {
  log('Heads up: this copy is opened as a bare local file. Android Chrome restricts file picking, ' +
      'workers and audio decoding from file:// and content:// pages. Host the folder on any static ' +
      'host, or copy the whole folder to a desktop browser.', 'er');
}
if (location.protocol === 'file:' && !android) {
  log('Running from a local file. File picking works; use the hosted version if anything misbehaves.');
}
