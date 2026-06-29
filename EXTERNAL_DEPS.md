# External Dependencies

WitsOS bundles all Node dependencies. The following system binaries must be installed separately for media extraction features.

## Required for video extraction (Phase 6c)

- **ffmpeg** + **ffprobe** (must be from same installation)
  - Windows: `winget install FFmpeg`
  - macOS: `brew install ffmpeg`
  - Linux: `apt install ffmpeg` / `dnf install ffmpeg`
  - Manual: https://ffmpeg.org/download.html
  - Verify: `ffprobe -version`

## Audio extraction behavior (Phase 6c-2: STT)

**Subtitle priority** (checked in order):
1. Sidecar subtitle files (`.srt`, `.vtt` next to video)
2. Embedded subtitle tracks (demux from video)
3. Audio transcription via STT (only if no subtitles found)

STT runs **only when**:
- `stt.enabled = true` in `.witsos/WitsOS.json`
- Video has NO subtitles (steps 1–2 both failed)
- Video duration ≤ `maxDurationSecs` (default 1800 = 30 min)

**Config:**
```json
"stt": {
  "enabled": true,
  "model": "base",
  "maxDurationSecs": 1800
}
```

**Required binary:** ffmpeg (for audio decode)

## Optional

- **`ffmpeg-static`** npm package — bundles ffmpeg/ffprobe, WitsOS auto-detects it (no PATH setup needed):
  ```bash
  pnpm install ffmpeg-static
  ```
  > Note: GPL-3.0 licensed — not bundled by WitsOS by default.
