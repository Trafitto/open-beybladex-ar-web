/**
 * Beyblade effect configuration.
 * Edit this file to change trail colors, glow, impact and other visual effects.
 * No build step required: reload the page to apply changes.
 */
var BEYBLADE_EFFECT_CONFIG = {
  /* Trail history length (more points = longer tail) */
  trailMaxLength: 24,

  /* Impact flash duration in milliseconds */
  impactDurationMs: 300,

  /* Laser trail: beyblade id 0 (first) - hot magenta / pink energy */
  laserRed: {
    core: "rgba(255, 220, 255, 1)",
    glow: "rgba(255, 0, 200, 0.8)",
    beyGlow: "rgba(255, 0, 200, 1)"
  },

  /* Laser trail: beyblade id 1 (second) - electric cyan / blue energy */
  laserBlue: {
    core: "rgba(220, 255, 255, 1)",
    glow: "rgba(0, 180, 255, 0.8)",
    beyGlow: "rgba(0, 180, 255, 1)"
  },

  /* Trail rendering: anime-style energy beam.
   * coreWidthMax: peak width of the bright center line at the head
   * glowWidthMax: peak width of the outer colored glow at the head
   * bloomBlur: soft bloom radius (projector-friendly glow) */
  trail: {
    coreWidthMax: 10,
    glowWidthMax: 28,
    bloomBlur: 22
  },

  /* Bey glow: the bright aura around each tracked beyblade.
   * baseRadius: minimum glow radius in pixels (must be big for projectors)
   * speedScale: extra radius per unit speed (faster = bigger glow)
   * bloomBlur: soft outer bloom via CSS shadow (very visible on projectors) */
  beyGlow: {
    baseRadius: 35,
    speedScale: 0.3,
    bloomBlur: 30
  },

  /* Collision impact: radiating spark lines */
  impact: {
    radiusStart: 40,
    radiusEnd: 120,
    rayCount: 16,
    strokeColor: "rgba(255, 220, 100, 1)",
    lineWidth: 3
  },

  /* Alignment reference markers (calibration mode: C key, marker-only: M key) */
  markers: {
    rimColor: "rgba(0, 255, 100, 0.9)",
    innerColor: "rgba(0, 200, 255, 0.8)",
    centerColor: "rgba(255, 255, 0, 1)",
    pocketColor: "rgba(255, 100, 0, 1)",
    size: 7
  },

  /* Play-mode countdown: stadium split + text overlay */
  countdown: {
    leftColor:  "rgba(255, 0, 200, 0.18)",
    rightColor: "rgba(0, 180, 255, 0.18)",
    lineColor:  "rgba(255, 255, 255, 0.6)",
    lineWidth:  3,
    fontFamily: "'Black Ops One', Impact, 'Arial Black', sans-serif",
    fontSize:   130,
    textColor:  "#fff",
    textGlow:   "rgba(255, 255, 255, 0.8)",
    textBloom:  40,
    strokeColor: "rgba(0, 0, 0, 0.9)",
    strokeWidth: 6,
    skewX:      -0.15,
    lancioColor: "rgba(255, 220, 100, 1)",
    lancioGlow:  "rgba(255, 180, 0, 0.9)",
    lancioStroke: "rgba(180, 80, 0, 0.9)",
    mirror:     true
  }
};
