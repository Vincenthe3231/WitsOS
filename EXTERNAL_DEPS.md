# External Dependencies

WitsOS bundles all Node dependencies. The following system binaries must be installed separately for media extraction features.

## Required for video extraction (Phase 6c)

- **ffmpeg** + **ffprobe** (must be from same installation)
  - Windows: `winget install FFmpeg`
  - macOS: `brew install ffmpeg`
  - Linux: `apt install ffmpeg` / `dnf install ffmpeg`
  - Manual: https://ffmpeg.org/download.html
  - Verify: `ffprobe -version`

## Required for audio STT (Phase 6b)

- **ffmpeg** (same as above — needed for audio decode)
- STT must be enabled in `.witsos/WitsOS.json` and configured:
  ```json
  "stt": {
    "enabled": true,
    "model": "base",
    "maxDurationSecs": 1800
  }
  ```
  - `maxDurationSecs` (default 1800 = 30 min): skip STT on longer videos to avoid blocking indexing

## Optional

- **`ffmpeg-static`** npm package — bundles ffmpeg/ffprobe, WitsOS auto-detects it (no PATH setup needed):
  ```bash
  npm install ffmpeg-static
  ```
  > Note: GPL-3.0 licensed — not bundled by WitsOS by default.
