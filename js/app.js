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
        distort: calib.distort,
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
    /* Radial distortion: compensates for the stadium bowl curvature.
     * Positive = push outer points outward (pincushion), useful when
     * the bowl makes projected rim markers fall short.
     * Negative = pull outer points inward (barrel). */
    distort: parseFloat(params.get("distort")) || saved.distort || 0,
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
    referenceMarkers: [],
    arenaRadiusPx: 0,
  };

  const trails = { 0: [], 1: [] };
  let impactStart = 0;
  let isConnected = false;
  let lastTrailUpdate = 0;
  const TRAIL_STALE_MS = 6000;
  let markerOnlyMode = false;

  let lastMessageTime = 0;
  let serverTimestamp = 0;

  /* Play-mode countdown state (populated from server payloads) */
  let playMode = null;
  let countdownPhaseStart = 0;
  let prevCountdownPhase = null;
  /* Fraction of velocity used for extrapolation (0 = disabled, 1 = full).
   * Keep < 1 to avoid overshooting on sudden direction changes. */
  const EXTRAPOLATION_FACTOR = 0.65;

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
      " rot=" + deg;
    if (calib.distort !== 0) info += " dist=" + calib.distort.toFixed(2);
    info += (flipX ? " <b>flipX</b>" : "") +
      (flipY ? " <b>flipY</b>" : "");
    if (state.stadiumRelative) info += "<br>stadium-relative";
    calibInfo.innerHTML = info;
  }

  function normToCanvas(nx, ny) {
    const w = canvas.width;
    const h = canvas.height;
    const side = Math.min(w, h);

    var cx = nx - 0.5;
    var cy = ny - 0.5;

    /* Radial distortion correction for bowl-shaped stadium.
     * Uses linear radial term for strong visible effect:
     *   r' = r * (1 + k * r)   where r = distance from center (0..~0.7)
     * k > 0 pushes rim outward; k < 0 pulls it inward. */
    if (calib.distort !== 0) {
      var r = Math.sqrt(cx * cx + cy * cy);
      if (r > 1e-6) {
        var factor = 1 + calib.distort * r;
        cx *= factor;
        cy *= factor;
      }
    }

    let dx = cx * calib.scale * side;
    let dy = cy * calib.scale * side;

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
    var positions = points.map(function (p) { return normToCanvas(p.nx, p.ny); });
    var trail = config.trail || {};
    var gwMax = trail.glowWidthMax ?? 32;
    var cwMax = trail.coreWidthMax ?? 16;
    var n = positions.length;

    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";

    /* Layer 1: outer bloom (wide, soft, dim) */
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = trail.bloomBlur ?? 18;
    for (var i = 0; i < n - 1; i++) {
      var t = (i + 1) / n;
      var t3 = t * t * t;
      ctx.globalAlpha = t3 * 0.35;
      ctx.strokeStyle = glowColor;
      ctx.lineWidth = gwMax * t3;
      ctx.beginPath();
      ctx.moveTo(positions[i].x, positions[i].y);
      ctx.lineTo(positions[i + 1].x, positions[i + 1].y);
      ctx.stroke();
    }
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;

    /* Layer 2: mid glow (colored, medium width) */
    for (var i = 0; i < n - 1; i++) {
      var t = (i + 1) / n;
      var t2 = t * t;
      ctx.globalAlpha = t2 * 0.7;
      ctx.strokeStyle = glowColor;
      ctx.lineWidth = (gwMax * 0.5) * t2;
      ctx.beginPath();
      ctx.moveTo(positions[i].x, positions[i].y);
      ctx.lineTo(positions[i + 1].x, positions[i + 1].y);
      ctx.stroke();
    }

    /* Layer 3: hot core (white-ish, thin, bright) */
    for (var i = 0; i < n - 1; i++) {
      var t = (i + 1) / n;
      var t2 = t * t;
      ctx.globalAlpha = t2 * 0.95;
      ctx.strokeStyle = coreColor;
      ctx.lineWidth = cwMax * t2;
      ctx.beginPath();
      ctx.moveTo(positions[i].x, positions[i].y);
      ctx.lineTo(positions[i + 1].x, positions[i + 1].y);
      ctx.stroke();
    }

    /* Layer 4: white-hot center line (very thin, full bright at head) */
    for (var i = Math.max(0, n - 6); i < n - 1; i++) {
      var t = (i + 1) / n;
      ctx.globalAlpha = t;
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = Math.max(2, cwMax * 0.3 * t);
      ctx.beginPath();
      ctx.moveTo(positions[i].x, positions[i].y);
      ctx.lineTo(positions[i + 1].x, positions[i + 1].y);
      ctx.stroke();
    }

    ctx.globalAlpha = 1;
    ctx.restore();
  }

  function drawBeyGlow(nx, ny, color, radiusNorm, speed) {
    var pos = normToCanvas(nx, ny);
    var x = pos.x, y = pos.y;
    var glow = config.beyGlow || {};
    var baseR = glow.baseRadius ?? 35;
    var speedScale = glow.speedScale ?? 0.3;
    var spd = speed || 0;
    var r = baseR + spd * speedScale;

    ctx.save();

    /* Outer bloom via shadowBlur -- very visible on projectors */
    ctx.shadowColor = color;
    ctx.shadowBlur = glow.bloomBlur ?? 30;
    ctx.globalAlpha = 0.6;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.4, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    /* Main radial gradient glow */
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    var grad = ctx.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, "#fff");
    grad.addColorStop(0.15, color);
    grad.addColorStop(0.5, color.replace(/[\d.]+\)$/, "0.4)"));
    grad.addColorStop(1, "rgba(0,0,0,0)");
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    /* Bright center dot */
    ctx.globalAlpha = 0.9;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(3, r * 0.12), 0, Math.PI * 2);
    ctx.fillStyle = "#fff";
    ctx.fill();

    ctx.restore();
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

    /* Distortion guide rings -- show where 25/50/75% radius land after
     * the radial correction, so the user can see the bowl warp in action. */
    if (calib.distort !== 0) {
      var rings = [0.25, 0.5, 0.75];
      ctx.setLineDash([4, 6]);
      for (var ri = 0; ri < rings.length; ri++) {
        var normR = rings[ri] * 0.5;
        var distR = normR * (1 + calib.distort * normR);
        var ringPx = distR * calib.scale * side;
        ctx.beginPath();
        ctx.arc(cx, cy, ringPx, 0, Math.PI * 2);
        ctx.strokeStyle = "rgba(255, 180, 0, 0.35)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

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

    ctx.restore();

    drawReferenceMarkers();
    updateCalibHud();
  }

  function drawReferenceMarkers() {
    var mCfg = config.markers || {};
    var rimColor = mCfg.rimColor || "rgba(0, 255, 100, 0.9)";
    var innerColor = mCfg.innerColor || "rgba(0, 200, 255, 0.8)";
    var centerColor = mCfg.centerColor || "rgba(255, 255, 0, 1)";
    var pocketColor = mCfg.pocketColor || "rgba(255, 100, 0, 1)";
    var markerSize = mCfg.size || 7;

    var refs = state.referenceMarkers;
    if (!refs || refs.length === 0) return;

    ctx.save();
    ctx.font = "bold 10px monospace";
    ctx.textAlign = "center";

    for (var i = 0; i < refs.length; i++) {
      var mk = refs[i];
      var p = normToCanvas(mk.nx, mk.ny);
      var color;
      var sz = markerSize;
      var label = "";

      if (mk.name === "center") {
        color = centerColor;
        sz = markerSize + 2;
        label = "CTR";
      } else if (mk.name === "pocket") {
        continue;
      } else if (mk.name.indexOf("rim") === 0) {
        color = rimColor;
        label = mk.name.replace("rim", "").substring(0, 1);
      } else {
        color = innerColor;
        sz = markerSize - 2;
      }

      /* Diamond shape for core markers */
      ctx.beginPath();
      ctx.moveTo(p.x, p.y - sz);
      ctx.lineTo(p.x + sz, p.y);
      ctx.lineTo(p.x, p.y + sz);
      ctx.lineTo(p.x - sz, p.y);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = "#fff";
      ctx.lineWidth = 1;
      ctx.stroke();

      if (label) {
        ctx.fillStyle = color;
        ctx.fillText(label, p.x, p.y - sz - 6);
      }
    }
    ctx.restore();
  }

  function updateCalibHud() {
    const deg = (calib.rotate * 180 / Math.PI).toFixed(1);
    const url = buildCalibURL();
    var modeTag = markerOnlyMode ? " <b>[MARKERS ONLY]</b>" : "";
    calibHud.innerHTML =
      "-- CALIBRATION (C to toggle) --" + modeTag + "<br>" +
      "Arrows: move &nbsp; +/-: scale<br>" +
      "R/E: rotate &nbsp; K/L: bowl distortion &nbsp; 0: reset dist<br>" +
      "Q: flip X &nbsp; W: flip Y &nbsp; M: markers only &nbsp; Shift: fine<br>" +
      "<br>" +
      "<b>Step 1:</b> +/- until circle matches stadium rim<br>" +
      "<b>Step 2:</b> Arrows until CTR lands on center<br>" +
      "<b>Step 3:</b> R/E to match TOP/BOT/LEFT/RIGHT orientation<br>" +
      "<b>Step 4:</b> Q/W if trails move opposite<br>" +
      "<b>Step 5:</b> K/L to fix rim markers (bowl curve correction)<br>" +
      "<br>" +
      "scale=" + calib.scale.toFixed(2) +
      " &nbsp;offX=" + calib.offsetX.toFixed(2) +
      " &nbsp;offY=" + calib.offsetY.toFixed(2) +
      " &nbsp;rot=" + deg +
      " &nbsp;dist=" + calib.distort.toFixed(2) +
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
    if (Math.abs(calib.distort) > 0.01) p.set("distort", calib.distort.toFixed(2));
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

    if (e.key === "m" || e.key === "M") {
      markerOnlyMode = !markerOnlyMode;
      if (markerOnlyMode && !calib.active) {
        calib.active = true;
        calibHud.className = "";
      }
      handled = true;
    }

    if (e.key === "q" || e.key === "Q") { flipX = !flipX; handled = true; }
    if (e.key === "w" || e.key === "W") { flipY = !flipY; handled = true; }
    if (e.key === "k" || e.key === "K") {
      calib.distort = Math.max(-4, calib.distort - (e.shiftKey ? 0.02 : 0.1));
      handled = true;
    }
    if (e.key === "l" || e.key === "L") {
      calib.distort = Math.min(4, calib.distort + (e.shiftKey ? 0.02 : 0.1));
      handled = true;
    }
    if (e.key === "0") { calib.distort = 0; handled = true; }

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

  /* ── Play-mode countdown: stadium split + text ────────────────────── */

  function drawCountdownSplit() {
    if (!playMode || !playMode.active) return;
    var cd = config.countdown || {};
    var center = normToCanvas(0.5, 0.5);
    var rimPt = normToCanvas(0.5, 0.0);
    var arenaR = Math.abs(rimPt.y - center.y);
    var cx = center.x;
    var cy = center.y;

    ctx.save();

    /* Mirror horizontally for under-stadium projection */
    if (cd.mirror) {
      ctx.translate(cx, cy);
      ctx.scale(-1, 1);
      ctx.translate(-cx, -cy);
    }

    /* Left semicircle (pi/2 .. 3pi/2 = left half) */
    ctx.beginPath();
    ctx.arc(cx, cy, arenaR, Math.PI * 0.5, Math.PI * 1.5);
    ctx.closePath();
    ctx.fillStyle = cd.leftColor || "rgba(255, 0, 200, 0.18)";
    ctx.fill();

    /* Right semicircle (-pi/2 .. pi/2 = right half) */
    ctx.beginPath();
    ctx.arc(cx, cy, arenaR, -Math.PI * 0.5, Math.PI * 0.5);
    ctx.closePath();
    ctx.fillStyle = cd.rightColor || "rgba(0, 180, 255, 0.18)";
    ctx.fill();

    /* Vertical dividing line */
    ctx.beginPath();
    ctx.moveTo(cx, cy - arenaR);
    ctx.lineTo(cx, cy + arenaR);
    ctx.strokeStyle = cd.lineColor || "rgba(255, 255, 255, 0.6)";
    ctx.lineWidth = cd.lineWidth || 3;
    ctx.stroke();

    ctx.restore();
  }

  function drawCountdownText() {
    if (!playMode || !playMode.active || !playMode.text) return;
    var cd = config.countdown || {};
    var center = normToCanvas(0.5, 0.5);
    var baseFontSize = cd.fontSize || 130;
    var isLancio = playMode.phase === "lancio";

    /* Scale-in animation: text pops from 0 -> 1 over 200ms on each new phase */
    var elapsed = performance.now() - countdownPhaseStart;
    var scalePop = Math.min(1.0, elapsed / 200);
    /* Ease-out quad */
    scalePop = 1 - (1 - scalePop) * (1 - scalePop);

    var fontSize = Math.round(baseFontSize * scalePop);
    if (fontSize < 4) return;

    var textColor = isLancio
      ? (cd.lancioColor || "rgba(255, 220, 100, 1)")
      : (cd.textColor || "#fff");
    var glowColor = isLancio
      ? (cd.lancioGlow || "rgba(255, 180, 0, 0.9)")
      : (cd.textGlow || "rgba(255, 255, 255, 0.8)");
    var strokeColor = isLancio
      ? (cd.lancioStroke || "rgba(180, 80, 0, 0.9)")
      : (cd.strokeColor || "rgba(0, 0, 0, 0.9)");

    ctx.save();

    ctx.direction = "ltr";

    /* Italic skew for dynamic anime feel */
    var skew = cd.skewX || 0;
    if (skew) {
      ctx.translate(center.x, center.y);
      ctx.transform(1, 0, skew, 1, 0, 0);
      ctx.translate(-center.x, -center.y);
    }

    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = fontSize + "px " + (cd.fontFamily || "'Black Ops One', Impact, sans-serif");

    /* Glow layer */
    ctx.shadowColor = glowColor;
    ctx.shadowBlur = cd.textBloom || 40;
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = textColor;
    ctx.fillText(playMode.text, center.x, center.y);

    /* Stroke outline for anime punch */
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
    ctx.lineWidth = cd.strokeWidth || 6;
    ctx.strokeStyle = strokeColor;
    ctx.lineJoin = "round";
    ctx.strokeText(playMode.text, center.x, center.y);

    /* Crisp fill on top */
    ctx.fillStyle = textColor;
    ctx.fillText(playMode.text, center.x, center.y);

    ctx.restore();
  }

  function drawImpact(nx, ny, progress) {
    var pos = normToCanvas(nx, ny);
    var x = pos.x, y = pos.y;
    var impact = config.impact || {};
    var rStart = impact.radiusStart ?? 40;
    var rEnd = impact.radiusEnd ?? 120;
    var r = rStart + progress * (rEnd - rStart);
    var rayCount = impact.rayCount ?? 16;
    var baseColor = impact.strokeColor || "rgba(255, 220, 100, 1)";
    var alpha = 1 - progress;

    ctx.save();

    /* Central flash (brief bright pop, fades quickly) */
    if (progress < 0.15) {
      var flashAlpha = (1 - progress / 0.15) * 0.45;
      var flashR = rStart * (0.5 + progress);
      ctx.globalAlpha = flashAlpha;
      var flashGrad = ctx.createRadialGradient(x, y, 0, x, y, flashR);
      flashGrad.addColorStop(0, "#fff");
      flashGrad.addColorStop(0.4, baseColor);
      flashGrad.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = flashGrad;
      ctx.beginPath();
      ctx.arc(x, y, flashR, 0, Math.PI * 2);
      ctx.fill();
    }

    /* Expanding rays with varied lengths */
    ctx.globalAlpha = alpha;
    ctx.lineCap = "round";
    ctx.shadowColor = baseColor;
    ctx.shadowBlur = 12 * alpha;

    for (var i = 0; i < rayCount; i++) {
      var angle = (Math.PI * 2 * i) / rayCount;
      var lenVariation = 0.5 + 0.5 * Math.abs(Math.sin(i * 2.3 + progress * 4));
      var rayLen = r * lenVariation;
      var innerR = r * 0.3 * progress;
      ctx.strokeStyle = baseColor.replace(/[\d.]+\)$/, alpha + ")");
      ctx.lineWidth = (impact.lineWidth ?? 3) * (1 - progress * 0.5);
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(angle) * innerR, y + Math.sin(angle) * innerR);
      ctx.lineTo(x + Math.cos(angle) * rayLen, y + Math.sin(angle) * rayLen);
      ctx.stroke();
    }

    /* Expanding ring */
    ctx.globalAlpha = alpha * 0.5;
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    ctx.strokeStyle = baseColor.replace(/[\d.]+\)$/, (alpha * 0.6) + ")");
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, r * 0.8, 0, Math.PI * 2);
    ctx.stroke();

    ctx.restore();
  }

  function extrapolatedPosition(b, dtSec) {
    if (!dtSec || dtSec <= 0 || (!b.vx && !b.vy)) return { nx: b.nx, ny: b.ny };
    var divisor;
    if (state.stadiumRelative && state.arenaRadiusPx > 0) {
      divisor = 2 * state.arenaRadiusPx;
    }
    var vnx = (b.vx || 0) / (divisor || state.frameWidth || 1);
    var vny = (b.vy || 0) / (divisor || state.frameHeight || 1);
    var nx = b.nx + vnx * dtSec * EXTRAPOLATION_FACTOR;
    var ny = b.ny + vny * dtSec * EXTRAPOLATION_FACTOR;
    return { nx: Math.max(0, Math.min(1, nx)), ny: Math.max(0, Math.min(1, ny)) };
  }

  function render() {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const now = Date.now();
    const nowPerf = performance.now();
    const dtSec = lastMessageTime > 0 ? (nowPerf - lastMessageTime) / 1000 : 0;

    var countdownActive = playMode && playMode.active;

    if (countdownActive) {
      drawCountdownSplit();
      drawCountdownText();
    }

    if (!markerOnlyMode && !countdownActive) {
      const laserRed = config.laserRed || { core: "rgba(255, 50, 50, 1)", glow: "rgba(255, 80, 80, 0.6)", beyGlow: "rgba(255, 80, 80, 1)" };
      const laserBlue = config.laserBlue || { core: "rgba(80, 150, 255, 1)", glow: "rgba(100, 180, 255, 0.6)", beyGlow: "rgba(100, 180, 255, 1)" };

      for (const b of state.beys) {
        const laser = b.id === 0 ? laserRed : laserBlue;
        const ep = extrapolatedPosition(b, dtSec);
        drawBeyGlow(ep.nx, ep.ny, laser.beyGlow || laser.glow, 0, b.speed || 0);
      }

      if (lastTrailUpdate > 0 && now - lastTrailUpdate > TRAIL_STALE_MS) {
        clearTrails();
        lastTrailUpdate = 0;
      }

      for (let id of [0, 1]) {
        const arr = trails[id];
        if (arr.length > 0) {
          const laser = id === 0 ? laserRed : laserBlue;
          const b = state.beys.find(function (x) { return x.id === id; });
          if (b && dtSec > 0) {
            const ep = extrapolatedPosition(b, dtSec);
            var drawArr = arr.concat(ep);
            if (drawArr.length > TRAIL_MAX_LEN) drawArr = drawArr.slice(drawArr.length - TRAIL_MAX_LEN);
            drawLaserTrail(id, drawArr, laser.core, laser.glow);
          } else {
            drawLaserTrail(id, arr, laser.core, laser.glow);
          }
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
    }

    if (!isConnected) {
      drawAlignmentCross();
    }

    if (calib.active) {
      drawCalibrationOverlay();
    } else if (markerOnlyMode) {
      drawReferenceMarkers();
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
      if (data.referenceMarkers) state.referenceMarkers = data.referenceMarkers;
      if (data.arenaRadiusPx) state.arenaRadiusPx = data.arenaRadiusPx;

      if (data.playMode) {
        playMode = data.playMode;
        if (playMode.phase !== prevCountdownPhase) {
          prevCountdownPhase = playMode.phase;
          countdownPhaseStart = performance.now();
        }
      } else {
        playMode = null;
        prevCountdownPhase = null;
      }

      lastMessageTime = performance.now();
      if (data.timestamp) serverTimestamp = data.timestamp;

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
