// Design tokens: the single source for canvas and HUD (language, motion, anti-flicker rules,
// width tiers). Broadcast-first: condensed display type, dark glass,
// a thin accent edge, tabular numerals and team-colour plates with automatic text contrast.
import { cubicBezier } from './math';

/** Durations in seconds. Entries are deliberately slower than exits. */
export const D = {
  snap: 0.08,
  micro: 0.14,
  enter: 0.32,
  exit: 0.18,
  emphasis: 0.42,
  scene: 0.6,
  fade: 0.2,
  wipe: 0.42,
  followPos: 0.08,
  followSize: 0.3,
  stagger: 0.05,
  staggerMax: 12,
} as const;

export type EaseName = 'linear' | 'micro' | 'enter' | 'exit' | 'emphasis' | 'scene';
const FNS: Record<EaseName, (t: number) => number> = {
  linear: (t) => t,
  micro: cubicBezier(0.2, 0, 0, 1),
  enter: cubicBezier(0.16, 1, 0.3, 1),
  exit: cubicBezier(0.4, 0, 1, 1),
  emphasis: cubicBezier(0.34, 1.56, 0.64, 1),
  scene: cubicBezier(0.65, 0, 0.35, 1),
};
export function ease(name: EaseName, t: number): number {
  return FNS[name](t < 0 ? 0 : t > 1 ? 1 : t);
}

export const BEZIER_CSS = {
  micro: 'cubic-bezier(0.2, 0, 0, 1)',
  enter: 'cubic-bezier(0.16, 1, 0.3, 1)',
  exit: 'cubic-bezier(0.4, 0, 1, 1)',
  emphasis: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  scene: 'cubic-bezier(0.65, 0, 0.35, 1)',
} as const;

// ---------------------------------------------------------------------------
// Type
// ---------------------------------------------------------------------------

/** Condensed display face for score, stat values, labels and the REPLAY wipe. */
export const DISPLAY_STACK = "'Barlow Condensed', 'Inter', 'Segoe UI', system-ui, sans-serif";
/** Clean UI face for sentences, labels and tags. */
export const UI_STACK = "'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif";
// ---------------------------------------------------------------------------
// Liquid glass. Every optical value lives here; the HUD CSS and the SVG
// displacement filter are generated from these tokens.
//
// Technique: a dark, very translucent tint (<= 0.28 alpha) over a small
// backdrop-filter stack (blur + saturate + brightness). Chromium additionally
// gets a real refraction pass: an inline SVG feImage displacement map (neutral
// grey = no bend, brighter/darker red/green = edge lensing) feeding an
// feDisplacementMap applied through `backdrop-filter: url(#tl-liquid-glass)`.
// A specular rim (mask-composite gradient border) and a 1 px top highlight sell
// the material. `lite` drops the SVG pass and keeps the plain blur.
// ---------------------------------------------------------------------------

export type GlassQuality = 'high' | 'lite';

/** ?glass=lite forces the cheap path for reviewers and low-end machines. */
function initialGlassQuality(): GlassQuality {
  try {
    return new URLSearchParams(location.search).get('glass') === 'lite' ? 'lite' : 'high';
  } catch {
    return 'high';
  }
}

export const GLASS = {
  /** Default quality. Stage downgrades to 'lite' when the render loop runs over budget. */
  quality: initialGlassQuality() as GlassQuality,
  filterId: 'tl-liquid-glass',
  /** Backdrop stack: small radii only, the video behind stays recognisable. */
  blurPx: 8,
  blurLitePx: 9,
  saturate: 1.55,
  brightness: 1.07,
  contrast: 1.02,
  /** Small surfaces that only need frost: the lime mark and the possession track. */
  markBlurPx: 7,
  markSaturate: 1.5,
  trackBlurPx: 6,
  trackSaturate: 1.35,
  /** Refraction map: bevel width as a fraction of each axis, and displacement in px. */
  refractionBevel: 0.19,
  refractionScale: 58,
  /** Corner radius for glass surfaces; the small accent tabs use radiusSm. */
  radius: '0.85em',
  radiusSm: '0.5em',
  /** Panel tint. Keep every fill <= 0.28 so the match always reads through. */
  fill: 'rgba(7,11,18,0.20)',
  fillStrong: 'rgba(4,8,13,0.26)',
  fillSoft: 'rgba(8,13,20,0.14)',
  accentFill: 'rgba(215,255,62,0.18)',
  /** Light lift inside the tint, top to bottom. */
  lift: 'linear-gradient(180deg,rgba(255,255,255,0.15) 0%,rgba(255,255,255,0.045) 22%,rgba(255,255,255,0.008) 64%,rgba(255,255,255,0.06) 100%)',
  /** Specular border: bright top-left, thin in the middle, bright bottom-right. */
  rim: 'linear-gradient(142deg,rgba(255,255,255,0.66) 0%,rgba(255,255,255,0.16) 17%,rgba(255,255,255,0.035) 46%,rgba(255,255,255,0.10) 70%,rgba(255,255,255,0.58) 100%)',
  /** Entry sheen sweeping across the glass. */
  sheen: 'linear-gradient(104deg,transparent 30%,rgba(255,255,255,0.16) 46%,rgba(255,255,255,0.03) 55%,transparent 70%)',
  /** Inner tint behind the lower-third sentence only. */
  scrim: 'linear-gradient(94deg,rgba(3,6,10,0.20),rgba(3,6,10,0.05) 62%,rgba(3,6,10,0))',
  /** Inner tint behind the summary's hero numbers. */
  summaryScrim: 'radial-gradient(130% 110% at 18% 26%,rgba(3,6,10,0.20),transparent 62%)',
  /** State-tinted rims for accent, replay and danger glass. */
  rimAccent: 'linear-gradient(142deg,rgba(215,255,62,0.55) 0%,rgba(255,255,255,0.14) 20%,rgba(255,255,255,0.03) 55%,rgba(255,255,255,0.12) 82%,rgba(215,255,62,0.40) 100%)',
  rimReplay: 'linear-gradient(142deg,rgba(255,157,60,0.55) 0%,rgba(255,255,255,0.14) 22%,rgba(255,255,255,0.03) 55%,rgba(255,255,255,0.12) 82%,rgba(255,157,60,0.34) 100%)',
  rimDanger: 'linear-gradient(142deg,rgba(255,91,98,0.60) 0%,rgba(255,255,255,0.14) 22%,rgba(255,255,255,0.03) 55%,rgba(255,255,255,0.12) 82%,rgba(255,91,98,0.36) 100%)',
  edge: 'rgba(255,255,255,0.30)',
  edgeStrong: 'rgba(255,255,255,0.55)',
  innerLight: 'rgba(255,255,255,0.30)',
  innerSoft: 'rgba(255,255,255,0.07)',
  shadow: '0 0.9em 2.4em rgba(0,0,0,0.34)',
  shadowTight: '0 0.25em 1em rgba(0,0,0,0.26)',
  /** Text shadows: the tint alone is deliberately too light for bright grass. */
  textShadow: '0 1px 2px rgba(0,0,0,0.55),0 0 10px rgba(0,0,0,0.32)',
  textShadowStrong: '0 1px 3px rgba(0,0,0,0.72),0 0 16px rgba(0,0,0,0.46)',
  /** Auto-downgrade threshold: the same 4 ms budget the perf chip calls "over". */
  budgetMs: 4,
  downgradeAfterS: 1.6,
} as const;

/** Full Chromium path: SVG refraction + frost. */
export const GLASS_BACKDROP = `url(#${GLASS.filterId}) blur(${GLASS.blurPx}px) saturate(${GLASS.saturate}) brightness(${GLASS.brightness}) contrast(${GLASS.contrast})`;
/** Portable path: frost only. */
export const GLASS_BACKDROP_LITE = `blur(${GLASS.blurLitePx}px) saturate(${GLASS.saturate}) brightness(${GLASS.brightness}) contrast(${GLASS.contrast})`;

export const LAYOUT = {
  safeX: '4%',
  safeTop: '4%',
  subtitleBottom: '14%',
  scorebugW: '30%',
  scorebugH: '17%',
  kimiW: '46%',
  railW: '13.5em',
} as const;

// ---------------------------------------------------------------------------
// Calm player markers. One block for the ground layer: colour treatment, stroke,
// glows and the motion filter that feeds it.
//
// Sizes are CSS px scaled by `u` (videoRect.w / 1280; 1.5 at 1920) and by the
// player's screen size, then rasterised through the DPR canvas transform.
// A 1.8 * u stroke is ~2.7 px at 1080p and ~1.8 px on a 720p pane.
// ---------------------------------------------------------------------------

export const MARKER = {
  /** Overall alpha of a normal marker (raised from 0.82: was too faint on grass). */
  opacity: 0.9,
  /** Main ellipse stroke in the brightened team colour. */
  strokePx: 1.8,
  strokeAlpha: 0.96,
  /** Thin white inner rim: a guaranteed edge on bright grass and white/yellow kits. */
  innerRimPx: 1.0,
  innerRimScale: 0.9,
  innerRimAlpha: 0.58,
  /** Soft outer glow and wider halo in the team colour. */
  glowPx: 4.6,
  glowScale: 1.12,
  glowAlpha: 0.2,
  haloPx: 8,
  haloScale: 1.3,
  haloAlpha: 0.08,
  /** Faint tint inside the ellipse; the pitch still reads through. */
  fillAlpha: 0.13,
  /** Faint dark contact shadow under the feet: separates light kits from bright grass. */
  shadowAlpha: 0.26,
  shadowScale: 1.04,
  shadowOffset: 0.22,
  /** Hairline just outside the stroke in the kit's own contrast edge (offset down-right, px). */
  keylinePx: 0.8,
  keylineOffsetPx: 0.8,
  keylineAlpha: 0.55,
  /** Colour treatment: keep the hue, lift lightness so the kit reads at 60 fps. */
  lightnessBoost: 0.14,
  minLightness: 0.5,
  maxLightness: 0.94,
  /** Stroke grows/shrinks with the player's screen size (marker radius / reference). */
  sizeRefPx: 20,
  sizeScaleMin: 0.85,
  sizeScaleMax: 1.4,
  /** Carrier / highlighted: slightly stronger, never a different shape. */
  strong: {
    opacity: 1,
    stroke: 1.22,
    glow: 1.5,
    innerRim: 1.15,
    fill: 1.35,
  },
  /** Cross-fade time into/out of the strong state, seconds. */
  strongTauS: 0.16,
  /** Screen-space One Euro. The tracker's velocity opens the cutoff at sprint speed. */
  filter: {
    minCutoffHz: 1.0,
    beta: 0.06,
    dCutoffHz: 1.0,
    sizeMinCutoffHz: 0.8,
    sizeBeta: 0,
  },
  /** Latency compensation. */
  motion: {
    /** Safety cap on the drawn marker speed, px/s at the 1080p reference (was 720). */
    maxPxS: 2500,
    /** One display frame of lead past video.currentTime (multiplied by playbackRate). */
    displayLeadS: 1 / 60,
    /** Acceleration is only trusted for this long after an observation. */
    accelLeadMaxS: 0.25,
    /** Acceleration displacement may add at most this share of the constant-velocity displacement. */
    accelShare: 0.35,
    /** Clamp on the estimated acceleration, normalised frame widths / s^2. */
    maxAccel: 6,
  },
} as const;

// ---------------------------------------------------------------------------
// Colour
// ---------------------------------------------------------------------------

export const COLOUR = {
  // Kimi is the only user of the accent: acid lime, never a team colour.
  accent: '#d7ff3e',
  accentHot: '#eaff9a',
  accentInk: '#10150a',
  accentDim: 'rgba(215,255,62,0.16)',
  white: '#f7f9fb',
  neutral: '#dce5ec',
  teamA: '#3d8bff',
  teamB: '#ff4d4f',
  live: '#39e6a0',
  warn: '#ffc247',
  replay: '#ff9d3c',
  danger: '#ff5b62',
  glass: GLASS.fill,
  glassLine: GLASS.edge,
  text: '#f7f9fb',
  textDim: 'rgba(247,249,251,0.62)',
  textFaint: 'rgba(247,249,251,0.36)',
  ink: '#0a0e12',
  page: '#05070a',
  pageRaised: '#0a0f16',
  grass: '#2e7d3f',
  pitchDark: '#1b5c2f',
  stand: '#0b1119',
} as const;

/** sRGB relative luminance, WCAG. */
export function relativeLuminance(hex: string): number {
  const h = hex.replace('#', '');
  const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const v = parseInt(s, 16);
  if (!Number.isFinite(v)) return 0;
  const ch = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((c) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * ch[0]! + 0.7152 * ch[1]! + 0.0722 * ch[2]!;
}

/**
 * Automatic ink for text sitting on a team plate. White stays the broadcast default while it
 * still clears WCAG's 3:1 large-text bar; lighter plates (gold, lime, sky) flip to ink.
 * L = 0.30 is exactly where white drops to 3:1, and ink on anything lighter is >= 6.4:1,
 * so the pick is always legible for scorebug display type.
 */
export function contrastInk(hex: string): '#0a0e12' | '#ffffff' {
  return relativeLuminance(hex) > 0.3 ? '#0a0e12' : '#ffffff';
}

/** amt < 0 darkens, amt > 0 lightens; -1..1 (clamped so a stray amount can't wrap channels). */
export function shade(hex: string, amt: number): string {
  const h = hex.replace('#', '');
  const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const v = parseInt(s, 16);
  const mix = (c: number): number => Math.max(0, Math.min(255, Math.round(amt < 0 ? c * (1 + amt) : c + (255 - c) * amt)));
  const r = mix((v >> 16) & 255), g = mix((v >> 8) & 255), b = mix(v & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

export function withAlpha(hex: string, a: number): string {
  const h = hex.replace('#', '');
  const s = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const v = parseInt(s, 16);
  return `rgba(${(v >> 16) & 255},${(v >> 8) & 255},${v & 255},${Math.max(0, Math.min(1, a)).toFixed(3)})`;
}

/** Everyday colour word for a jersey colour ("Red", "Yellow", "Light blue"...), from hue/saturation/lightness. */
export function colourName(hex: string): string {
  const h6 = hex.replace('#', '');
  const s6 = h6.length === 3 ? h6.split('').map((c) => c + c).join('') : h6;
  const v = parseInt(s6, 16);
  if (!Number.isFinite(v)) return 'Grey';
  const r = ((v >> 16) & 255) / 255, g = ((v >> 8) & 255) / 255, b = (v & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const l = (mx + mn) / 2, d = mx - mn;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  let hue = 0;
  if (d !== 0) {
    if (mx === r) hue = ((g - b) / d) % 6;
    else if (mx === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue = (hue * 60 + 360) % 360;
  }
  if (l < 0.13) return 'Black';
  // HSL saturation explodes for near-white colours (a white shirt under cool floodlights can
  // report s ~= 0.5 from a 3-level channel difference). Absolute channel spread is the honest test
  // for "this is a neutral", so white stays White instead of becoming Light blue.
  if (d < 0.08 || s < 0.14) return l > 0.8 ? 'White' : l < 0.26 ? 'Black' : 'Grey';
  if (hue < 12 || hue >= 346) return l < 0.3 ? 'Maroon' : 'Red';
  if (hue < 40) return l < 0.34 ? 'Brown' : 'Orange';
  if (hue < 72) return 'Yellow';
  if (hue < 165) return 'Green';
  if (hue < 200) return 'Teal';
  if (hue < 255) return l < 0.24 ? 'Navy' : l > 0.7 ? 'Light blue' : 'Blue';
  if (hue < 292) return 'Purple';
  return l < 0.36 ? 'Purple' : 'Pink';
}

/** Colour words for the two kits; when both land on the same word the lighter one becomes "Light x" and the darker "Dark x". */
export function jerseyNames(a: string, b: string): { A: string; B: string } {
  const na = colourName(a), nb = colourName(b);
  if (na !== nb) return { A: na, B: nb };
  const lum = (x: string): number => relativeLuminance(x);
  const lighterIsA = lum(a) >= lum(b);
  // Two whites/black must never share a label: "Team White" twice tells the viewer nothing. The
  // display separation already darkens one side, so the natural words are White/Grey and Black/Charcoal.
  if (na === 'White') return lighterIsA ? { A: 'White', B: 'Grey' } : { A: 'Grey', B: 'White' };
  if (na === 'Black') return lighterIsA ? { A: 'Charcoal', B: 'Black' } : { A: 'Black', B: 'Charcoal' };
  const pre = (n: string, p: 'Light' | 'Dark'): string => `${p} ${n.toLowerCase()}`;
  return lighterIsA ? { A: pre(na, 'Light'), B: pre(nb, 'Dark') } : { A: pre(na, 'Dark'), B: pre(nb, 'Light') };
}

/**
 * Scorebug-length club abbreviation: "Harbor FC" -> HFC, "Redstone" -> RED, "Manchester City" -> MC.
 * Initials per word, except a short last word (FC, CF, SC, AFC, 05...) contributes its whole letters.
 */
export function abbreviate(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    const last = words[words.length - 1]!.replace(/[^A-Za-z0-9]/g, '');
    const initials = words.slice(0, -1).map((w) => w[0]!.toUpperCase().replace(/[^A-Za-z0-9]/g, '')).join('');
    const abbr = (initials + (last.length > 0 && last.length <= 3 ? last : last[0] ?? '')).toUpperCase();
    return abbr.slice(0, 4) || 'TBD';
  }
  return ((words[0] ?? 'TBD').replace(/[^A-Za-z0-9]/g, '').slice(0, 3) || 'TBD').toUpperCase();
}

// ---------------------------------------------------------------------------
// Anti-flicker (tightened for broadcast)
// ---------------------------------------------------------------------------

export const RULES = {
  minOnWorld: 1.0,
  worldFade: 0.2,
  minOnLineBase: 2.5,
  minOnLinePerChar: 0.06,
  minGapSameType: 0.8,
  maxGroups: 3,
  maxSpotlight: 1,
  maxPrediction: 1,
  statMinInterval: 0.5,
  statTween: 0.3,
  possessionHold: 1.0,
  teamColourMinGap: 3,
  teamColourFade: 0.3,
  trackBirth: 0.3,
  coast: 0.4,
  coastFade: 0.2,
  lookAheadMax: 0.3,
  ballOutAfter: 1.0,
  ballBackAfter: 0.6,
  pendingMax: 1.5,
} as const;

/** Priority: prediction > spotlight/tag > lanes > overload > hull > links. */
export const PRIORITY: Record<string, number> = {
  prediction: 6, spotlight: 5, tag: 5, lag_ghost: 5, lanes: 4, switch: 4,
  overload: 3, pressure: 3, run: 3, hull: 2, line: 2, pocket: 1, links: 1,
  ring: 0, ball_marker: 0, carrier: 0,
};

/** Concurrency groups (at most 3 world graphic groups). */
export const GROUP: Record<string, string> = {
  spotlight: 'focus', tag: 'focus', lanes: 'pass', switch: 'pass', prediction: 'prediction',
  hull: 'shape', line: 'shape', pocket: 'shape', overload: 'cluster', links: 'cluster',
  pressure: 'cluster', run: 'cluster', lag_ghost: 'lag',
};

// ---------------------------------------------------------------------------
// CSS custom properties, injected once per document.
// ---------------------------------------------------------------------------

export const TOKENS_CSS = `
:root{
  --tl-accent:${COLOUR.accent};--tl-accent-hot:${COLOUR.accentHot};--tl-accent-ink:${COLOUR.accentInk};
  --tl-accent-dim:${COLOUR.accentDim};--tl-white:${COLOUR.white};--tl-ink:${COLOUR.ink};
  --tl-neutral:${COLOUR.neutral};--tl-a:${COLOUR.teamA};--tl-b:${COLOUR.teamB};
  --tl-a-ink:${contrastInk(COLOUR.teamA)};--tl-b-ink:${contrastInk(COLOUR.teamB)};
  --tl-live:${COLOUR.live};--tl-warn:${COLOUR.warn};--tl-replay:${COLOUR.replay};--tl-danger:${COLOUR.danger};
  --tl-glass:${GLASS.fill};--tl-glass-fill:${GLASS.fill};--tl-glass-strong:${GLASS.fillStrong};--tl-glass-soft:${GLASS.fillSoft};
  --tl-glass-accent-fill:${GLASS.accentFill};--tl-glass-lift:${GLASS.lift};--tl-glass-rim:${GLASS.rim};
  --tl-glass-sheen:${GLASS.sheen};--tl-glass-scrim:${GLASS.scrim};--tl-glass-summary-scrim:${GLASS.summaryScrim};
  --tl-glass-rim-accent:${GLASS.rimAccent};--tl-glass-rim-replay:${GLASS.rimReplay};--tl-glass-rim-danger:${GLASS.rimDanger};
  --tl-glass-mark:blur(${GLASS.markBlurPx}px) saturate(${GLASS.markSaturate});
  --tl-glass-track:blur(${GLASS.trackBlurPx}px) saturate(${GLASS.trackSaturate});
  --tl-glass-line:${GLASS.edge};--tl-glass-line-strong:${GLASS.edgeStrong};--tl-inner-light:${GLASS.innerLight};--tl-glass-inner-light:${GLASS.innerLight};
  --tl-inner-soft:${GLASS.innerSoft};--tl-glass-text-shadow:${GLASS.textShadow};--tl-glass-text-strong:${GLASS.textShadowStrong};
  --tl-glass-shadow-tight:${GLASS.shadowTight};--tl-glass-radius:${GLASS.radius};--tl-glass-radius-sm:${GLASS.radiusSm};
  --tl-dim:rgba(247,249,251,0.70);--tl-faint:rgba(247,249,251,0.46);--tl-page:${COLOUR.page};--tl-page-raised:${COLOUR.pageRaised};
  --tl-font:${UI_STACK};--tl-font-ui:${UI_STACK};--tl-font-display:${DISPLAY_STACK};
  --tl-micro:${BEZIER_CSS.micro};--tl-enter:${BEZIER_CSS.enter};--tl-exit:${BEZIER_CSS.exit};
  --tl-emph:${BEZIER_CSS.emphasis};--tl-scene:${BEZIER_CSS.scene};
  --tl-d-micro:140ms;--tl-d-enter:320ms;--tl-d-exit:180ms;--tl-d-emph:420ms;--tl-d-scene:600ms;--tl-d-snap:80ms;
  --tl-stagger:50ms;--tl-blur:${GLASS_BACKDROP_LITE};--tl-shadow:${GLASS.shadow};
  --tl-glass-backdrop:${GLASS_BACKDROP};--tl-glass-backdrop-lite:${GLASS_BACKDROP_LITE};
  --tl-gap-1:.25em;--tl-gap-2:.4em;--tl-gap-3:.65em;--tl-gap-4:1em;--tl-gap-5:1.6em;--tl-gap-6:2.4em;
  --tl-r-1:.25em;--tl-r-2:.45em;--tl-r-3:.75em;--tl-r-pill:999em;
  --tl-safe-x:4%;--tl-safe-top:4%;--tl-safe-bottom:14%;
}`;
