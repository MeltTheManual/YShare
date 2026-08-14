# YShare launch teaser — "The Journey" (owner-approved 2026-07-16)

`YShare-teaser.mp4` is the approved 26-second launch teaser: 1920x1080, 30 fps,
H.264 + AAC. Pure brand film — darkness, the serif Y letterform, an orange ember
travelling a dashed route (FROM YOU → TO THEM), "Nothing in between.", then the
name and COMING SOON. No app UI is shown; the score is synthesized in-house
(no licensed music).

## How it is made (fully scriptable, no video tools)

- `teaser.html` — the film as a deterministic timeline: `window.FILM.SEEK(t)`
  lays out every element for time `t`; nothing animates on its own, so every
  rendered frame is exact and reproducible. Cinematic dressing (letterbox
  mattes, grain, vignette, breathing glow) is part of the page.
- `render-main.js` — Electron runner: loads the film in an off-desktop window,
  seeks frame by frame, captures via CDP `Page.captureScreenshot` with a fixed
  1920x1080 clip (immune to window clamping), writes JPEG frames.
- `preview-main.js` — same, but renders a few chosen timestamps as stills for
  review before committing to a full render.
- `audio-gen.js` — the score, composed in code: breathing drone, felt-piano
  notes, sub swells, a gliding tone that pans with the ember, shimmer bloom on
  the reveal. Writes a 44.1 kHz 16-bit stereo WAV.
- `assets/fonts/` — the brand TTFs the film needs (copied from
  `mobile/assets/fonts`, OFL-licensed).

## Rebuild the MP4

```powershell
cd <the repository root>
$env:FILM_FILE = "teaser.html"
npx electron marketing\teaser\render-main.js marketing\teaser frames_out 30
node marketing\teaser\audio-gen.js score.wav
ffmpeg -framerate 30 -i frames_out\f%04d.jpg -i score.wav `
  -c:v libx264 -preset slow -crf 17 -pix_fmt yuv420p -movflags +faststart `
  -c:a aac -b:a 192k -shortest YShare-teaser.mp4
```

(The renderer needs the repo's Electron; ffmpeg via `winget install Gyan.FFmpeg`.)

## History

Four concepts were produced on 2026-07-15/16 before the owner locked this one:
a story-driven "claim ticket" cut with real app footage, a fast X-style hype cut,
a premium teaser that still showed app screens, and this final pure-brand
version (no screens, no filled-orange shapes — orange only as light and ink).
The earlier cuts and their real-footage assets live outside the repository.
