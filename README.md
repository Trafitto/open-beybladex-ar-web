# Beyblade SFX Web Projection

This project is heavily vibe-coded and still in the testing phase.

Web-based SFX projection for [open_beybladex_ar_core](https://github.com/Trafitto/open-beybladex-ar-core). Receives tracking data via WebSocket and renders trails, glow, and impact effects for projector output.

![](test_video_output.gif)

## Setup

1. **Run the [core tracker](https://github.com/Trafitto/open-beybladex-ar-core) with `--web`:**
   ```bash
   cd ../open_beybladex_ar_core
   python main.py -w
   ```

2. **Serve this web app:**
   ```bash
   cd open_beybladex_ar_web
   python -m http.server 8080
   ```

3. **Open in browser:** http://localhost:8080

4. **Fullscreen on projector:** Press F11 or use a second display. Point the browser window to the projector output.

## Query params

- `?flipY=1` - Flip Y axis (for bottom projector projecting upward)

## Project structure

| File | Role |
|------|-----|
| `index.html` | Entry point |
| `css/style.css` | Fullscreen canvas, status |
| `js/app.js` | WebSocket client, trail/glow/impact rendering |
