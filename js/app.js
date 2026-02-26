(function () {
  "use strict";

  const canvas = document.getElementById("canvas");
  const ctx = canvas.getContext("2d");
  const statusEl = document.getElementById("status");

  const params = new URLSearchParams(window.location.search);
  const WS_URL = params.get("ws") || "ws://127.0.0.1:8765";
  const flipY = params.get("flipY") === "1" || params.get("flipY") === "true";

  /* Effect settings from js/config.js; falls back to defaults if config missing */
  const config = (typeof BEYBLADE_EFFECT_CONFIG !== "undefined" && BEYBLADE_EFFECT_CONFIG) || {};
  const TRAIL_MAX_LEN = config.trailMaxLength ?? 60;
  const IMPACT_DURATION_MS = config.impactDurationMs ?? 200;

  let state = {
    frameWidth: 1280,
    frameHeight: 720,
    beys: [],
    collision: false,
    impactCenter: { x: 0, y: 0, nx: 0, ny: 0 }
  };

  const trails = { 0: [], 1: [] };
  let impactStart = 0;

  function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
  window.addEventListener("resize", resize);
  resize();

  function setStatus(msg, ok) {
    statusEl.textContent = msg;
    statusEl.className = ok ? "connected" : "disconnected";
  }

  function normToCanvas(nx, ny) {
    const w = canvas.width;
    const h = canvas.height;
    let x = nx * w;
    let y = ny * h;
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

      for (const b of state.beys) {
        const arr = trails[b.id] || (trails[b.id] = []);
        arr.push({ nx: b.nx, ny: b.ny });
        if (arr.length > TRAIL_MAX_LEN) arr.shift();
      }
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

  connect();
  render();
})();
