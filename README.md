# Music Cleanup Studio

A working clone of the idea behind `musiccleanerpro.musictechtools.xyz`: **strip the broadband
static/hiss out of AI-generated music in the browser, then save the Clean and/or Mastered file.**

Everything runs on the device. No uploads, no server, no account, no paywall.

![screenshot](test/artifacts/ui-after.png)

---

## How to open it (read this first)

There are two ways, and **picking the wrong one is the most common way to break it**:

| You want | Open this |
|---|---|
| **Just use it** (recommended) | `standalone/music-cleanup-studio.html` — one file with everything inside. Works offline, works from desktop Chrome, Edge, Firefox, Safari. |
| **Edit the source** | Run a local server in this folder: `python3 -m http.server 8080` → <http://localhost:8080> |

⚠️ **Do not** copy `index.html` somewhere on its own. It is not self-contained — it needs
`styles.css`, `app.js`, `zip.js`, `src/` and `vendor/` beside it (that is why it renders as a
bare white page with system styling). If it is opened alone it now says so at the top of the page
instead of failing silently.

⚠️ **Android Chrome cannot run this from a `file://` or `content://` URL.** File picking, Web
Workers and audio decoding are all restricted in that context, so uploads and processing die.
Host the folder on any static host (Netlify drop, Cloudflare Pages, GitHub Pages, S3, a VPS) and
open the `https://` URL — it then works on Android, iOS, desktop, everything.

## What it does

- **Batch import** WAV / MP3 / FLAC / OGG / M4A by drag-and-drop or file picker.
- **Keeps your sample rate.** Chrome and Android force the `AudioContext` to 48 kHz, which silently
  resampled 44.1 kHz uploads. The container header is now peeked before decoding and an
  `OfflineAudioContext` is opened at the file's own rate, so 44.1 kHz in stays 44.1 kHz out.
- **Spectral cleanup** — STFT spectral subtraction with a noise profile taken from the quietest
  frames of each track. Phase is preserved, so duration, alignment, channel count and sample rate
  come out exactly as they went in.
- **Four presets** (Light / Balanced / Strong / Surgical) plus manual strength, noise-profile size,
  max cut per bin and temporal smoothing.
- **Master stage** (optional) — 28 Hz rumble filter, air shelf, glue compression and a −1 dBFS
  limiter with capped auto gain.
- **Honest progress** — the pill shows the real stage and percentage (`analysing`, `cleaning`,
  `mastering`) plus elapsed seconds, and a timer keeps ticking between worker messages.
- **A/B monitoring** — switch Original / Clean / Mastered / Removed-noise mid-playback, at the same
  position, to hear exactly what the process did.
- **Export** WAV 24-bit, WAV 16-bit, MP3 320 or MP3 192, Clean / Mastered / both, single files or
  one **.zip** for the batch.

## Performance (measured, 3:00 stereo 44.1 kHz track)

| stage | time | note |
|---|---|---|
| decode + import | 0.4 s | keeps 44.1 kHz |
| clean | **4.2 s** | 43× realtime, one worker |
| master | 2.1 s | |
| MP3 320 export | 13.5 s | lamejs, produces the full 180 s |

On a mid-range phone expect roughly **15–40× realtime** — so about 5–12 s per minute of stereo
audio. Long tracks are fine; the UI stays responsive and the progress is real.

Two optimisations that made the difference: a **real-input FFT** (a length-N real signal only needs
a complex FFT of length N/2 — 1.6× faster, verified sample-exact against the direct method) and
removing a per-frame array allocation in the statistics loop.

## How the cleanup works

```
decode (WebAudio, at the file's own sample rate)
  →  STFT (Hann, 75 % overlap, real-input radix-2 FFT)
  →  noise profile = mean power spectrum of the quietest 12 % of frames
  →  per-bin gain  g = sqrt(1 − α · N(f) / |X(f)|²), floored at −12 dB
  →  temporal smoothing of the gain curve (kills "musical noise" warble)
  →  inverse STFT with the original phase  →  clean
  →  residual = original − clean           →  the "Noise" monitor
  →  master: high-pass → air shelf → glue comp → auto gain → limiter
```

Measured on synthetic "noisy AI music" (`node test/dsp.test.js`):

| | before | after |
|---|---|---|
| static energy 2–20 kHz | ref | **−6 to −9 dB** |
| music body 0–2 kHz | ref | −0.4 dB (essentially untouched) |
| waveform correlation with the original music | — | **0.993** |
| speed (desktop headless Chromium) | — | 35–70× realtime |

## Architecture

```
index.html            UI shell (+ a banner if opened without its support files)
styles.css            styling, responsive transport dock
app.js                UI controller: import, batch queue, A/B transport, export
src/dsp.js            engine — FFT/rFFT, spectral subtraction, master chain, WAV encoder (no deps)
src/cleanup.worker.js runs dsp.js off the main thread; chunked transfers; MP3 encoding
zip.js                dependency-free STORE-only ZIP writer (blob based, flat memory)
build.js              bundles everything into standalone/music-cleanup-studio.html
```

Design notes:

- **Nothing blocks the UI.** Analysis, mastering and encoding run in a Module Worker with real
  progress and a working Stop button.
- **Big files are handled in 1 MB chunks.** Results come back as chunked transfers that are
  reassembled in the page, so multi-minute stereo files do not depend on single large
  structured-clone payloads (a common mobile Safari crash).
- **Memory** — tracks are `Float32Array`s, the source `AudioBuffer` is dropped after import, and
  the ZIP is assembled from blobs rather than one giant typed array. A 3-minute stereo track peaks
  around 250 MB of JS heap in headless Chromium.

## Tests

```bash
node test/dsp.test.js        # engine: SNR, speed, WAV sizes, master peak
node test/make-test-audio.js # regenerate the short noisy clips
node test/make-long-audio.js # regenerate the 3-minute stereo clip

# browser tests need `python3 -m http.server 8080` running and playwright installed
node test/smoke.test.js      # boots, every UI function exists, every control is safe to click
node test/full.test.js       # presets, staleness, 4 formats, zip CRC, remove, no errors
node test/playback.test.js   # transport: pause/resume, seek, A/B, keyboard, volume
node test/bigfile.test.js    # 3-min stereo: real progress, memory, MP3 export, playback
node test/standalone.test.js # the offline single-file build, end to end
node test/bootfail.test.js   # index.html opened alone explains what is missing
node test/shots.js           # desktop + mobile screenshots
```

`smoke.test.js` exists because a refactor once deleted `processAll()` and a variable declaration —
the page loaded fine and only threw when you clicked. CSP-style "does it boot and survive clicks"
coverage catches that class of bug in seconds.

## Known limits (honest list)

- **Broadband static is the target.** It is not a source separator: it will not pull a vocal out of
  a mix, and it cannot restore detail that was never there.
- Heavy settings on bright material can dull cymbals — that is what A/B is for.
- Files with no quiet frames fall back to a flatter noise profile; raise "Noise profile".
- MP3 export uses lamejs (320/192 kbps). WAV is lossless and the better archive.
- Very long batches are bounded by memory, not CPU: a 10-minute stereo track needs ~250 MB.
- `file://` on Android is unsupported (see above). iOS Safari works from a hosted URL.

## If you want to sell it

The original gates the tool behind 5-day / 30-day / lifetime passes via Stripe. That is deliberately
**not** in here. If you go that route, keep the DSP client-side and put only the entitlement check
on a server (Stripe Checkout → webhook → signed licence token in localStorage) — otherwise you turn
a zero-cost static site into something you have to host and police.
