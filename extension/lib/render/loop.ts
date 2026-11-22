// One requestAnimationFrame loop at display rate shared by every stage on the page.
type Cb = (nowS: number) => void;
const cbs = new Set<Cb>();
let raf = 0;

function tick(t: number): void {
  const s = t / 1000;
  for (const cb of cbs) {
    try { cb(s); } catch (e) { console.error('[TacticLens] frame error', e); }
  }
  raf = cbs.size ? requestAnimationFrame(tick) : 0;
}

export function onFrame(cb: Cb): () => void {
  cbs.add(cb);
  if (!raf) raf = requestAnimationFrame(tick);
  return () => { cbs.delete(cb); };
}

let injected = false;
export function injectCss(css: string): void {
  if (injected) return;
  injected = true;
  const el = document.createElement('style');
  el.dataset.tl = 'hud';
  el.textContent = css;
  document.head.append(el);
}
