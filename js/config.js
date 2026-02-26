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

  /* Laser trail: beyblade id 0 (first) */
  laserRed: {
    core: "rgba(255, 50, 50, 1)",
    glow: "rgba(255, 80, 80, 0.6)",
    /* Color of the beyblade glow at current position */
    beyGlow: "rgba(255, 80, 80, 1)"
  },

  /* Laser trail: beyblade id 1 (second) */
  laserBlue: {
    core: "rgba(80, 150, 255, 1)",
    glow: "rgba(100, 180, 255, 0.6)",
    beyGlow: "rgba(100, 180, 255, 1)"
  },

  /* Trail thickness: core base/peak width, glow base/peak width (in pixels) */
  trail: {
    coreWidthMin: 1,
    coreWidthMax: 2,
    glowWidthMin: 5,
    glowWidthMax: 8
  },

  /* Collision impact: radiating spark lines (explosion-style) */
  impact: {
    radiusStart: 30,
    radiusEnd: 100,
    rayCount: 16,
    strokeColor: "rgba(255, 200, 100, 1)",
    lineWidth: 1
  }
};
