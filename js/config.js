/**
 * Beyblade effect configuration.
 * Edit this file to change trail colors, glow, impact and other visual effects.
 * No build step required: reload the page to apply changes.
 */
var BEYBLADE_EFFECT_CONFIG = {
  /* Maximum number of points kept in the trail per beyblade (longer = longer trail) */
  trailMaxLength: 15,

  /* Impact flash duration in milliseconds */
  impactDurationMs: 200,

  /* Laser trail: beyblade id 0 (first) - hot magenta */
  laserRed: {
    core: "rgba(255, 0, 255, 1)",
    glow: "rgba(255, 100, 255, 0.7)",
    beyGlow: "rgba(255, 50, 255, 1)"
  },

  /* Laser trail: beyblade id 1 (second) - electric cyan */
  laserBlue: {
    core: "rgba(0, 255, 255, 1)",
    glow: "rgba(100, 255, 255, 0.7)",
    beyGlow: "rgba(50, 255, 255, 1)"
  },

  /* Trail thickness: core base/peak width, glow base/peak width (in pixels).
   * Thicker values keep effects visible when projection focus is uneven. */
  trail: {
    coreWidthMin: 8,
    coreWidthMax: 16,
    glowWidthMin: 18,
    glowWidthMax: 32
  },

  /* Collision impact: radiating spark lines (explosion-style) */
  impact: {
    radiusStart: 30,
    radiusEnd: 100,
    rayCount: 12,
    strokeColor: "rgba(255, 200, 100, 1)",
    lineWidth: 2
  }
};
