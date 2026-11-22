// Liquid-glass plumbing for the HUD. The optical tokens live in tokens.ts; this module
// only turns them into the inline SVG a Chromium `backdrop-filter: url(#...)` can use,
// and owns the high/lite quality switch shared by every stage on the page.
//
// The displacement map is an opaque 256 x 256 image in which mid-grey is "no bend".
// The red channel shifts pixels horizontally and green shifts them vertically, so a
// dark band at the left/top edge pulls the scene from outside the panel and a bright
// band at the right/bottom edge does the same on the other side: a shallow convex
// bevel. The centre stays neutral, so the match behind the panel is not distorted.
import { GLASS, type GlassQuality } from '../lib/render/tokens';

const NEUTRAL = 128;
const BEND = 46;
const LOW = NEUTRAL - BEND;
const HIGH = NEUTRAL + BEND;

/** Build the refractive bevel map. Sizes are in map units; feImage stretches it to the panel. */
function displacementMap(): string {
  const W = 256;
  const H = 256;
  const b = Math.round(W * GLASS.refractionBevel);
  const mid = (v: number): string => Math.round(NEUTRAL + (v - NEUTRAL) * 0.42).toString();
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<defs>
<linearGradient id="l" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="rgb(${LOW},${NEUTRAL},${NEUTRAL})"/><stop offset=".5" stop-color="rgb(${mid(LOW)},${NEUTRAL},${NEUTRAL})"/><stop offset="1" stop-color="rgb(${NEUTRAL},${NEUTRAL},${NEUTRAL})"/></linearGradient>
<linearGradient id="r" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="rgb(${NEUTRAL},${NEUTRAL},${NEUTRAL})"/><stop offset=".5" stop-color="rgb(${mid(HIGH)},${NEUTRAL},${NEUTRAL})"/><stop offset="1" stop-color="rgb(${HIGH},${NEUTRAL},${NEUTRAL})"/></linearGradient>
<linearGradient id="t" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgb(${NEUTRAL},${LOW},${NEUTRAL})"/><stop offset=".5" stop-color="rgb(${NEUTRAL},${mid(LOW)},${NEUTRAL})"/><stop offset="1" stop-color="rgb(${NEUTRAL},${NEUTRAL},${NEUTRAL})"/></linearGradient>
<linearGradient id="b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="rgb(${NEUTRAL},${NEUTRAL},${NEUTRAL})"/><stop offset=".5" stop-color="rgb(${NEUTRAL},${mid(HIGH)},${NEUTRAL})"/><stop offset="1" stop-color="rgb(${NEUTRAL},${HIGH},${NEUTRAL})"/></linearGradient>
<radialGradient id="tl" cx="0" cy="0" r="1"><stop offset="0" stop-color="rgb(${LOW},${LOW},${NEUTRAL})"/><stop offset=".55" stop-color="rgb(${mid(LOW)},${mid(LOW)},${NEUTRAL})"/><stop offset="1" stop-color="rgb(${NEUTRAL},${NEUTRAL},${NEUTRAL})"/></radialGradient>
<radialGradient id="tr" cx="1" cy="0" r="1"><stop offset="0" stop-color="rgb(${HIGH},${LOW},${NEUTRAL})"/><stop offset=".55" stop-color="rgb(${mid(HIGH)},${mid(LOW)},${NEUTRAL})"/><stop offset="1" stop-color="rgb(${NEUTRAL},${NEUTRAL},${NEUTRAL})"/></radialGradient>
<radialGradient id="bl" cx="0" cy="1" r="1"><stop offset="0" stop-color="rgb(${LOW},${HIGH},${NEUTRAL})"/><stop offset=".55" stop-color="rgb(${mid(LOW)},${mid(HIGH)},${NEUTRAL})"/><stop offset="1" stop-color="rgb(${NEUTRAL},${NEUTRAL},${NEUTRAL})"/></radialGradient>
<radialGradient id="br" cx="1" cy="1" r="1"><stop offset="0" stop-color="rgb(${HIGH},${HIGH},${NEUTRAL})"/><stop offset=".55" stop-color="rgb(${mid(HIGH)},${mid(HIGH)},${NEUTRAL})"/><stop offset="1" stop-color="rgb(${NEUTRAL},${NEUTRAL},${NEUTRAL})"/></radialGradient>
</defs>
<rect width="${W}" height="${H}" fill="rgb(${NEUTRAL},${NEUTRAL},${NEUTRAL})"/>
<rect x="0" y="${b}" width="${b}" height="${H - b * 2}" fill="url(#l)"/>
<rect x="${W - b}" y="${b}" width="${b}" height="${H - b * 2}" fill="url(#r)"/>
<rect x="${b}" y="0" width="${W - b * 2}" height="${b}" fill="url(#t)"/>
<rect x="${b}" y="${H - b}" width="${W - b * 2}" height="${b}" fill="url(#b)"/>
<rect x="0" y="0" width="${b}" height="${b}" fill="url(#tl)"/>
<rect x="${W - b}" y="0" width="${b}" height="${b}" fill="url(#tr)"/>
<rect x="0" y="${H - b}" width="${b}" height="${b}" fill="url(#bl)"/>
<rect x="${W - b}" y="${H - b}" width="${b}" height="${b}" fill="url(#br)"/>
</svg>`;
}

const MAP_URI = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(displacementMap())}`;

/** One hidden <svg> per document; every panel points its backdrop-filter at the same filter. */
export function ensureGlassDefs(): void {
  if (typeof document === 'undefined' || document.getElementById('tl-glass-defs')) return;
  const host = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  host.setAttribute('id', 'tl-glass-defs');
  host.setAttribute('aria-hidden', 'true');
  host.setAttribute('focusable', 'false');
  host.setAttribute('width', '0');
  host.setAttribute('height', '0');
  host.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none';
  host.innerHTML = `<defs>
<filter id="${GLASS.filterId}" x="0%" y="0%" width="100%" height="100%" color-interpolation-filters="sRGB">
  <feImage href="${MAP_URI}" x="0" y="0" width="100%" height="100%" preserveAspectRatio="none" result="tl-map"/>
  <feDisplacementMap in="SourceGraphic" in2="tl-map" scale="${GLASS.refractionScale}" xChannelSelector="R" yChannelSelector="G"/>
</filter>
</defs>`;
  document.body.append(host);
}

// ---------- quality ----------

/** The user can force a quality via ?glass=lite (or ?glass=high) to pin it. */
function explicitFromUrl(): GlassQuality | null {
  try {
    const q = new URLSearchParams(location.search).get('glass');
    return q === 'lite' || q === 'high' ? q : null;
  } catch {
    return null;
  }
}

let current: GlassQuality | null = null;
let pinned = false;

/** The quality every stage on this page uses (defaults to the tokens.ts URL resolution). */
export function glassQuality(): GlassQuality {
  return current ?? GLASS.quality;
}

/** A stage's initial quality; kept as a compatibility alias for `glassQuality()`. */
export function glassQualityFromUrl(): GlassQuality {
  return glassQuality();
}

/** Apply a quality to the document (drives the `[data-glass=…]` CSS switch) and remember it. */
export function setGlassQuality(q: GlassQuality): void {
  current = q;
  if (typeof document !== 'undefined') document.documentElement.dataset.glass = q;
}

/**
 * Idempotent startup: inject the SVG defs once, then honour ?glass= (pinned) or the default.
 * Call before the first stage mounts so the filter is in the DOM before panels reference it.
 */
export function initGlass(): GlassQuality {
  ensureGlassDefs();
  const forced = explicitFromUrl();
  if (forced) pinned = true;
  const q = forced ?? GLASS.quality;
  setGlassQuality(q);
  return q;
}

/**
 * The frame loop calls this once the render loop has been over budget for a while. It downgrades
 * and never upgrades, unless the URL pinned a quality (a reviewer's explicit choice wins).
 */
export function downgradeGlassToLite(): void {
  if (pinned || glassQuality() === 'lite') return;
  setGlassQuality('lite');
}
