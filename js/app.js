(function () {
  "use strict";

  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");
  const statusEl = document.getElementById("status");
  const calibHud = document.getElementById("calib-hud");
  const calibInfo = document.getElementById("calib-info");

  const params = new URLSearchParams(window.location.search);
  const WS_URL = params.get("ws") || "ws://127.0.0.1:8765";
  let flipX = params.get("flipX") === "1" || params.get("flipX") === "true";
  let flipY = params.get("flipY") === "1" || params.get("flipY") === "true";

  /* Load saved calibration from sessionStorage; URL params override. */
  const CALIB_STORAGE_KEY = "beyblade_calib";
  function loadCalibSession() {
    try {
      const raw = sessionStorage.getItem(CALIB_STORAGE_KEY);
      return raw ? JSON.parse(raw) : {};
    } catch (_) { return {}; }
  }
  function saveCalibSession() {
    try {
      sessionStorage.setItem(CALIB_STORAGE_KEY, JSON.stringify({
        offsetX: calib.offsetX,
        offsetY: calib.offsetY,
        scale:   calib.scale,
        rotate:  calib.rotate,
        flipX:   flipX,
        flipY:   flipY,
      }));
    } catch (_) {}
  }

  const saved = loadCalibSession();
  if (!params.has("flipX") && saved.flipX) flipX = true;
  if (!params.has("flipY") && saved.flipY) flipY = true;
  const calib = {
    active:  params.get("calibrate") === "1" || params.get("calibrate") === "true",
    offsetX: parseFloat(params.get("offsetX")) || saved.offsetX || 0,
    offsetY: parseFloat(params.get("offsetY")) || saved.offsetY || 0,
    scale:   Math.max(0.1, parseFloat(params.get("scale")) || saved.scale || 1),
    rotate:  params.has("rotate")
      ? (parseFloat(params.get("rotate")) || 0) * Math.PI / 180
      : (saved.rotate ?? 0),
  };

  /* Effect settings from js/config.js; falls back to defaults if config missing */
  const config = (typeof BEYBLADE_EFFECT_CONFIG !== "undefined" && BEYBLADE_EFFECT_CONFIG) || {};
  const TRAIL_MAX_LEN = config.trailMaxLength ?? 60;
  const IMPACT_DURATION_MS = config.impactDurationMs ?? 200;

  let state = {
    frameWidth: 1280,
    frameHeight: 720,
    beys: [],
    collision: false,
    impactCenter: { x: 0, y: 0, nx: 0, ny: 0 },
    pocketAngleRad: null,
    stadiumRelative: false,
  };

  const trails = { 0: [], 1: [] };
  let impactStart = 0;
  let isConnected = false;
  let lastTrailUpdate = 0;
  const TRAIL_STALE_MS = 6000;

  function clearTrails() {
    trails[0].length = 0;
    trails[1].length = 0;
  }

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener("resize", resize);
  resize();

  function setStatus(msg, ok) {
    isConnected = ok;
    statusEl.textContent = msg;
    statusEl.className = ok ? "connected" : "disconnected";
  }

  function updateCalibInfo() {
    const deg = (calib.rotate * 180 / Math.PI).toFixed(1);
    let info =
      "scale=" + calib.scale.toFixed(2) +
      " offX=" + calib.offsetX.toFixed(2) +
      " offY=" + calib.offsetY.toFixed(2) +
      " rot=" + deg +
      (flipX ? " <b>flipX</b>" : "") +
      (flipY ? " <b>flipY</b>" : "");
    if (state.stadiumRelative) info += "<br>stadium-relative";
    if (state.pocketAngleRad != null) {
      info += " pocket=" + (state.pocketAngleRad * 180 / Math.PI).toFixed(1) + "deg";
    }
    calibInfo.innerHTML = info;
  }

  function normToCanvas(nx, ny) {
    const w = canvas.width;
    const h = canvas.height;
    const side = Math.min(w, h);

    let dx = (nx - 0.5) * calib.scale * side;
    let dy = (ny - 0.5) * calib.scale * side;

    if (calib.rotate !== 0) {
      const cos = Math.cos(calib.rotate);
      const sin = Math.sin(calib.rotate);
      const rx = dx * cos - dy * sin;
      const ry = dx * sin + dy * cos;
      dx = rx;
      dy = ry;
    }

    let x = 0.5 * w + dx + calib.offsetX * side;
    let y = 0.5 * h + dy + calib.offsetY * side;
    if (flipX) x = w - x;
    if (flipY) y = h - y;
    return { x, y };
  }

  function drawLaserTrail(id, points, coreColor, glowColor) {
    if (points.length < 2) return;
    const positions = points.map((p) => normToCanvas(p.nx, p.ny));

    for (let i = 0; i < positions.length - 1; i++) {
      const t = (i + 1) / positions.length;
      const start = positions[i];
      const end = positions[i + 1];
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const len = Math.sqrt(dx * dx + dy * dy) || 1;
      const perpX = -dy / len;
      const perpY = dx / len;

      const trail = config.trail || {};
      const glowWidth = (trail.glowWidthMin ?? 6) + ((trail.glowWidthMax ?? 20) - (trail.glowWidthMin ?? 6)) * t;
      const coreWidth = (trail.coreWidthMin ?? 1) + ((trail.coreWidthMax ?? 3) - (trail.coreWidthMin ?? 1)) * t;

      ctx.save();
      ctx.globalAlpha = t * 0.9;

      ctx.beginPath();
      ctx.moveTo(start.x + perpX * glowWidth, start.y + perpY * glowWidth);
      ctx.lineTo(end.x + perpX * glowWidth, end.y + perpY * glowWidth);
      ctx.lineTo(end.x - perpX * glowWidth, end.y - perpY * glowWidth);
      ctx.lineTo(start.x - perpX * glowWidth, start.y - perpY * glowWidth);
      ctx.closePath();
      const glowGrad = ctx.createLinearGradient(start.x, start.y, end.x, end.y);
      glowGrad.addColorStop(0, glowColor.replace(/[\d.]+\)$/, "0)"));
      glowGrad.addColorStop(0.5, glowColor);
      glowGrad.addColorStop(1, glowColor.replace(/[\d.]+\)$/, "0)"));
      ctx.fillStyle = glowGrad;
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(start.x + perpX * coreWidth, start.y + perpY * coreWidth);
      ctx.lineTo(end.x + perpX * coreWidth, end.y + perpY * coreWidth);
      ctx.lineTo(end.x - perpX * coreWidth, end.y - perpY * coreWidth);
      ctx.lineTo(start.x - perpX * coreWidth, start.y - perpY * coreWidth);
      ctx.closePath();
      ctx.fillStyle = coreColor;
      ctx.fill();

      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  function drawBeyGlow(nx, ny, color, radiusNorm) {
    const { x, y } = normToCanvas(nx, ny);
    const r = Math.max(8, radiusNorm * 2);
    const grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, color);
    grad.addColorStop(0.5, color.replace("1)", "0.4)"));
    grad.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawAlignmentCross() {
    const cx = canvas.width / 2;
    const cy = canvas.height / 2;
    const len = Math.min(canvas.width, canvas.height) * 0.15;
    const gap = 8;

    function crossPath() {
      ctx.moveTo(cx - len, cy);
      ctx.lineTo(cx - gap, cy);
      ctx.moveTo(cx + gap, cy);
      ctx.lineTo(cx + len, cy);
      ctx.moveTo(cx, cy - len);
      ctx.lineTo(cx, cy - gap);
      ctx.moveTo(cx, cy + gap);
      ctx.lineTo(cx, cy + len);
    }

    ctx.save();
    ctx.lineCap = "round";

    ctx.beginPath();
    crossPath();
    ctx.strokeStyle = "rgba(0, 255, 120, 0.5)";
    ctx.lineWidth = 16;
    ctx.shadowColor = "rgba(0, 255, 150, 0.8)";
    ctx.shadowBlur = 25;
    ctx.stroke();

    ctx.beginPath();
    crossPath();
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.95)";
    ctx.lineWidth = 2;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, gap, 0, Math.PI * 2);
    ctx.strokeStyle = "rgba(0, 255, 120, 0.4)";
    ctx.lineWidth = 12;
    ctx.shadowColor = "rgba(0, 255, 150, 0.6)";
    ctx.shadowBlur = 12;
    ctx.stroke();

    ctx.beginPath();
    ctx.arc(cx, cy, gap, 0, Math.PI * 2);
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.9)";
    ctx.lineWidth = 1;
    ctx.stroke();

    ctx.restore();
  }

  function drawCalibrationOverlay() {
    const side = Math.min(canvas.width, canvas.height);
    const r = calib.scale * side * 0.5;
    const cx = canvas.width * 0.5 + calib.offsetX * side;
    const cy = canvas.height * 0.5 + calib.offsetY * side;
    const rot = calib.rotate;

    ctx.save();

    /* Stadium circle (white, thick, high contrast for bright environments) */
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 3;
    ctx.setLineDash([10, 8]);
    ctx.stroke();
    ctx.setLineDash([]);

    /* Center crosshair */
    const ch = 18;
    ctx.beginPath();
    ctx.moveTo(cx - ch, cy); ctx.lineTo(cx + ch, cy);
    ctx.moveTo(cx, cy - ch); ctx.lineTo(cx, cy + ch);
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 2;
    ctx.stroke();

    /* Cardinal ticks around the rim (every 30 degrees) */
    const tickInner = 0.92;
    const tickOuter = 1.08;
    ctx.strokeStyle = "rgba(255, 255, 255, 0.6)";
    ctx.lineWidth = 2;
    for (let i = 0; i < 12; i++) {
      const a = rot + (i * Math.PI * 2) / 12;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(cx + cos * r * tickInner, cy + sin * r * tickInner);
      ctx.lineTo(cx + cos * r * tickOuter, cy + sin * r * tickOuter);
      ctx.stroke();
    }

    /* 4 corner dots at N/S/E/W (thicker ticks) */
    ctx.strokeStyle = "#fff";
    ctx.lineWidth = 3;
    for (let i = 0; i < 4; i++) {
      const a = rot + (i * Math.PI) / 2;
      const cos = Math.cos(a);
      const sin = Math.sin(a);
      ctx.beginPath();
      ctx.moveTo(cx + cos * r * 0.86, cy + sin * r * 0.86);
      ctx.lineTo(cx + cos * r * tickOuter, cy + sin * r * tickOuter);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx + cos * r, cy + sin * r, 5, 0, Math.PI * 2);
      ctx.fillStyle = "#fff";
      ctx.fill();
    }

    /* Pocket arrow -- points outward at 12 o'clock (before rotation).
     * Rotate with R/E until it matches the physical pocket. */
    const pocketAngle = rot - Math.PI / 2;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(pocketAngle);

    const arrowTip = -r * 1.14;
    const arrowBase = -r * 0.92;
    const arrowHalf = r * 0.06;

    ctx.beginPath();
    ctx.moveTo(0, arrowTip);
    ctx.lineTo(-arrowHalf, arrowBase);
    ctx.lineTo(arrowHalf, arrowBase);
    ctx.closePath();
    ctx.fillStyle = "rgba(255, 200, 0, 0.9)";
    ctx.fill();

    ctx.font = "11px monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("POCKET", 0, arrowTip - 12);

    ctx.restore();

    /* Flip indicators */
    if (flipX || flipY) {
      ctx.font = "bold 16px monospace";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "rgba(255, 80, 80, 1)";
      const tags = [];
      if (flipX) tags.push("FLIP X");
      if (flipY) tags.push("FLIP Y");
      ctx.fillText(tags.join("  |  "), cx, cy + r * 0.15);
    }

    ctx.restore();

    /* Alignment test markers -- these go through normToCanvas() so they
     * follow the EXACT same transform as bey trails. If these dots land
     * on the right physical spots, the trails will too. */
    const markers = [
      { nx: 0.5,  ny: 0.5,  label: "CENTER", color: "#ff0" },
      { nx: 0.5,  ny: 0.0,  label: "TOP",    color: "#fff" },
      { nx: 0.5,  ny: 1.0,  label: "BOT",    color: "#fff" },
      { nx: 0.0,  ny: 0.5,  label: "LEFT",   color: "#fff" },
      { nx: 1.0,  ny: 0.5,  label: "RIGHT",  color: "#fff" },
    ];

    ctx.save();
    ctx.font = "bold 12px monospace";
    ctx.textAlign = "center";
    for (const m of markers) {
      const p = normToCanvas(m.nx, m.ny);
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = m.color;
      ctx.fill();
      ctx.fillText(m.label, p.x, p.y - 14);
    }

    /* Pocket marker via normToCanvas -- if core sends pocketAngleRad,
     * show where the pocket should project */
    if (state.pocketAngleRad != null) {
      const pa = state.pocketAngleRad;
      const pnx = 0.5 + 0.5 * Math.cos(pa);
      const pny = 0.5 + 0.5 * Math.sin(pa);
      const pp = normToCanvas(pnx, pny);
      ctx.beginPath();
      ctx.arc(pp.x, pp.y, 8, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(255, 100, 0, 0.9)";
      ctx.fill();
      ctx.fillStyle = "#ff6400";
      ctx.fillText("POCKET(cam)", pp.x, pp.y - 16);
    }
    ctx.restore();

    updateCalibHud();
  }

  function updateCalibHud() {
    const deg = (calib.rotate * 180 / Math.PI).toFixed(1);
    const url = buildCalibURL();
    calibHud.innerHTML =
      "-- CALIBRATION (C to toggle) --<br>" +
      "Arrows: move &nbsp; +/-: scale<br>" +
      "R/E: rotate &nbsp; Shift: fine<br>" +
      "Q: flip X &nbsp; W: flip Y<br><br>" +
      "scale=" + calib.scale.toFixed(2) +
      " &nbsp;offX=" + calib.offsetX.toFixed(2) +
      " &nbsp;offY=" + calib.offsetY.toFixed(2) +
      " &nbsp;rot=" + deg +
      " &nbsp;flipX=" + flipX +
      " &nbsp;flipY=" + flipY + "<br><br>" +
      '<a href="' + url + '">' + url + "</a>";
  }

  function buildCalibURL() {
    const base = location.origin + location.pathname;
    const p = new URLSearchParams();
    if (flipX) p.set("flipX", "1");
    if (flipY) p.set("flipY", "1");
    p.set("scale", calib.scale.toFixed(2));
    p.set("offsetX", calib.offsetX.toFixed(2));
    p.set("offsetY", calib.offsetY.toFixed(2));
    const deg = calib.rotate * 180 / Math.PI;
    if (Math.abs(deg) > 0.05) p.set("rotate", deg.toFixed(1));
    return base + "?" + p.toString();
  }

  /* Keyboard calibration controls */
  window.addEventListener("keydown", function (e) {
    const step = e.shiftKey ? 0.005 : 0.02;
    const scaleStep = e.shiftKey ? 0.01 : 0.05;
    const rotStep = e.shiftKey ? 0.5 : 2;
    let handled = false;

    if (e.key === "c" || e.key === "C") {
      calib.active = !calib.active;
      calibHud.className = calib.active ? "" : "hidden";
      if (calib.active) updateCalibHud();
      handled = true;
    }

    if (e.key === "x" || e.key === "X") {
      clearTrails();
      handled = true;
    }

    if (e.key === "q" || e.key === "Q") { flipX = !flipX; handled = true; }
    if (e.key === "w" || e.key === "W") { flipY = !flipY; handled = true; }

    if (!calib.active) {
      if (handled) { e.preventDefault(); saveCalibSession(); }
      return;
    }

    switch (e.key) {
      case "ArrowLeft":  calib.offsetX -= step; handled = true; break;
      case "ArrowRight": calib.offsetX += step; handled = true; break;
      case "ArrowUp":    calib.offsetY -= step; handled = true; break;
      case "ArrowDown":  calib.offsetY += step; handled = true; break;
      case "+": case "=": calib.scale = Math.min(3, calib.scale + scaleStep); handled = true; break;
      case "-": case "_": calib.scale = Math.max(0.1, calib.scale - scaleStep); handled = true; break;
      case "r":          calib.rotate += rotStep * Math.PI / 180; handled = true; break;
      case "e":          calib.rotate -= rotStep * Math.PI / 180; handled = true; break;
    }

    if (handled) {
      e.preventDefault();
      saveCalibSession();
    }
  });

  function drawImpact(nx, ny, progress) {
    const { x, y } = normToCanvas(nx, ny);
    const impact = config.impact || {};
    const r = (impact.radiusStart ?? 40) + progress * ((impact.radiusEnd ?? 140) - (impact.radiusStart ?? 40));
    const rayCount = impact.rayCount ?? 24;
    const baseColor = impact.strokeColor || "rgba(255, 200, 100, 1)";
    const alpha = 1 - progress;

    ctx.save();
    ctx.strokeStyle = baseColor.replace(/[\d.]+\)$/, alpha + ")");
    ctx.lineWidth = impact.lineWidth ?? 2;
    ctx.lineCap = "round";

    for (let i = 0; i < rayCount; i++) {
      const angle = (Math.PI * 2 * i) / rayCount;
      const lenVariation = 0.5 + 0.5 * (Math.sin(i * 1.7) * 0.5 + 0.5);
      const rayLen = r * lenVariation;
      ctx.beginPath();
      ctx.moveTo(x, y);
      ctx.lineTo(x + Math.cos(angle) * rayLen, y + Math.sin(angle) * rayLen);
      ctx.stroke();
    }
    ctx.restore();
  }

  function render() {
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const now = Date.now();

    const laserRed = config.laserRed || { core: "rgba(255, 50, 50, 1)", glow: "rgba(255, 80, 80, 0.6)", beyGlow: "rgba(255, 80, 80, 1)" };
    const laserBlue = config.laserBlue || { core: "rgba(80, 150, 255, 1)", glow: "rgba(100, 180, 255, 0.6)", beyGlow: "rgba(100, 180, 255, 1)" };

    for (const b of state.beys) {
      const laser = b.id === 0 ? laserRed : laserBlue;
      drawBeyGlow(b.nx, b.ny, laser.beyGlow || laser.glow, 0.03);
    }

    if (lastTrailUpdate > 0 && now - lastTrailUpdate > TRAIL_STALE_MS) {
      clearTrails();
      lastTrailUpdate = 0;
    }

    for (let id of [0, 1]) {
      const arr = trails[id];
      if (arr.length > 0) {
        const laser = id === 0 ? laserRed : laserBlue;
        drawLaserTrail(id, arr, laser.core, laser.glow);
      }
    }

    if (state.collision) {
      impactStart = now;
    }
    if (impactStart > 0) {
      const elapsed = now - impactStart;
      if (elapsed < IMPACT_DURATION_MS) {
        const progress = elapsed / IMPACT_DURATION_MS;
        drawImpact(state.impactCenter.nx, state.impactCenter.ny, progress);
      } else {
        impactStart = 0;
      }
    }

    if (!isConnected) {
      drawAlignmentCross();
    }

    if (calib.active) {
      drawCalibrationOverlay();
    }

    updateCalibInfo();
    requestAnimationFrame(render);
  }

  function onMessage(msg) {
    try {
      const data = JSON.parse(msg);
      state.frameWidth = data.frameWidth || 1280;
      state.frameHeight = data.frameHeight || 720;
      state.beys = data.beys || [];
      state.collision = !!data.collision;
      state.impactCenter = data.impactCenter || { nx: 0.5, ny: 0.5 };
      state.stadiumRelative = !!data.stadiumRelative;
      if (data.pocketAngleRad != null) state.pocketAngleRad = data.pocketAngleRad;

      for (const b of state.beys) {
        const arr = trails[b.id] || (trails[b.id] = []);
        arr.push({ nx: b.nx, ny: b.ny });
        if (arr.length > TRAIL_MAX_LEN) arr.shift();
      }
      if (state.beys.length > 0) lastTrailUpdate = Date.now();
    } catch (_) {}
  }

  function connect() {
    setStatus("Connecting...", false);
    const ws = new WebSocket(WS_URL);

    ws.onopen = () => setStatus("Connected", true);
    ws.onclose = () => {
      setStatus("Disconnected - reconnect in 2s", false);
      setTimeout(connect, 2000);
    };
    ws.onerror = () => {};
    ws.onmessage = (e) => onMessage(e.data);
  }

  if (calib.active) {
    calibHud.className = "";
    updateCalibHud();
  }
  connect();
  render();
})();
