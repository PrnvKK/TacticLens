// Broadcast HUD styles. Sizes are em against --fs, set from the video rectangle,
// so the whole layer scales with the picture and never below 11 px actual.
// Every panel stays mounted; [data-show] drives a 320 ms eased entry with a 4-6 px motion blur
// and a 180 ms exit. Siblings stagger at 50 ms.
import { TOKENS_CSS } from '../lib/render/tokens';

export const HUD_CSS = `${TOKENS_CSS}
.tl-stage{position:relative;width:100%;height:100%;background:#04070a;overflow:hidden;font-family:var(--tl-font-ui);color:var(--tl-white);container-type:size;-webkit-font-smoothing:antialiased}
.tl-media{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;background:#000;display:block}
.tl-stage[data-fit=cover] .tl-media{object-fit:cover}
.tl-world{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;display:block}
.tl-hud{position:absolute;pointer-events:none;font-size:var(--fs,16px);font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1}
.tl-hud-root{position:absolute;inset:0;font-family:var(--tl-font-ui);font-size:inherit;line-height:1.25;
  color:var(--tl-white);font-variant-numeric:tabular-nums;font-feature-settings:"tnum" 1,"cv11" 1;
  -webkit-font-smoothing:antialiased;text-rendering:optimizeLegibility;pointer-events:none;overflow:hidden;
  text-shadow:var(--tl-glass-text-shadow)}
.tl-hud-root *{box-sizing:border-box}
.tl-z{position:absolute;opacity:0;translate:var(--in-x,0) var(--in-y,-8px);filter:blur(6px);
  transition:opacity var(--tl-d-exit) var(--tl-exit),translate var(--tl-d-exit) var(--tl-exit),filter var(--tl-d-exit) var(--tl-exit);
  will-change:opacity,translate,filter}
.tl-z[data-show=true]{opacity:1;translate:0 0;filter:none;transition-duration:var(--tl-d-enter);
  transition-timing-function:var(--tl-enter);transition-delay:var(--d,0ms)}
.tl-dimtext{color:var(--tl-dim)}
.tl-pauseglyph{display:inline-block;letter-spacing:-.14em;color:var(--tl-warn);transform:scaleX(.9)}

/* ---------- liquid glass ----------
   One shared material. The tint is intentionally light (<= .28 alpha); legibility comes from
   the frost, the specular rim and a text shadow, not from an opaque panel. The high path adds
   SVG edge refraction in Chromium; lite is the same material with a plain blur. */
.tl-glass{background-color:var(--tl-glass-fill);background-image:var(--tl-glass-lift);
  border:1px solid var(--tl-glass-line);
  box-shadow:var(--tl-shadow),inset 0 1px 0 var(--tl-glass-inner-light),inset 0 -1px 0 rgba(255,255,255,.05);
  -webkit-backdrop-filter:var(--tl-glass-backdrop);backdrop-filter:var(--tl-glass-backdrop)}
/* Micro chips (perf, labels, pulse, score, speed, freeze) stay frosted-only: displacement
   is invisible at their size and this keeps the SVG filter count down. */
.tl-glass-soft{background-color:var(--tl-glass-soft);
  -webkit-backdrop-filter:var(--tl-glass-backdrop-lite);backdrop-filter:var(--tl-glass-backdrop-lite)}
.tl-glass-strong{background-color:var(--tl-glass-strong)}
.tl-glass::before{content:"";position:absolute;inset:0;padding:1px;border-radius:inherit;pointer-events:none;
  background:var(--tl-glass-rim);opacity:.92;
  -webkit-mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);
  -webkit-mask-composite:xor;mask:linear-gradient(#000 0 0) content-box,linear-gradient(#000 0 0);mask-composite:exclude}
.tl-glass::after{content:"";position:absolute;inset:0;border-radius:inherit;pointer-events:none;
  background:var(--tl-glass-sheen);background-size:220% 100%;background-position:180% 0;opacity:0;mix-blend-mode:screen}
.tl-glass-sheen[data-show=true]::after,
.tl-l3.tl-glass-sheen::after,
.tl-predcard.tl-glass-sheen::after{animation:tl-glass-sheen 1.15s var(--tl-enter) 120ms 1}
@keyframes tl-glass-sheen{0%{opacity:0;background-position:180% 0}18%{opacity:.7}100%{opacity:0;background-position:-80% 0}}
[data-glass=lite] .tl-glass{-webkit-backdrop-filter:var(--tl-glass-backdrop-lite);backdrop-filter:var(--tl-glass-backdrop-lite)}

/* ---------- team plates ---------- */
.tl-plate{display:inline-flex;align-items:center;gap:.2em;position:relative;flex:none;text-shadow:none;
  font-family:var(--tl-font-display);font-weight:700;font-size:.66em;line-height:1;letter-spacing:.055em;
  text-transform:uppercase;color:var(--ink,var(--tl-a-ink));padding:.24em .52em .26em .42em;
  background:linear-gradient(112deg,var(--c,var(--tl-a)) 0%,var(--deep,var(--tl-a-deep)) 140%);
  clip-path:polygon(0 0,calc(100% - .34em) 0,100% 100%,0 100%);
  box-shadow:inset 0 .08em 0 rgba(255,255,255,.24),inset 0 0 0 1px var(--edge,transparent)}
.tl-plate i{position:absolute;left:0;top:0;bottom:0;width:.17em;background:rgba(255,255,255,.62)}
.tl-plate b{font:inherit;position:relative;z-index:1}
.tl-plate.is-small{font-size:.54em;padding:.2em .4em .22em .34em;clip-path:polygon(0 0,calc(100% - .26em) 0,100% 100%,0 100%)}
.tl-kmark{display:inline-flex;align-items:center;justify-content:center;width:1.28em;height:1.28em;flex:none;
  color:var(--tl-accent-ink);background:var(--tl-accent);clip-path:polygon(0 0,100% 0,100% calc(100% - .28em),calc(100% - .28em) 100%,0 100%)}
.tl-kmark svg{width:.78em;height:.78em}
.tl-kmark.is-small{width:1.1em;height:1.1em;background:transparent;color:var(--tl-accent);clip-path:none;border:1px solid var(--tl-accent-dim)}

/* ---------- top-centre score strip ---------- */
.tl-scorebar{top:var(--tl-safe-top);left:50%;width:min(37em,40%);font-size:.78em;transform:translateX(-50%);--in-y:-12px;--d:0ms;
  padding:.62em .9em .6em;
  clip-path:polygon(0 0,100% 0,100% calc(100% - .55em),calc(100% - .72em) 100%,.72em 100%,0 calc(100% - .55em))}
.tl-scorebar-edge{position:absolute;left:0;right:0;top:0;height:.14em;
  background:linear-gradient(90deg,var(--tl-a),rgba(255,255,255,.9) 48%,var(--tl-b));opacity:.82;
  filter:drop-shadow(0 0 .25em rgba(255,255,255,.4))}
.tl-scorebar-top{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:.6em}
.tl-sb-identity{display:flex;align-items:center;gap:.45em;min-width:0}
.tl-sb-identity.right{justify-content:flex-end}
.tl-sb-identity .name{font-family:var(--tl-font-display);font-weight:600;font-size:1.32em;line-height:1;
  letter-spacing:.02em;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--tl-white);text-shadow:var(--tl-glass-text-strong)}
.tl-sb-centre{display:flex;flex-direction:column;align-items:center;gap:.04em;min-width:4.6em}
.tl-sb-centre .score{font-family:var(--tl-font-display);font-size:1.38em;font-weight:700;line-height:.95;letter-spacing:.03em;color:#fff;
  text-shadow:var(--tl-glass-text-strong)}
.tl-sb-centre .score span{opacity:.45;padding:0 .18em}
.tl-sb-centre .clock{font-size:.56em;font-weight:700;letter-spacing:.16em;color:var(--tl-accent);text-transform:uppercase}
.tl-sb-read{position:absolute;right:.85em;top:calc(100% + .22em);display:inline-flex;align-items:center;gap:.3em;
  font-size:.5em;letter-spacing:.12em;text-transform:uppercase;color:var(--tl-faint);font-weight:600}

.tl-poss{margin-top:.48em}
.tl-poss-head{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:.5em;margin-bottom:.32em}
.tl-poss-head .plate-row{display:inline-flex;align-items:center;gap:.35em;min-width:0}
.tl-poss-head .plate-row.right{justify-content:flex-end}
.tl-poss-head .nm{font-size:.58em;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--tl-dim);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tl-poss-kicker{font-size:.5em;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:var(--tl-faint);white-space:nowrap}
.tl-split-track{position:relative;display:flex;height:.42em;overflow:hidden;background:rgba(0,0,0,.24);
  transform:skewX(-14deg);border:1px solid rgba(255,255,255,.14);
  box-shadow:inset 0 1px 0 rgba(255,255,255,.34),inset 0 -1px 0 rgba(0,0,0,.3);
  -webkit-backdrop-filter:var(--tl-glass-track);backdrop-filter:var(--tl-glass-track)}
.tl-split-track .a,.tl-split-track .b{display:block;height:100%;opacity:.94;transition:width 600ms var(--tl-scene)}
.tl-split-track .a{background:linear-gradient(90deg,var(--tl-a-deep),var(--tl-a))}
.tl-split-track .b{background:linear-gradient(90deg,var(--tl-b),var(--tl-b-deep))}
.tl-split-cut{position:absolute;top:-25%;bottom:-25%;width:.18em;background:#fff;box-shadow:0 0 .45em rgba(255,255,255,.85);
  transform:translateX(-50%);transition:left 600ms var(--tl-scene)}
.tl-split-pattern{position:absolute;inset:0;background:repeating-linear-gradient(115deg,rgba(0,0,0,.42) 0 .32em,transparent .32em .64em);opacity:.9}
.tl-split-meta{display:flex;align-items:center;justify-content:space-between;margin-top:.24em}
.tl-split-meta .a,.tl-split-meta .b{font-family:var(--tl-font-display);font-size:1.02em;font-weight:700;line-height:1;letter-spacing:.02em}
.tl-split-meta .a{color:var(--tl-white);border-bottom:.14em solid var(--tl-a);padding-bottom:.04em}
.tl-split-meta .b{color:var(--tl-white);border-bottom:.14em solid var(--tl-b);padding-bottom:.04em}
.tl-poss-state{font-size:.48em;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--tl-faint);text-align:center;white-space:nowrap}
.tl-poss[data-paused=true] .tl-split-track{filter:saturate(.12) brightness(.8)}
.tl-poss[data-paused=true] .tl-split-meta .a,.tl-poss[data-paused=true] .tl-split-meta .b{opacity:.55;border-bottom-color:rgba(255,255,255,.16)}
.tl-poss[data-paused=true] .tl-poss-state{color:var(--tl-warn);opacity:.9}
.tl-poss[data-hidden=true] .tl-split-track{filter:grayscale(1) brightness(.62)}
.tl-poss[data-hidden=true] .tl-split-meta{opacity:.55}

/* ---------- status pill ---------- */
.tl-pill{top:var(--tl-safe-top);right:var(--tl-safe-x);display:flex;align-items:center;gap:.45em;font-size:.8em;
  padding:.5em .7em .5em .78em;--in-y:-10px;--d:55ms;
  clip-path:polygon(0 0,100% 0,100% calc(100% - .42em),calc(100% - .42em) 100%,0 100%);
  white-space:nowrap}
.tl-pill[data-side=left]{left:var(--tl-safe-x);right:auto;clip-path:polygon(0 0,100% 0,100% 100%,.42em 100%,0 calc(100% - .42em))}
.tl-pill-edge{position:absolute;left:0;top:0;bottom:0;width:.18em;background:var(--c,var(--tl-live));box-shadow:0 0 .8em var(--c,var(--tl-live))}
.tl-pill .dot{width:.46em;height:.46em;border-radius:50%;background:var(--c,var(--tl-live));box-shadow:0 0 .7em var(--c,var(--tl-live));flex:none}
.tl-pill[data-state=CALIBRATING] .dot,.tl-pill[data-state=ASK] .dot{animation:tl-blink 1s ease-in-out infinite}
.tl-pill .txt{font-family:var(--tl-font-display);font-size:1.02em;font-weight:700;letter-spacing:.075em;text-transform:uppercase;line-height:1;color:var(--tl-white)}
.tl-pill .sub{font-size:.46em;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--c,var(--tl-accent));opacity:.9}
.tl-pill .hz{font-size:.55em;font-weight:700;letter-spacing:.1em;color:var(--tl-faint);text-transform:uppercase;padding-left:.2em;border-left:1px solid var(--tl-glass-line);margin-left:.05em}
.tl-pill .hz b{font-family:var(--tl-font-display);font-size:1.35em;font-weight:700;color:var(--tl-white);letter-spacing:.02em}
.tl-pill .hz b::after{content:""}
.tl-pill[data-state=REPLAY]{box-shadow:var(--tl-shadow),inset 0 0 0 1px rgba(255,157,60,.42),inset 0 1px 0 var(--tl-glass-inner-light)}
.tl-pill[data-state=PAUSED],.tl-pill[data-state=ASK]{box-shadow:0 0 1.6em rgba(215,255,62,.14),var(--tl-shadow),inset 0 0 0 1px rgba(215,255,62,.38),inset 0 1px 0 var(--tl-glass-inner-light)}
.tl-pill[data-ballout=true]{box-shadow:var(--tl-shadow),inset 0 0 0 1px rgba(255,194,71,.38),inset 0 1px 0 var(--tl-glass-inner-light)}
.tl-eye{width:1.15em;height:1.15em;color:var(--tl-accent);flex:none;opacity:.9}

/* ---------- toast ---------- */
.tl-toast{top:calc(var(--tl-safe-top) + 3.15em);right:var(--tl-safe-x);display:flex;align-items:center;gap:.5em;font-size:.82em;
  padding:.42em .8em .42em .7em;--in-y:-8px;
  clip-path:polygon(0 0,100% 0,100% calc(100% - .38em),calc(100% - .38em) 100%,0 100%)}
.tl-toast-edge{position:absolute;left:0;top:0;bottom:0;width:.16em;background:var(--tl-warn)}
.tl-toast-icon{display:inline-flex;align-items:center;justify-content:center;width:1.1em;height:1.1em;flex:none;
  background:var(--tl-warn);color:var(--tl-ink);font-weight:900;font-size:.68em;clip-path:polygon(0 0,100% 0,100% 100%,.24em 100%,0 calc(100% - .24em))}
.tl-toast b{font-family:var(--tl-font-display);font-size:1.02em;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--tl-white)}
.tl-toast small{font-size:.58em;font-weight:700;letter-spacing:.06em;color:var(--tl-accent);white-space:nowrap}

/* ---------- stat rail ---------- */
.tl-rail{right:var(--tl-safe-x);top:22%;width:13.5em;font-size:.84em;display:flex;flex-direction:column;gap:.42em;--in-x:16px;--in-y:0;--d:110ms}
.tl-rail-head{display:flex;align-items:center;gap:.4em;justify-content:flex-end;margin-bottom:.06em}
.tl-rail-head i{display:block;height:1px;flex:1;background:linear-gradient(90deg,transparent,var(--tl-glass-line-strong))}
.tl-rail-head span{font-size:.5em;font-weight:700;letter-spacing:.2em;text-transform:uppercase;color:var(--tl-faint)}
.tl-tile{position:relative;padding:.55em .75em .55em .82em;overflow:hidden;
  clip-path:polygon(0 0,100% 0,100% calc(100% - .62em),calc(100% - .62em) 100%,0 100%);
  opacity:0;translate:0 -8px;filter:blur(5px);
  transition:opacity var(--tl-d-exit) var(--tl-exit),translate var(--tl-d-exit) var(--tl-exit),filter var(--tl-d-exit) var(--tl-exit)}
.tl-rail[data-show=true] .tl-tile{opacity:1;translate:0 0;filter:none;transition-duration:var(--tl-d-enter);transition-timing-function:var(--tl-enter);transition-delay:calc(var(--i,0) * var(--tl-stagger))}
.tl-tile-edge{position:absolute;left:0;top:0;bottom:0;width:.15em;background:linear-gradient(180deg,var(--tl-a),var(--tl-accent) 55%,var(--tl-b));opacity:.85}
.tl-tile .lbl{display:flex;align-items:center;justify-content:space-between;gap:.4em;font-size:.55em;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--tl-dim)}
.tl-tile .lbl small{font-size:.84em;letter-spacing:.06em;color:var(--tl-warn);text-transform:none}
.tl-tile .val{display:flex;align-items:baseline;gap:.16em;font-family:var(--tl-font-display);font-size:1.82em;font-weight:700;line-height:.98;letter-spacing:.01em;color:var(--tl-white);margin-top:.12em;white-space:nowrap;
  text-shadow:var(--tl-glass-text-strong)}
.tl-tile .val small.unit{font-size:.4em;font-weight:600;letter-spacing:.08em;color:var(--tl-dim);text-transform:uppercase}
.tl-tile .tl-pair{display:inline-flex;align-items:center;gap:.18em;font-size:.6em;line-height:1}
.tl-pair-sep{opacity:.35;font-size:.8em;padding:0 .06em}
.tl-tile[data-paused=true]{opacity:.44;filter:saturate(.15)}
.tl-tile[data-paused=true] .val{color:var(--tl-dim)}
.tl-rail[data-lock=true]{opacity:.46;transition:opacity var(--tl-d-scene) var(--tl-scene)}

/* ---------- Kimi lower third ---------- */
.tl-kcol{left:var(--tl-safe-x);bottom:var(--tl-safe-bottom);width:min(46%,40em);display:flex;flex-direction:column;gap:.4em;--in-x:-18px;--in-y:0;--d:165ms}
.tl-kcol[data-asking=true]{bottom:auto;top:40%;width:min(50%,42em)}
.tl-freeze{position:relative;align-self:flex-start;display:inline-flex;align-items:center;gap:.45em;padding:.22em .55em;
  font-family:var(--tl-font-display);font-size:.62em;font-weight:700;letter-spacing:.17em;text-transform:uppercase;color:var(--tl-accent);
  border-left:.18em solid var(--tl-accent);clip-path:polygon(0 0,100% 0,calc(100% - .4em) 100%,0 100%)}
.tl-freeze i{width:.4em;height:.4em;background:var(--tl-accent);box-shadow:0 0 .5em var(--tl-accent)}
.tl-freeze span{color:var(--tl-faint);letter-spacing:.12em}
.tl-ask-q{position:relative;align-self:flex-start;max-width:100%;display:flex;align-items:baseline;gap:.55em;padding:.32em .7em;
  border-left:.18em solid var(--tl-accent);
  font-size:.72em;font-weight:600;color:var(--tl-white);animation:tl-rise var(--tl-d-enter) var(--tl-enter) both;overflow:hidden}
.tl-ask-q span{font-size:.72em;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--tl-accent);white-space:nowrap}
.tl-ask-q{white-space:nowrap;text-overflow:ellipsis}
.tl-l3{position:relative;display:flex;min-height:4.4em;
  clip-path:polygon(0 0,100% 0,100% calc(100% - .72em),calc(100% - .72em) 100%,0 100%);
  animation:tl-l3-in var(--tl-d-enter) var(--tl-enter) both}
.tl-l3-leaving{position:absolute;left:0;right:0;bottom:0;pointer-events:none;
  animation:tl-l3-out 190ms var(--tl-exit) both}
.tl-kcol[data-show=false] .tl-l3-leaving{opacity:0}
.tl-l3-mark{flex:none;width:3.35em;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.04em;text-shadow:none;
  background:linear-gradient(160deg,rgba(234,255,154,.34),rgba(215,255,62,.28) 52%,rgba(181,223,31,.34));
  color:var(--tl-accent-ink);clip-path:polygon(0 0,100% 0,calc(100% - .8em) 100%,0 100%);position:relative;
  box-shadow:inset 0 0 0 1px rgba(215,255,62,.52),inset 0 1px 0 rgba(255,255,255,.55),inset 0 0 1.4em rgba(215,255,62,.22),0 0 1.2em rgba(215,255,62,.10);
  -webkit-backdrop-filter:var(--tl-glass-mark);backdrop-filter:var(--tl-glass-mark)}
.tl-l3-mark::after{content:"";position:absolute;inset:0;pointer-events:none;
  background:linear-gradient(100deg,rgba(255,255,255,.28),transparent 46%,rgba(255,255,255,.08))}
.tl-l3-mark .glyph{position:relative;z-index:1;font-family:var(--tl-font-display);font-size:1.9em;font-weight:700;line-height:.82;letter-spacing:-.02em}
.tl-l3-mark .word{position:relative;z-index:1;font-size:.44em;font-weight:800;letter-spacing:.2em;text-transform:uppercase;opacity:.82}
.tl-l3-main{position:relative;flex:1;min-width:0;padding:.48em .8em .48em .72em;display:flex;flex-direction:column;gap:.22em;
  background:var(--tl-glass-scrim)}
.tl-l3-main>*{position:relative;z-index:1}
.tl-l3-kicker{display:flex;align-items:center;gap:.42em;min-width:0;font-size:.56em;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:var(--tl-accent)}
.tl-l3-kicker b{font-weight:700;color:var(--tl-accent)}
.tl-l3-kicker .lane{color:var(--tl-faint);font-weight:600}
.tl-l3-kicker .phase{color:var(--tl-faint);font-weight:600;padding-left:.4em;border-left:1px solid var(--tl-glass-line)}
.tl-live-orb{position:relative;display:inline-block;width:.52em;height:.52em;flex:none;border-radius:50%;background:var(--tl-accent);box-shadow:0 0 .55em var(--tl-accent)}
.tl-live-orb[data-live=true]::after{content:"";position:absolute;inset:-.22em;border-radius:50%;border:1px solid var(--tl-accent);animation:tl-ping 1.4s ease-out infinite}
.tl-speed{position:relative;margin-left:auto;display:inline-flex;align-items:center;gap:.48em;padding:.24em .45em;font-size:.9em;font-weight:700;letter-spacing:.02em;
  border-left:.14em solid var(--tl-accent);color:var(--tl-white);text-transform:none;white-space:nowrap}
.tl-speed b{font-family:var(--tl-font-display);font-size:1.42em;font-weight:700;letter-spacing:.02em;color:var(--tl-white);line-height:1}
.tl-speed .dim{font-size:.86em;font-weight:600;letter-spacing:.04em;color:var(--tl-faint)}
.tl-speed .tl-eq{display:inline-flex;align-items:flex-end;gap:.12em;height:.85em;width:1em;flex:none}
.tl-speed .tl-eq b{display:block;width:.18em;background:var(--tl-accent);animation:tl-eq 900ms ease-in-out infinite;height:38%}
.tl-speed .tl-eq b:nth-child(2){animation-delay:140ms;height:78%}
.tl-speed .tl-eq b:nth-child(3){animation-delay:280ms;height:56%}
.tl-speed .tl-eq.done{background:var(--tl-accent);width:.34em;height:.34em;border-radius:50%;box-shadow:0 0 .5em var(--tl-accent)}
.tl-l3-text{font-size:1.1em;line-height:1.32;font-weight:500;letter-spacing:-.005em;color:var(--tl-white);
  display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden;min-height:2.64em;text-wrap:pretty;
  text-shadow:var(--tl-glass-text-strong)}
.tl-words{display:inline}
.tl-word{display:inline-block;animation:tl-word-in 240ms var(--tl-enter) both}
.tl-chip{display:inline-flex;align-items:center;gap:.25em;padding:.08em .4em .1em .32em;margin:0 .08em;vertical-align:.06em;text-shadow:none;
  background:var(--c,var(--tl-neutral));color:var(--ink,var(--tl-ink));font-size:.9em;font-weight:800;line-height:1.15;letter-spacing:.02em;
  clip-path:polygon(0 0,calc(100% - .24em) 0,100% 100%,0 100%);animation:tl-chip-in var(--tl-d-emph) var(--tl-emph) both;white-space:nowrap}
.tl-chip i{width:.34em;height:.34em;background:rgba(255,255,255,.75);flex:none;clip-path:polygon(0 0,100% 0,0 100%)}
.tl-chip.mini{font-size:.82em}
.tl-caret{display:inline-block;width:.36em;height:.95em;vertical-align:-.1em;margin-left:.14em;background:var(--tl-accent);
  box-shadow:0 0 .4em var(--tl-accent);animation:tl-blink .75s steps(1) infinite}
.tl-l3-foot{display:flex;align-items:center;gap:.62em;font-size:.53em;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--tl-faint);min-height:.9em}
.tl-l3-foot b{color:var(--tl-white);font-weight:700}
.tl-l3-foot .late{color:var(--tl-warn);letter-spacing:.1em;font-weight:700}
.tl-l3[data-late=true]{border-color:rgba(255,194,71,.35)}
.tl-l3[data-late=true] .tl-l3-mark{background:linear-gradient(160deg,#aeb4bd,#7f8791)}
.tl-l3[data-late=true] .tl-l3-text{color:var(--tl-dim)}
.tl-l3-think{min-height:4.4em}
.tl-shimmer{height:.68em;border-radius:.1em;margin:.14em 0;
  background:linear-gradient(90deg,rgba(255,255,255,.05) 0%,rgba(255,255,255,.26) 50%,rgba(255,255,255,.05) 100%);
  background-size:220% 100%;animation:tl-shim 1.25s linear infinite}
.tl-l3-think .tl-l3-kicker b{color:var(--tl-warn)}
.tl-l3-think .tl-live-orb{background:var(--tl-warn);box-shadow:0 0 .5em var(--tl-warn)}

.tl-pulse{position:relative;display:flex;align-items:center;gap:.5em;width:max-content;max-width:100%;padding:.26em .55em;
  clip-path:polygon(0 0,100% 0,calc(100% - .32em) 100%,0 100%);
  opacity:0;translate:0 6px;transition:opacity var(--tl-d-exit) var(--tl-exit),translate var(--tl-d-exit) var(--tl-exit)}
.tl-pulse[data-show=true]{opacity:1;translate:0 0;transition-duration:var(--tl-d-enter);transition-timing-function:var(--tl-enter)}
.tl-pulse-label{font-size:.48em;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:var(--tl-faint);white-space:nowrap}
.tl-pulse-ticks{display:flex;align-items:flex-end;gap:2px;height:1.05em}
.tl-pulse-ticks i{display:block;width:2px;height:var(--h,30%);background:var(--tl-accent);flex:none;opacity:.85;
  animation:tl-tick-in var(--tl-d-micro) var(--tl-micro) both}
.tl-pulse-ticks i[data-fat=true]{width:4px;background:var(--tl-warn)}
.tl-pulse-stats{font-size:.48em;font-weight:700;letter-spacing:.08em;color:var(--tl-dim);white-space:nowrap;text-transform:uppercase}
.tl-pulse-stats b{font-family:var(--tl-font-display);font-size:1.4em;font-weight:700;color:var(--tl-white);letter-spacing:.02em}
.tl-pulse-stats .sep{opacity:.4;margin:0 .35em}

/* ---------- prediction ---------- */
.tl-pred{right:var(--tl-safe-x);bottom:calc(var(--tl-safe-bottom) + .85em);width:15.5em;font-size:.9em;display:flex;flex-direction:column;align-items:flex-end;gap:.38em;--in-x:16px;--in-y:0;--d:215ms}
.tl-predcard{position:relative;width:100%;padding:.55em .7em .5em .82em;
  clip-path:polygon(0 0,100% 0,100% calc(100% - .55em),calc(100% - .55em) 100%,0 100%)}
.tl-pred-edge{position:absolute;left:0;top:0;bottom:0;width:.18em;background:var(--tl-accent);box-shadow:0 0 .7em var(--tl-accent-dim)}
.tl-pred-top{display:flex;align-items:center;gap:.4em;font-size:.56em;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:var(--tl-accent)}
.tl-pred-top b{font-weight:700}
.tl-ring{width:1.9em;height:1.9em;flex:none;margin-left:auto;transform:rotate(-90deg)}
.tl-ring circle{fill:none;stroke-width:3}
.tl-ring .bg{stroke:rgba(255,255,255,.16)}
.tl-ring .fg{stroke:var(--tl-accent);stroke-dasharray:56.55;stroke-dashoffset:0;animation:tl-count var(--dur,5s) linear forwards}
.tl-ring[data-paused=true] .fg{animation-play-state:paused}
.tl-pred-text{font-size:.92em;font-weight:600;line-height:1.28;color:var(--tl-white);margin-top:.28em}
.tl-pred-foot{display:flex;align-items:baseline;justify-content:space-between;margin-top:.36em;padding-top:.26em;border-top:1px solid var(--tl-glass-line);
  font-size:.5em;font-weight:700;letter-spacing:.13em;text-transform:uppercase;color:var(--tl-faint)}
.tl-pred-foot b{font-family:var(--tl-font-display);font-size:1.4em;letter-spacing:.04em;color:var(--tl-white)}
.tl-stamp{position:relative;width:100%;padding:.45em .65em .4em .8em;text-align:center;
  background-color:var(--tl-glass-accent-fill);color:var(--tl-white);
  clip-path:polygon(0 0,100% 0,100% calc(100% - .5em),calc(100% - .5em) 100%,0 100%);
  animation:tl-stamp-in var(--tl-d-emph) var(--tl-emph) both;
  box-shadow:0 0 1.6em rgba(215,255,62,.20),var(--tl-shadow),inset 0 0 0 1px rgba(215,255,62,.55),inset 0 1px 0 rgba(255,255,255,.45)}
.tl-stamp i{position:absolute;left:0;top:0;bottom:0;width:.16em;background:rgba(16,21,10,.45)}
.tl-stamp b{display:block;font-family:var(--tl-font-display);font-size:1.72em;font-weight:700;line-height:.95;letter-spacing:.09em;text-transform:uppercase;
  text-shadow:0 1px 3px rgba(0,0,0,.75),0 0 16px rgba(0,0,0,.5)}
.tl-stamp small{display:block;font-size:.5em;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--tl-accent-hot);opacity:.92;margin-top:.24em;
  text-shadow:var(--tl-glass-text-shadow)}
.tl-stamp[data-status=miss]{background-color:rgba(139,147,157,.22);color:var(--tl-neutral);
  box-shadow:var(--tl-shadow),inset 0 0 0 1px rgba(200,208,216,.32),inset 0 1px 0 var(--tl-glass-inner-light)}
.tl-stamp[data-status=void]{background-color:rgba(60,69,79,.18);color:var(--tl-dim);
  box-shadow:var(--tl-shadow),inset 0 0 0 1px rgba(200,208,216,.2),inset 0 1px 0 var(--tl-glass-inner-light)}
.tl-score{position:relative;display:inline-flex;align-items:baseline;gap:.28em;padding:.22em .55em;
  clip-path:polygon(0 0,100% 0,calc(100% - .3em) 100%,0 100%);
  font-size:.56em;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--tl-dim)}
.tl-score b{font-family:var(--tl-font-display);font-size:1.7em;font-weight:700;color:var(--tl-accent);letter-spacing:.03em}
.tl-score i{font-style:normal;opacity:.35}
.tl-score span:last-child{color:var(--tl-white)}

/* ---------- ask / telestrator ---------- */
.tl-ask{left:50%;bottom:calc(var(--tl-safe-bottom) + 1.15em);width:min(34em,82%);font-size:.9em;transform:translateX(-50%);--in-y:18px;
  padding:.55em .62em .58em;
  clip-path:polygon(0 0,100% 0,100% calc(100% - .55em),calc(100% - .55em) 100%,.55em 100%,0 calc(100% - .55em));
  pointer-events:none}
.tl-ask::before{background:var(--tl-glass-rim-accent)}
.tl-ask[data-show=true]{pointer-events:auto}
.tl-ask-head{display:flex;align-items:center;gap:.4em;font-size:.54em;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--tl-accent)}
.tl-ask-head b{font-weight:700}
.tl-ask-head span{color:var(--tl-faint);font-weight:600;letter-spacing:.12em}
.tl-ask form{display:flex;gap:.4em;margin-top:.38em}
.tl-ask input{flex:1;min-width:0;background:rgba(255,255,255,.065);border:1px solid var(--tl-glass-line);border-radius:.2em;
  color:var(--tl-white);font:inherit;font-size:.86em;padding:.56em .65em;outline:none}
.tl-ask input::placeholder{color:var(--tl-faint)}
.tl-ask input:focus{border-color:var(--tl-accent);background:rgba(215,255,62,.06)}
.tl-ask .go{width:2.7em;display:inline-flex;align-items:center;justify-content:center;border:0;background:var(--tl-accent);color:var(--tl-accent-ink);
  cursor:pointer;clip-path:polygon(0 0,100% 0,100% 100%,.3em 100%,0 calc(100% - .3em))}
.tl-ask .go svg{width:1.1em;height:1.1em}
.tl-ask .chips{display:flex;gap:.32em;flex-wrap:wrap;margin-top:.42em}
.tl-ask .chips button{font:600 .62em/1 var(--tl-font-ui);letter-spacing:.03em;background:rgba(255,255,255,.06);color:var(--tl-white);
  border:1px solid var(--tl-glass-line);border-radius:99em;padding:.38em .72em;cursor:pointer}
.tl-ask .chips button:hover{border-color:rgba(215,255,62,.5);background:var(--tl-accent-dim);color:var(--tl-accent)}

/* ---------- replay ---------- */
.tl-replay{left:var(--tl-safe-x);top:47%;width:min(35%,30em);font-size:.86em;padding:.6em .8em .7em .85em;--in-x:-14px;--in-y:0;
  clip-path:polygon(0 0,100% 0,100% calc(100% - .6em),calc(100% - .6em) 100%,0 100%);
  box-shadow:0 0 1.6em rgba(255,157,60,.08),var(--tl-shadow),inset 0 1px 0 var(--tl-glass-inner-light)}
.tl-replay::before{background:var(--tl-glass-rim-replay)}
.tl-replay-head{display:flex;align-items:center;gap:.42em;font-size:.56em;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:var(--tl-replay)}
.tl-replay-head i{display:inline-flex;gap:.12em;align-items:center}
.tl-replay-head i span{display:block;width:.18em;height:.68em;background:var(--tl-replay)}
.tl-replay-head i span:nth-child(2){opacity:.6}.tl-replay-head i span:nth-child(3){opacity:.32}
.tl-replay-head b{font-weight:700}
.tl-replay-head .multi{margin-left:auto;color:var(--tl-faint);letter-spacing:.12em;font-weight:600}
.tl-replay ol{margin:.42em 0 0;padding:0;list-style:none;display:flex;flex-direction:column;gap:.3em}
.tl-replay li{display:flex;gap:.55em;align-items:baseline;font-size:.86em;font-weight:500;line-height:1.3;color:var(--tl-white);opacity:0;translate:-8px 0;
  transition:opacity var(--tl-d-enter) var(--tl-enter),translate var(--tl-d-enter) var(--tl-enter)}
.tl-replay[data-show=true] li{opacity:1;translate:0 0;transition-delay:calc(.08s + var(--i,0) * 90ms)}
.tl-replay li i{display:inline-flex;align-items:center;justify-content:center;width:1.35em;height:1.35em;flex:none;
  font-family:var(--tl-font-display);font-size:.82em;font-style:normal;font-weight:700;color:var(--tl-replay);border:1px solid rgba(255,157,60,.45)}

/* ---------- summary / notice / perf / race ---------- */
.tl-summary{left:50%;top:50%;transform:translate(-50%,-50%) scale(var(--s,1));width:min(30em,86%);font-size:.9em;padding:1.1em 1.35em 1em;--in-y:10px;
  clip-path:polygon(.8em 0,100% 0,100% calc(100% - .8em),calc(100% - .8em) 100%,0 100%,0 .8em);
  text-align:left;background-color:var(--tl-glass-strong);
  background-image:var(--tl-glass-summary-scrim),var(--tl-glass-lift);
  box-shadow:0 2em 5em rgba(0,0,0,.42),0 0 3em rgba(215,255,62,.09),inset 0 0 0 1px rgba(215,255,62,.26),inset 0 1px 0 var(--tl-glass-inner-light)}
.tl-summary::before{background:var(--tl-glass-rim-accent)}
.tl-summary[data-show=true]{--s:1;transform:translate(-50%,-50%) scale(1)}
.tl-summary-brand{display:flex;align-items:center;gap:.42em;font-size:.58em;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--tl-dim)}
.tl-summary-brand .mark{display:inline-flex;align-items:center;justify-content:center;width:1.55em;height:1.55em;text-shadow:none;
  background:var(--tl-accent);color:var(--tl-accent-ink);font-family:var(--tl-font-display);font-size:1.25em;font-weight:700;clip-path:polygon(0 0,100% 0,100% 72%,72% 100%,0 100%)}
.tl-summary-brand b{font-size:1.2em;color:var(--tl-white);letter-spacing:.08em}
.tl-summary-brand span:last-child{font-size:.86em;letter-spacing:.12em;color:var(--tl-faint);margin-left:auto}
.tl-summary-kicker{margin-top:1em;font-size:.58em;font-weight:700;letter-spacing:.18em;text-transform:uppercase;color:var(--tl-accent)}
.tl-summary-hero{display:flex;align-items:baseline;gap:.44em;margin:.16em 0 .34em}
.tl-summary-hero em{font-family:var(--tl-font-display);font-style:normal;font-size:3.1em;font-weight:700;line-height:.9;letter-spacing:.01em;color:var(--tl-white);
  text-shadow:var(--tl-glass-text-strong)}
.tl-summary-hero span{font-size:.6em;font-weight:700;letter-spacing:.16em;text-transform:uppercase;color:var(--tl-dim)}
.tl-summary-hero i{width:1px;height:2.2em;background:var(--tl-glass-line);margin:0 .4em;align-self:center}
.tl-summary-row{display:flex;gap:1em;flex-wrap:wrap;padding-top:.55em;border-top:1px solid var(--tl-glass-line);
  font-size:.58em;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--tl-faint)}
.tl-summary-row b{color:var(--tl-white);font-weight:700}
.tl-notice{left:50%;top:50%;transform:translate(-50%,-50%);width:min(30em,86%);padding:1em 1.25em;
  clip-path:polygon(0 0,100% 0,100% calc(100% - .6em),calc(100% - .6em) 100%,0 100%);
  text-align:center;background-color:var(--tl-glass-strong);
  box-shadow:0 0 1.8em rgba(255,91,98,.10),var(--tl-shadow),inset 0 0 0 1px rgba(255,91,98,.38),inset 0 1px 0 var(--tl-glass-inner-light)}
.tl-notice::before{background:var(--tl-glass-rim-danger)}
.tl-notice b{display:block;font-family:var(--tl-font-display);font-size:1.3em;font-weight:700;letter-spacing:.04em;color:var(--tl-white)}
.tl-notice span{display:block;margin-top:.35em;font-size:.72em;line-height:1.4;color:var(--tl-dim)}
.tl-perf{right:var(--tl-safe-x);top:calc(var(--tl-safe-top) + 8.5em);display:flex;flex-direction:column;gap:.06em;
  padding:.32em .55em .34em .65em;--in-x:12px;--in-y:0;
  border-left:.16em solid var(--tl-accent);clip-path:polygon(0 0,100% 0,100% calc(100% - .32em),calc(100% - .32em) 100%,0 100%);
  font-size:.56em;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--tl-dim);white-space:nowrap}
.tl-perf-main{font-family:var(--tl-font-display);font-size:1.12em;font-weight:700;letter-spacing:.05em;color:var(--tl-white)}
.tl-perf-main b{font-size:1.5em;font-weight:700;color:var(--tl-accent);letter-spacing:.02em}
.tl-perf-sub{color:var(--tl-faint);font-size:.86em}
.tl-kimispeed{left:var(--tl-safe-x);bottom:calc(var(--tl-safe-top) + 1em);display:flex;flex-direction:column;gap:.06em;padding:.4em .7em;white-space:nowrap}
.tl-ks-main{font-family:var(--tl-font-display);font-size:1em;font-weight:600;letter-spacing:.04em;color:var(--tl-white)}
.tl-ks-main i{font-style:normal;color:var(--tl-accent);letter-spacing:.12em;margin-right:.1em}
.tl-ks-main b{color:var(--tl-accent)}
.tl-ks-main em{font-style:normal;color:var(--tl-danger)}
.tl-kimispeed .sep{opacity:.35;margin:0 .35em}
.tl-kimispeed[data-show=false]{display:none}
.tl-kimispeed[data-degraded=true]{border-left-color:var(--tl-danger)}
.tl-perf .sep{opacity:.35;margin:0 .35em}
.tl-perf-live{position:absolute;left:.35em;top:.4em;width:.3em;height:.3em;border-radius:50%;background:var(--tl-live);box-shadow:0 0 .4em var(--tl-live)}
.tl-perf[data-over=true]{border-left-color:var(--tl-danger)}
.tl-perf[data-over=true] .tl-perf-main b{color:var(--tl-danger)}
.tl-label{left:var(--tl-safe-x);top:calc(var(--tl-safe-top) + .25em);display:flex;align-items:center;gap:.4em;padding:.28em .6em;
  clip-path:polygon(0 0,100% 0,calc(100% - .3em) 100%,0 100%);
  font-size:.62em;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:var(--tl-white)}
.tl-label i{width:.4em;height:.4em;background:var(--tl-accent)}
.tl-label[data-kind=slow] i{background:var(--tl-warn)}

/* ---------- race footer ---------- */
.tl-racefooter{position:relative;padding:.5em 1em;text-align:center;font-size:14px;
  background-color:var(--tl-glass-soft);background-image:var(--tl-glass-lift);
  -webkit-backdrop-filter:var(--tl-glass-backdrop-lite);backdrop-filter:var(--tl-glass-backdrop-lite);
  box-shadow:0 -1px 0 rgba(255,255,255,.16) inset,0 -.6em 1.6em rgba(0,0,0,.25)}
.tl-racefooter::before{content:"";position:absolute;left:0;right:0;top:0;height:1px;
  background:linear-gradient(90deg,transparent,rgba(255,255,255,.5) 22%,rgba(255,255,255,.16) 50%,rgba(255,255,255,.5) 78%,transparent)}
.tl-racefooter .count{font-weight:600;font-size:1em;letter-spacing:.02em}
.tl-racefooter .count b{font-family:var(--tl-font-display);font-size:1.25em;letter-spacing:.04em;color:#f7f9fb}
.tl-racefooter .count em{font-family:var(--tl-font-display);font-style:normal;font-size:1.4em;font-weight:700;color:var(--tl-accent);letter-spacing:.02em}
.tl-racefooter .sep{opacity:.35;margin:0 .6em}
.tl-racefooter .fair{color:rgba(247,249,251,.5);font-size:.76em;margin-top:.2em;line-height:1.35}

/* ---------- width tiers ---------- */
/* Showcase / Big HUD scale the em base 1.4x; the rail follows the pill/toast/perf stack. */
.tl-stage[data-showcase=true] .tl-rail{top:calc(var(--tl-safe-top) + 8.0em)}
.tl-hud-root[data-tier=mid] .tl-rail{width:12.5em}
.tl-hud-root[data-tier=mid] .tl-pulse{display:none}
.tl-hud-root[data-tier=mid] .tl-kcol{width:min(62%,38em)}
.tl-hud-root[data-tier=mid] .tl-pred{width:14em}
.tl-hud-root[data-tier=narrow] .tl-rail{display:none}
.tl-hud-root[data-tier=narrow] .tl-pulse{display:none}
.tl-hud-root[data-tier=narrow] .tl-scorebar{left:3%;width:94%;top:3%;padding:.42em .62em .48em;transform:none}
.tl-hud-root[data-tier=narrow] .tl-scorebar-top{gap:.3em}
.tl-hud-root[data-tier=narrow] .tl-sb-identity .name,.tl-hud-root[data-tier=narrow] .tl-poss-head{display:none}
.tl-hud-root[data-tier=narrow] .tl-sb-identity{gap:.2em}
.tl-hud-root[data-tier=narrow] .tl-sb-centre{min-width:3.4em}
.tl-hud-root[data-tier=narrow] .tl-poss-kicker{display:none}
.tl-hud-root[data-tier=narrow] .tl-poss{margin-top:.28em}
.tl-hud-root[data-tier=narrow] .tl-poss-state{display:none}
.tl-hud-root[data-tier=narrow] .tl-sb-identity .tl-plate{font-size:.92em;padding:.2em .44em}
.tl-hud-root[data-tier=narrow] .tl-sb-centre .clock{font-size:.72em}
.tl-hud-root[data-tier=narrow] .tl-pill{top:calc(3% + 7.1em);right:3%;padding:.4em .55em}
.tl-hud-root[data-tier=narrow] .tl-pill .sub,.tl-hud-root[data-tier=narrow] .tl-pill .hz{display:none}
.tl-hud-root[data-tier=narrow] .tl-toast{top:calc(3% + 10.7em);right:3%}
.tl-hud-root[data-tier=narrow] .tl-kcol{left:3%;bottom:var(--tl-safe-bottom);width:94%}
.tl-hud-root[data-tier=narrow] .tl-kcol[data-asking=true]{top:40%;bottom:auto}
.tl-hud-root[data-tier=narrow] .tl-l3{min-height:3.4em}
.tl-hud-root[data-tier=narrow] .tl-l3-text{font-size:1em;-webkit-line-clamp:2;min-height:1.35em}
.tl-hud-root[data-tier=narrow] .tl-l3-mark{width:2.7em}
.tl-hud-root[data-tier=narrow] .tl-l3-kicker{font-size:.52em}
.tl-hud-root[data-tier=narrow] .tl-l3-foot .provider{display:none}
.tl-hud-root[data-tier=narrow] .tl-pred{right:3%;bottom:auto;top:calc(3% + 14.5em);width:12em}
.tl-hud-root[data-tier=narrow] .tl-replay{left:3%;width:94%;top:42%}
.tl-hud-root[data-tier=narrow] .tl-ask{width:94%;bottom:calc(var(--tl-safe-bottom) + 1.05em)}
.tl-hud-root[data-tier=narrow] .tl-summary,.tl-hud-root[data-tier=narrow] .tl-notice{width:92%}
.tl-hud-root[data-tier=narrow] .tl-perf{top:calc(3% + 23em);right:3%;font-size:.48em}
.tl-hud-root[data-tier=narrow] .tl-freeze{font-size:.52em}
.tl-hud-root[data-tier=narrow] .tl-plate{font-size:.58em}
.tl-hud-root[data-tier=narrow] .tl-l3-kicker .phase{display:none}

/* =====================================================================================
   Feed layout (Theatre): glanceable on a phone. Team-colour guide top-right with the speed card under it,
   key stats top-centre, rolling Kimi side chat on the left (its badge shows the mode), Kimi's call bottom-right.
   Everything is scoped under .tl-feed so the extension overlay and the gallery keep the classic HUD.
   ===================================================================================== */
.tl-f{position:absolute;opacity:0;translate:var(--in-x,0) var(--in-y,10px);
  transition:opacity 180ms var(--tl-exit),translate 180ms var(--tl-exit)}
.tl-f[data-show=true]{opacity:1;translate:0 0;transition-duration:380ms;transition-timing-function:var(--tl-enter)}

/* Team guide: compact glass pill, top-right ("TEAM A (swatch) Red | TEAM B (swatch) Yellow"). The mode (Live / Replay / Ball out)
   now lives in the chat header badge. Anchored at the speed card's old spot (top 2.6%, right 2.4%) and the card hangs below it
   (speed-css .tls-mini). font-size is the card's own formula, so "2em tall, card at +2.55em" holds at every pane width.
   The pill is deliberately wider than the old 17em so longer jersey words ("Dark blue", "Light blue") never clip.
   Glass sits on the child, like SideChat: .tl-f is a plain wrapper (a .tl-z would break the backdrop blur with will-change:filter). */
.tl-feed .tl-guide{top:2.6%;right:2.4%;font-size:clamp(8px,1.2cqw,18px);--in-y:-8px}
.tl-guide-pill{position:relative;display:flex;align-items:center;justify-content:center;width:21em;height:2em;padding:0 1em 0 .9em;box-sizing:border-box;border-radius:999em;white-space:nowrap;
  background-color:rgba(5,9,15,.24)}
.tl-guide-seg{display:inline-flex;align-items:center;gap:.42em;min-width:0}
.tl-guide-seg small{font-size:.56em;font-weight:700;letter-spacing:.14em;text-transform:uppercase;line-height:1;color:rgba(247,249,251,.62)}
.tl-guide-seg i{flex:none;display:block;width:.9em;height:.9em;border-radius:50%;border:.09em solid rgba(255,255,255,.92);
  background:radial-gradient(circle at 30% 24%,rgba(255,255,255,.55),rgba(255,255,255,0) 56%),linear-gradient(150deg,var(--c) 35%,var(--deep) 135%);
  box-shadow:0 0 0 1px rgba(0,0,0,.34),0 .08em .3em rgba(0,0,0,.45),inset 0 -.1em .16em rgba(0,0,0,.24)}
.tl-guide-seg b{min-width:0;max-width:6.8em;overflow:hidden;text-overflow:ellipsis;font-size:.86em;font-weight:800;letter-spacing:.01em;line-height:1.1;
  color:#fff;text-shadow:var(--tl-glass-text-strong)}
.tl-guide-div{flex:none;display:block;width:1px;height:1.05em;margin:0 .8em;background:linear-gradient(180deg,transparent,rgba(255,255,255,.42) 30%,rgba(255,255,255,.42) 70%,transparent)}
/* race pane label: top-left safe corner, mirroring the guide's top-right anchor */
.tl-feed .tl-label{left:2.4%;top:2.6%;border-radius:999em;clip-path:none;font-size:.7em;padding:.4em .9em}

/* event flash: big and centred so a glance catches it */
.tl-feed .tl-toast{left:50%;right:auto;top:calc(var(--tl-safe-top) + 8.4em);transform:translateX(-50%);--in-y:-14px;
  font-size:1.5em;padding:.34em 1em .34em .7em;clip-path:none;border-radius:999em;gap:.5em}
.tl-feed .tl-toast-edge{display:none}
.tl-feed .tl-toast-icon{border-radius:50%;clip-path:none;width:1.25em;height:1.25em}
.tl-feed .tl-toast b{font-size:1.15em;letter-spacing:.1em}

/* key stats: small, quiet cards. They pop up, linger (HudStore: STAT_LINGER_MS), then fade out slowly. */
.tl-keystats{top:var(--tl-safe-top);left:50%;transform:translateX(-50%);display:flex;gap:.5em;align-items:stretch;
  --in-y:-6px;font-size:clamp(10px,.98cqw,1.2em);
  /* slow fade-out; the quick enter is restored below when shown */
  transition:opacity 2.8s ease-in-out,translate 2.8s ease-in-out}
.tl-keystats[data-show=true]{transition-duration:380ms,380ms;transition-timing-function:var(--tl-enter)}
.tl-keystats[data-show=true][data-lock=true]{opacity:.5}
.tl-stat{position:relative;width:9.8em;padding:.42em .6em .44em;border-radius:.9em;overflow:hidden;text-align:center;
  background-color:rgba(5,9,15,.3);animation:tl-rise 380ms var(--tl-enter) backwards;animation-delay:calc(var(--i,0) * 70ms)}
.tl-stat-label{font-size:.74em;font-weight:700;letter-spacing:.07em;text-transform:uppercase;line-height:1.1;color:rgba(247,249,251,.88);
  white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:var(--tl-glass-text-shadow)}
.tl-stat-val{display:flex;align-items:baseline;justify-content:center;gap:.22em;margin-top:.1em;white-space:nowrap;
  font-family:var(--tl-font-display);font-size:1.85em;font-weight:700;line-height:1;color:#fff;text-shadow:var(--tl-glass-text-strong)}
.tl-stat-val .a{border-bottom:.07em solid var(--tl-a)}
.tl-stat-val .b{border-bottom:.07em solid var(--tl-b)}
.tl-stat-val .vs{font-size:.5em;font-weight:600;opacity:.5}
.tl-stat-val small.unit{font-size:.4em;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:var(--tl-dim)}
.tl-stat-bar{display:flex;height:.24em;margin-top:.34em;border-radius:99em;overflow:hidden;background:rgba(0,0,0,.3)}
.tl-stat-bar i{display:block;height:100%;transition:width 600ms var(--tl-scene)}
.tl-stat-bar .a{background:var(--tl-a)}
.tl-stat-bar .b{background:var(--tl-b)}
.tl-stat[data-paused=true]{opacity:.55;filter:saturate(.3)}

/* rolling Kimi side chat */
.tl-chat{left:var(--tl-safe-x);bottom:var(--tl-safe-bottom);width:min(32%,27em);max-height:min(64%,26em,calc(82% - 11em));display:flex;flex-direction:column;justify-content:flex-end;gap:.45em;
  font-size:1.05em;--in-x:-18px;--in-y:0;pointer-events:none}
.tl-chat-head{flex:none;align-self:flex-start;display:flex;align-items:center;gap:.6em;padding:.34em .95em .34em .36em;border-radius:999em;
  background-color:rgba(5,9,15,.34)}
.tl-chat-avatar{display:grid;place-items:center;width:2.05em;height:2.05em;border-radius:50%;flex:none;text-shadow:none;
  background:linear-gradient(160deg,#eaff9a,#d7ff3e 55%,#b5df1f);color:var(--tl-accent-ink);
  box-shadow:0 0 1.1em rgba(215,255,62,.45),inset 0 1px 0 rgba(255,255,255,.7)}
.tl-chat-avatar svg{width:1.15em;height:1.15em}
.tl-chat-name b{display:block;font-size:1.04em;font-weight:800;letter-spacing:.02em;line-height:1.05;color:#fff}
.tl-chat-name small{display:block;margin-top:.12em;font-size:.68em;font-weight:600;letter-spacing:.05em;color:var(--tl-dim)}
.tl-chat-live{display:inline-flex;align-items:center;gap:.4em;margin-left:.35em;padding-left:.7em;border-left:1px solid var(--tl-glass-line);
  font-size:.68em;font-weight:800;letter-spacing:.15em;text-transform:uppercase;white-space:nowrap;--c:var(--tl-accent);color:var(--c)}
.tl-chat-live i{display:block;width:.62em;height:.62em;border-radius:50%;background:var(--c);box-shadow:0 0 .6em var(--c);
  animation:tl-blink 1.4s ease-in-out infinite}
/* the badge doubles as the mode readout: amber for ball out / freeze / replay, blue for close-up, steady while frozen */
.tl-chat-live[data-state=LIVE][data-ballout=true],.tl-chat-live[data-state=PAUSED],.tl-chat-live[data-state=REPLAY]{--c:var(--tl-warn)}
.tl-chat-live[data-state=CLOSE_UP]{--c:#9dc1ff}
.tl-chat-live[data-state=PAUSED] i,.tl-chat-live[data-state=REPLAY] i{animation:none}
.tl-chat-list{flex:0 1 auto;min-height:0;display:flex;flex-direction:column;justify-content:flex-end;overflow:hidden}
.tl-msgrow{flex:none;display:grid;grid-template-rows:1fr;justify-items:start;animation:tl-row-grow 460ms var(--tl-enter) backwards}
.tl-msgrow[data-you=true]{justify-items:end}
.tl-msgclip{min-height:0;min-width:0;max-width:100%;overflow:hidden;padding-top:.5em}
.tl-msg{position:relative;display:block;width:fit-content;max-width:100%;padding:.55em .85em .62em;border-radius:1.15em 1.15em 1.15em .4em;
  background-color:rgba(5,9,15,.36);
  opacity:calc(1 - var(--age,0) * .2);transition:opacity 500ms var(--tl-scene)}
.tl-msgrow[data-newest=true] .tl-msg{animation:tl-msg-in 460ms var(--tl-emph) backwards;
  box-shadow:0 0 1.5em rgba(215,255,62,.16),var(--tl-shadow),inset 0 1px 0 var(--tl-glass-inner-light)}
.tl-msg-tag{display:block;margin-bottom:.22em;font-size:.62em;font-weight:800;letter-spacing:.15em;text-transform:uppercase;color:var(--tl-accent)}
.tl-msg-text{font-size:1.18em;line-height:1.3;font-weight:500;color:#fff;text-shadow:var(--tl-glass-text-strong);text-wrap:pretty;
  display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:3;overflow:hidden}
.tl-msgrow[data-newest=true] .tl-msg-text{font-weight:600;-webkit-line-clamp:6}
.tl-msg[data-you=true]{background-color:rgba(215,255,62,.22);border-radius:1.15em 1.15em .4em 1.15em;
  box-shadow:inset 0 0 0 1px rgba(215,255,62,.5),inset 0 1px 0 rgba(255,255,255,.4)}
.tl-msg[data-sys=true]{border-radius:1.15em;background-color:rgba(5,9,15,.5);box-shadow:inset 0 0 0 1px rgba(255,194,71,.35),inset 0 1px 0 var(--tl-glass-inner-light)}
.tl-msg[data-sys=true] .tl-msg-tag{color:var(--tl-warn)}
.tl-msg[data-sys=true] .tl-msg-text{font-weight:500;font-size:1.02em;color:rgba(247,249,251,.9)}
.tl-msg[data-late=true]{box-shadow:inset 0 0 0 1px rgba(255,194,71,.4),inset 0 1px 0 var(--tl-glass-inner-light)}
.tl-msg[data-late=true] .tl-msg-tag{color:var(--tl-warn)}
.tl-msg[data-late=true] .tl-msg-text{color:var(--tl-dim)}
.tl-typing{display:inline-flex;align-items:center;gap:.34em;padding:.72em .95em}
.tl-typing i{display:block;width:.5em;height:.5em;border-radius:50%;background:var(--tl-white);opacity:.4;animation:tl-dot 1.1s ease-in-out infinite}
.tl-typing i:nth-child(2){animation-delay:.16s}
.tl-typing i:nth-child(3){animation-delay:.32s}
.tl-feed .tl-chip{font-size:.86em}
.tl-feed .tl-caret{height:.85em}

/* replay breakdown moves above the chat; ask bar moves right of it */
.tl-chat[data-state=REPLAY]{max-height:min(36%,14em)}
.tl-feed .tl-replay{top:20%;width:min(32%,27em);border-radius:1.1em;clip-path:none}
.tl-feed .tl-ask{left:auto;right:var(--tl-safe-x);transform:none;width:min(30em,38%);--in-y:18px;border-radius:1.1em;clip-path:none;font-size:1em}
.tl-feed[data-state=PAUSED] .tl-pred,.tl-feed[data-state=ASK] .tl-pred{display:none}

/* Kimi's call, bottom-right, round and bigger */
.tl-feed .tl-pred{width:16.5em;font-size:1em}
.tl-feed .tl-predcard,.tl-feed .tl-stamp{clip-path:none;border-radius:1.1em}
.tl-feed .tl-pred-edge,.tl-feed .tl-stamp i{display:none}
.tl-feed .tl-pred-text{font-size:1.02em}
.tl-feed .tl-score{clip-path:none;border-radius:999em;font-size:.66em;padding:.3em .9em}
.tl-feed .tl-summary,.tl-feed .tl-notice{clip-path:none;border-radius:1.3em}
.tl-feed .tl-kimispeed{bottom:auto;top:calc(var(--tl-safe-top) + 6em)}
.tl-feed .tl-perf{top:auto;bottom:calc(var(--tl-safe-bottom) + 12em)}

/* narrow / phone-shaped: guide + speed chip stack top-right, stats become a full-width row under them, chat spans the bottom.
   The strip hangs from the chip's real bottom: chip top = 2.6% + 2.9em and ~3.4em tall, all in the chip's own
   clamp(8px,2.7cqw,14px) em (speed-css @container 640px), plus an 8px gap. */
.tl-feed[data-tier=narrow] .tl-label{left:3%;top:2.6%}
.tl-feed[data-tier=narrow] .tl-toast{top:calc(3% + 12.5em);right:auto;font-size:1.25em}
.tl-feed[data-tier=narrow] .tl-keystats{top:calc(2.6% + 6.5 * clamp(8px,2.7cqw,14px) + 8px);left:3%;width:94%;transform:none;font-size:.95em;gap:.45em}
.tl-feed[data-tier=narrow] .tl-stat{flex:1;width:auto;min-width:0;padding:.4em .4em .42em}
.tl-feed[data-tier=narrow] .tl-stat-val{font-size:1.9em}
.tl-feed[data-tier=narrow] .tl-chat{left:3%;right:3%;width:auto;bottom:var(--tl-safe-bottom);max-height:min(46%,19em);font-size:1em}
.tl-feed[data-tier=narrow] .tl-chat-name small{display:none}
.tl-feed[data-tier=narrow] .tl-pred{right:3%;left:auto;top:auto;bottom:calc(var(--tl-safe-bottom) + min(46%,19em) + .6em);width:13em}
.tl-feed[data-tier=narrow] .tl-ask{right:3%;left:3%;width:auto;bottom:calc(var(--tl-safe-bottom) + 1.05em)}
.tl-feed[data-tier=narrow] .tl-replay{left:3%;width:94%;top:32%}
.tl-feed[data-tier=narrow] .tl-perf{top:auto;bottom:calc(var(--tl-safe-bottom) + 20em);right:3%}
/* phone-shaped pane: the team guide shrinks and follows the speed chip's breakpoint and right margin (speed-css.ts, same 640px query) */
@container (max-width:640px){
  .tl-feed .tl-guide{right:3%;font-size:clamp(10px,2.8cqw,12px)}
  .tl-feed .tl-guide-pill{width:auto}
  .tl-feed .tl-guide-seg small{font-size:.62em}
}

@keyframes tl-row-grow{from{grid-template-rows:0fr}}
@keyframes tl-msg-in{0%{opacity:0;translate:0 1.1em;scale:.94;filter:blur(5px)}100%{translate:0 0;scale:1;filter:blur(0)}}
@keyframes tl-dot{0%,100%{opacity:.35;translate:0 0}40%{opacity:1;translate:0 -.22em}}

@keyframes tl-word-in{from{opacity:.08;translate:0 .2em;filter:blur(3px)}to{opacity:1;translate:0 0;filter:blur(0)}}
@keyframes tl-l3-in{from{opacity:0;translate:-18px 0;filter:blur(6px)}to{opacity:1;translate:0 0;filter:blur(0)}}
@keyframes tl-l3-out{from{opacity:.72;translate:0 0;filter:blur(0)}to{opacity:0;translate:-12px 0;filter:blur(4px)}}
@keyframes tl-chip-in{0%{opacity:.2;translate:0 .16em;filter:blur(2px)}100%{opacity:1;translate:0 0;filter:blur(0)}}
@keyframes tl-rise{from{opacity:0;translate:0 14px;filter:blur(5px)}to{opacity:1;translate:0 0;filter:blur(0)}}
@keyframes tl-blink{0%,100%{opacity:1}50%{opacity:.22}}
@keyframes tl-ping{0%{opacity:.65;scale:.7}70%,100%{opacity:0;scale:1.75}}
@keyframes tl-eq{0%,100%{height:26%}50%{height:96%}}
@keyframes tl-tick-in{from{height:8%;opacity:.2}to{opacity:.85}}
@keyframes tl-count{from{stroke-dashoffset:0}to{stroke-dashoffset:56.55}}
@keyframes tl-stamp-in{0%{opacity:0;scale:1.24;translate:0 -.2em;filter:blur(2px)}70%{opacity:1;scale:.985;translate:0 0;filter:blur(0)}100%{scale:1}}
@keyframes tl-shim{from{background-position:220% 0}to{background-position:-220% 0}}

@media (prefers-reduced-motion:reduce){
  .tl-hud-root .tl-word,.tl-hud-root .tl-l3,.tl-hud-root .tl-chip,.tl-hud-root .tl-pulse-ticks i,.tl-hud-root .tl-live-orb::after{animation-duration:1ms!important}
  .tl-z,.tl-tile,.tl-replay li,.tl-pulse{transition-duration:1ms!important}
  .tl-glass-sheen::after{animation:none!important;opacity:0!important}
}
`;
