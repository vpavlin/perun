# Replay → video (proof of concept)

Turn a Perun run's Replay into a shareable video — **completely offline**.

## Try it
Open **`replay.html`** in a browser (Chrome or Firefox), with a plain `file://` URL — it
needs **nothing from the internet**. It draws a sample run, then:
- **▶ Preview** — play the animation on the canvas.
- **⏺ Record video** — renders the animation while capturing the canvas with
  `MediaRecorder`, and downloads a **`perun-replay.webm`** at the end.

Options: clip **duration**, and whether the route is drawn progressively or shown full.

## Why it's offline / self-contained
- No CDN, no web fonts, **no map tiles** — the route is drawn on a plain dark background
  (Perun's "hide map" look), so there's zero network dependency.
- The animation is rendered **deterministically from the run data** (the same mercator
  projection + cumulative-distance model the app uses), not screen-recorded.
- Media (a sample photo) is embedded as a data URI. Recording is `canvas.captureStream()`
  → `MediaRecorder` → a WebM Blob, all in-browser.

## How this becomes a real feature
This renderer is fed a hard-coded **sample run**. To ship it, generate the same page (or
run the same renderer in an in-app WebView) with a real run injected: its exported GPX
points + its annotations, with photo/voice bytes embedded as data URIs. A "Share video"
button would produce the WebM the same way. WebM plays everywhere; add a transcode step if
you want MP4 for the iOS camera roll.

Next steps worth doing: play each **voice note as the playhead reaches it** (MediaRecorder
can capture a canvas + an audio track together, so the memos land in the video at the right
moment); optionally embed pre-fetched map tiles for a basemap.

Notes: keep the tab focused while recording (background tabs throttle `requestAnimationFrame`,
which stalls capture). Needs a browser with `MediaRecorder` + WebM (Chrome/Firefox; Safari
support is spottier).
