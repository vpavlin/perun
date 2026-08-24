# 5. Replay → video: an offline WebView canvas recorded with MediaRecorder

- **Status:** accepted
- **Date:** 2026-08-24

## Context

Users want to share a run's Replay as a video (Instagram / YouTube / TikTok). The animation
is already a pure function of the run data (track + annotations), so we can render it
deterministically at any size/framerate rather than screen-recording a shaky capture. The
question was *how to encode a video on the phone*, ideally staying local-first/offline like
the rest of the app.

## Decision

Render the Replay to a **canvas inside a WebView** and record it with **`MediaRecorder`**
(`canvas.captureStream()` → WebM). See `lib/replayVideoHtml.ts` (the renderer) and
`components/ReplayVideo.tsx` (the RN host).

- **Deterministic, not a screen capture.** The renderer redraws the run from the data each
  frame, so quality/size/pacing are controllable and the output is clean.
- **Fully offline + self-contained.** No CDN, no web fonts, **no map tiles** — the route is
  drawn on a plain black background (Perun's "hide map" look). Photos and voice notes are
  embedded as **data URIs**, read from the device's **local** blob store only (what isn't
  on-device is simply omitted). Nothing touches the network.
- **RN ↔ WebView handshake:** page posts `ready` → RN injects the payload via `__setRun`
  (PREP: build model, preload images, decode audio, build the schedule) → page posts
  `prepared` (with the estimated length) → RN shows the frame/pace controls → **Start**
  (`__start`) records → `progress` stream → `done` (base64 data URL) or `cancelled`. RN
  writes the WebM to a file and opens the share sheet.
- **Smooth speed schedule, not a hard stop.** A velocity profile (raised-cosine dips around
  each annotation) is integrated into a time→distance table, so the playhead *decelerates
  into / crawls through / accelerates out of* each annotation — enough time to read/listen,
  no choppy freeze. Each annotation gets a "read budget" (a voice note gets its full length).
- **Voice notes are in the video.** Each is decoded into a shared `AudioContext` whose
  `MediaStreamDestination` is captured **alongside** the canvas (WebM `vp8,opus`), and fired
  as the playhead enters its slow zone. Best-effort — any audio failure degrades to a silent
  clip.
- **Aspect ratio + pace are user controls.** 1:1 / 16:9 / 9:16 (overlays lay out relative to
  the shorter side, `U=min(W,H)`); a pace slider scales cruise time (protecting voice length).

## Rejected

- **Screen recording** — shaky, low quality, manual, not a shareable file.
- **On-device native encoding (ffmpeg)** — `ffmpeg-kit-react-native` was archived; an
  unmaintained native encoder is a liability. The WebView `MediaRecorder` path needs no
  native code beyond `react-native-webview`.
- **Desktop-only rendering** — the desktop module could render higher quality, but the phone
  is where runs and media live; keep it on-device.
- **Baking in a map basemap** — deferred behind an opt-in switch: tiles need network (breaks
  offline) **and** drawing cross-origin tiles onto the canvas *taints* it, which **blocks**
  `captureStream`/MediaRecorder. A map variant must use CORS-enabled tiles
  (`crossOrigin="anonymous"`) and is isolated from this default so it can't break the export.

## Consequences

- **The load-bearing dependency is the Android System WebView's `MediaRecorder` support** —
  it varies by WebView version; on a device that can't record, the UI reports it and the
  render simply doesn't produce a file. This is the first thing to check on a new device.
- **The finished WebM crosses the RN bridge as base64** (a data URL). Size is kept sane
  (≤~1080p, few-Mbps, pace-controlled length); a very long/large clip stresses the bridge.
- **Output is WebM.** It plays widely, but is **not** iOS-camera-roll-native — an MP4
  transcode is a future add.
- Media is embedded from the **local** store, so cross-device photos/voice only appear in the
  video on the device that has them (consistent with the blob local-first model, ADR 0002).
- The renderer is reusable: the same code could run as a standalone HTML (see
  `tools/replay-video/`) or, with a CORS-safe tile layer, gain the opt-in map background.
