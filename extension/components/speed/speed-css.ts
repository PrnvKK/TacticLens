// Speed wall styles. Liquid Glass tokens come from lib/render/tokens.ts (read-only).
// Everything is em-based off one font-size set on .tls-sp, which scales with its container
// (cqw), so the same markup reads at 1080p full-screen and in a phone crop.
import { COLOUR, DISPLAY_STACK, UI_STACK, GLASS, GLASS_BACKDROP_LITE } from '../../lib/render/tokens';

const A = COLOUR.accent;
const O = COLOUR.replay;
const D = COLOUR.danger;
const glass = `background:${GLASS.lift},${GLASS.fill};backdrop-filter:${GLASS_BACKDROP_LITE};-webkit-backdrop-filter:${GLASS_BACKDROP_LITE};border:1px solid ${GLASS.edge};box-shadow:${GLASS.shadow},inset 0 1px 0 ${GLASS.innerLight};border-radius:${GLASS.radius};`;

export const SPEED_CSS = `
.tls-spc{container-type:inline-size;width:100%;height:100%;position:relative;pointer-events:none}
.tls-sp{font-size:clamp(9px,1.45cqw,30px);font-family:${UI_STACK};color:${COLOUR.white};text-shadow:${GLASS.textShadow};
  position:relative;width:100%;height:100%;box-sizing:border-box;padding:1.4em;display:grid;gap:1em;
  grid-template-columns:1.55fr 1fr;grid-template-rows:auto 1fr;font-variant-numeric:tabular-nums}
.tls-card{${glass}position:relative;overflow:hidden;padding:1em 1.2em;box-sizing:border-box;min-width:0}
.tls-card::after{content:'';position:absolute;inset:0;border-radius:inherit;background:${GLASS.sheen};opacity:.5;pointer-events:none}
.tls-k{font:700 .72em/1 ${UI_STACK};letter-spacing:.16em;text-transform:uppercase;color:rgba(247,249,251,.78)}
.tls-hero{grid-row:1 / span 2;display:flex;flex-direction:column;justify-content:space-between;
  background:${GLASS.lift},${GLASS.fillStrong};border-image:none;box-shadow:${GLASS.shadow},0 0 4em rgba(215,255,62,.16),inset 0 1px 0 ${GLASS.innerLight}}
.tls-num{font:800 11.5em/.86 ${DISPLAY_STACK};letter-spacing:-.01em;color:${A};text-shadow:0 0 .35em rgba(215,255,62,.55),0 .04em .08em rgba(0,0,0,.6);margin:.08em 0 .02em;white-space:nowrap}
.tls-num[data-hot="1"]{color:${COLOUR.accentHot};animation:tls-pop .5s cubic-bezier(.34,1.56,.64,1)}
.tls-unit{font:700 1.5em/1 ${DISPLAY_STACK};letter-spacing:.14em;color:${COLOUR.white}}
.tls-unit small{font:600 .55em ${UI_STACK};letter-spacing:.08em;opacity:.7;margin-left:.8em}
.tls-row{display:flex;gap:1.1em;align-items:flex-end;justify-content:space-between;flex-wrap:wrap}
.tls-peak{display:inline-flex;align-items:center;gap:.6em;padding:.45em .9em;border-radius:999px;background:${GLASS.accentFill};
  border:1px solid rgba(215,255,62,.55);font:800 1.5em/1 ${DISPLAY_STACK};letter-spacing:.06em;color:${COLOUR.accentHot}}
.tls-peak i{font-style:normal;font:700 .5em ${UI_STACK};letter-spacing:.16em;opacity:.85}
.tls-peak[data-new="1"]{animation:tls-flash .9s ease-out}
.tls-stat b{display:block;font:800 2.6em/1 ${DISPLAY_STACK};margin-top:.15em}
.tls-stat span{font:600 .6em ${UI_STACK};letter-spacing:.1em;opacity:.75}
.tls-stats{display:flex;gap:1.6em;flex-wrap:wrap}
.tls-spark{width:100%;height:4.2em;display:block;margin-top:.5em}
.tls-ticker{display:flex;flex-direction:column;gap:.45em;min-height:0}
.tls-call{display:grid;grid-template-columns:2.4em 1fr auto;align-items:center;gap:.7em;position:relative;padding:.38em .6em;border-radius:.5em;background:rgba(255,255,255,.05);overflow:hidden;animation:tls-slide .32s cubic-bezier(.16,1,.3,1)}
.tls-call .bar{position:absolute;left:0;top:0;bottom:0;background:linear-gradient(90deg,rgba(215,255,62,.34),rgba(215,255,62,.05));z-index:0}
.tls-call>*{position:relative;z-index:1}
.tls-call .ln{font:700 .62em ${UI_STACK};letter-spacing:.1em;opacity:.85;text-transform:uppercase}
.tls-call .tt{font:600 .8em ${UI_STACK};opacity:.9}
.tls-call .tp{font:800 1.55em/1 ${DISPLAY_STACK};color:${A};text-align:right}
.tls-call .tp small{font:600 .5em ${UI_STACK};opacity:.7;margin-left:.3em}
.tls-live{display:inline-flex;align-items:center;gap:.5em}
.tls-live::before{content:'';width:.6em;height:.6em;border-radius:50%;background:${COLOUR.live};box-shadow:0 0 .8em ${COLOUR.live};animation:tls-blink 1s infinite}
.tls-dps{font:800 3.2em/1 ${DISPLAY_STACK};color:${COLOUR.white}}
.tls-dps small{font:700 .38em ${UI_STACK};letter-spacing:.1em;opacity:.75;margin-left:.4em}
.tls-rowend{display:inline-flex;align-items:center;gap:.6em}
.tls-racebtn{pointer-events:auto;cursor:pointer;font:800 .6em/1 ${UI_STACK};letter-spacing:.14em;text-transform:uppercase;
  color:${COLOUR.accentInk};background:${A};border:0;border-radius:999px;padding:.55em 1em;text-shadow:none;
  box-shadow:0 0 1.2em rgba(215,255,62,.35);transition:background .14s,transform .14s}
.tls-racebtn:hover{background:${COLOUR.accentHot};transform:translateY(-1px)}
.tls-racebtn span{font-size:1.15em}
.tls-foot{margin-top:.45em;font:700 .6em/1.3 ${UI_STACK};letter-spacing:.14em;text-transform:uppercase;opacity:.8}
.tls-foot b{color:${A};font-weight:800}
.tls-foot .dot{opacity:.4;margin:0 .45em}
.tls-foot small{display:block;margin-top:.3em;font:500 .95em/1.35 ui-monospace,'Cascadia Mono',Consolas,monospace;
  letter-spacing:.01em;text-transform:none;opacity:.55}

/* Compact wall (Theatre default). Top-right, hanging under the team-colour guide (hud-css .tl-guide: top 2.6%, right 2.4%,
   2em tall in this same font-size formula), clear of the top-centre stat cards and the left chat. */
.tls-mini{position:absolute;top:calc(2.6% + 2.55em);right:2.4%;width:21em;font-size:clamp(8px,1.2cqw,18px);box-sizing:border-box;
  font-family:${UI_STACK};color:${COLOUR.white};text-shadow:${GLASS.textShadowStrong};font-variant-numeric:tabular-nums;
  display:flex;flex-direction:column;gap:.4em;padding:.7em .95em .75em;border-radius:1.15em;
  background:${GLASS.lift},rgba(4,8,13,.14);backdrop-filter:${GLASS_BACKDROP_LITE};-webkit-backdrop-filter:${GLASS_BACKDROP_LITE};
  border:1px solid ${GLASS.edge};box-shadow:${GLASS.shadowTight},0 0 2em rgba(215,255,62,.1),inset 0 1px 0 ${GLASS.innerLight};
  overflow:hidden;pointer-events:none}
.tls-mini::after{content:'';position:absolute;inset:0;border-radius:inherit;background:${GLASS.sheen};opacity:.3;pointer-events:none}
.tls-mini[data-idle="1"]{opacity:.9}
.tls-mini-head{display:flex;align-items:center;gap:.6em;position:relative;z-index:1}
.tls-mini-head .tls-k{font-size:.74em;color:${COLOUR.white}}
.tls-mini-brand{font:700 .72em/1.1 ${UI_STACK};letter-spacing:.09em;text-transform:uppercase;color:rgba(247,249,251,.82);
  padding-left:.65em;border-left:1px solid rgba(255,255,255,.3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.tls-mini-race{pointer-events:auto;cursor:pointer;font:800 .58em/1 ${UI_STACK};letter-spacing:.13em;text-transform:uppercase;margin-left:auto;
  color:${COLOUR.accentInk};background:${A};border:0;border-radius:999px;padding:.5em .85em;text-shadow:none}
.tls-mini-race:hover{background:${COLOUR.accentHot}}
.tls-mini-body{display:flex;align-items:flex-end;gap:.6em;position:relative;z-index:1}
.tls-mini-num{font:800 3.9em/.82 ${DISPLAY_STACK};letter-spacing:-.01em;color:${A};white-space:nowrap;
  text-shadow:0 0 .3em rgba(215,255,62,.55),0 .04em .08em rgba(0,0,0,.65)}
.tls-mini-num[data-hot="1"]{color:${COLOUR.accentHot};animation:tls-pop .5s cubic-bezier(.34,1.56,.64,1)}
.tls-mini-unit{font:800 .85em/1.1 ${DISPLAY_STACK};letter-spacing:.1em;text-transform:uppercase;padding-bottom:.2em;color:${COLOUR.white}}
.tls-mini-unit .u-short{display:none}
.tls-mini .tls-spark{height:1.5em;margin:0;position:relative;z-index:1}
.tls-mini-agg{position:relative;z-index:1;display:flex;align-items:baseline;gap:.35em;
  font:700 .62em/1 ${UI_STACK};letter-spacing:.1em;text-transform:uppercase;color:rgba(247,249,251,.6)}
.tls-mini-agg b{font:800 1.15em/1 ${DISPLAY_STACK};letter-spacing:.02em;color:${COLOUR.white}}
.tls-mini-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:.5em;position:relative;z-index:1;
  padding-top:.5em;border-top:1px solid rgba(255,255,255,.2)}
.tls-mini-stats div{min-width:0}
.tls-mini-stats b{display:block;font:800 1.7em/1 ${DISPLAY_STACK};letter-spacing:.02em;color:${COLOUR.white};white-space:nowrap}
.tls-mini-stats b small{font:700 .5em ${UI_STACK};letter-spacing:.06em;margin-left:.25em;color:rgba(247,249,251,.7)}
.tls-mini-stats span{display:block;margin-top:.2em;font:700 .64em/1.15 ${UI_STACK};letter-spacing:.06em;text-transform:uppercase;color:rgba(247,249,251,.72)}
.tls-mini-wait{position:relative;z-index:1;padding-top:.5em;border-top:1px solid rgba(255,255,255,.2);
  font:700 .74em/1 ${UI_STACK};letter-spacing:.1em;text-transform:uppercase;color:rgba(247,249,251,.78);animation:tls-blink 1.4s infinite}
.tls-mini-foot{font:700 .56em/1 ${UI_STACK};letter-spacing:.14em;text-transform:uppercase;color:${A};opacity:.85;position:relative;z-index:1}

/* Race */
.tls-race{font-size:clamp(9px,1.45cqw,30px);font-family:${UI_STACK};color:${COLOUR.white};text-shadow:${GLASS.textShadow};position:relative;width:100%;height:100%;box-sizing:border-box;padding:1.4em;display:grid;grid-template-columns:1fr 1fr;gap:1.1em;font-variant-numeric:tabular-nums}
.tls-lane{display:flex;flex-direction:column;gap:.7em;min-width:0}
.tls-lane[data-side="a"]{box-shadow:${GLASS.shadow},0 0 3.5em rgba(215,255,62,.2),inset 0 1px 0 ${GLASS.innerLight}}
.tls-lane[data-win="1"]{border-color:${A}}
.tls-lane[data-side="b"]{filter:saturate(.55)}
.tls-lane[data-side="b"] .tls-big{color:${O}}
.tls-lhead{display:flex;justify-content:space-between;align-items:baseline;gap:1em}
.tls-lname{font:800 1.8em/1 ${DISPLAY_STACK};letter-spacing:.08em}
.tls-lsub{font:600 .7em ${UI_STACK};opacity:.7;letter-spacing:.08em}
.tls-big{font:800 8em/.9 ${DISPLAY_STACK};color:${A};text-shadow:0 0 .3em rgba(215,255,62,.45),0 .04em .08em rgba(0,0,0,.6);white-space:nowrap}
.tls-big small{font:700 .2em ${UI_STACK};letter-spacing:.14em;margin-left:.6em;color:${COLOUR.white};opacity:.85}
.tls-watch{font:800 2.8em/1 ${DISPLAY_STACK};letter-spacing:.04em}
.tls-meta{display:flex;gap:1.4em;align-items:baseline;flex-wrap:wrap}
.tls-text{flex:1;min-height:7em;font:500 .95em/1.45 ui-monospace,'Cascadia Mono',Consolas,monospace;background:rgba(3,6,10,.32);border-radius:.6em;padding:.8em;overflow:hidden;position:relative;white-space:pre-wrap;word-break:break-word}
.tls-text::before{content:'';position:absolute;left:0;right:0;top:0;height:2.2em;background:linear-gradient(180deg,rgba(3,6,10,.5),transparent);z-index:1}
.tls-text .in{position:absolute;left:.8em;right:.8em;bottom:.8em}
.tls-text .cur{display:inline-block;width:.5em;height:1em;background:${A};vertical-align:-.15em;animation:tls-blink .8s infinite}
.tls-done{position:absolute;right:1em;top:1em;font:800 1.2em ${DISPLAY_STACK};letter-spacing:.14em;padding:.35em .8em;border-radius:.4em;background:${A};color:${COLOUR.accentInk};text-shadow:none;animation:tls-pop .5s cubic-bezier(.34,1.56,.64,1)}
.tls-wait{font:700 .8em ${UI_STACK};letter-spacing:.14em;opacity:.8;animation:tls-blink 1.2s infinite}
.tls-vs{position:absolute;left:50%;top:1.4em;transform:translateX(-50%);z-index:5;text-align:center}
.tls-x{display:inline-block;font:800 5em/1 ${DISPLAY_STACK};padding:.12em .4em;border-radius:.2em;background:${A};color:${COLOUR.accentInk};text-shadow:none;box-shadow:0 0 2.4em rgba(215,255,62,.55),${GLASS.shadow};transform:rotate(-3deg)}
.tls-x small{font:800 .26em ${UI_STACK};letter-spacing:.14em;margin-left:.4em}
.tls-x[data-final="1"]{animation:tls-pop .6s cubic-bezier(.34,1.56,.64,1)}
.tls-race{grid-template-rows:1fr auto}
.tls-racefoot{grid-column:1/-1;display:flex;align-items:center;gap:1em;min-width:0;padding:.1em .2em 0;pointer-events:auto}
.tls-racesub{font:800 .7em/1.2 ${UI_STACK};letter-spacing:.12em;text-transform:uppercase;opacity:.88;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tls-racesub[data-error="1"]{color:${D};text-transform:none;letter-spacing:.03em;font-weight:600}
.tls-start{pointer-events:auto;cursor:pointer;flex:none;font:800 .72em/1 ${UI_STACK};letter-spacing:.14em;text-transform:uppercase;
  color:${COLOUR.accentInk};background:${A};border:0;border-radius:999px;padding:.75em 1.35em;text-shadow:none;
  box-shadow:0 0 1.4em rgba(215,255,62,.4);transition:background .14s,transform .14s}
.tls-start:hover:not(:disabled){background:${COLOUR.accentHot};transform:translateY(-1px)}
.tls-start:disabled{opacity:.45;cursor:default}
.tls-racek{margin-left:auto;font:500 .58em/1.3 ${UI_STACK};letter-spacing:.02em;opacity:.52;text-align:right;max-width:34em}
.tls-blocked{flex:1;display:flex;flex-direction:column;justify-content:center;gap:.6em;padding:1.1em;border-radius:.6em;
  border:1px dashed rgba(255,255,255,.22);background:rgba(3,6,10,.3)}
.tls-blocked b{font:800 1.7em/1.02 ${DISPLAY_STACK};letter-spacing:.03em;color:${O}}
.tls-blocked span{font:600 .78em/1.35 ${UI_STACK};opacity:.68}
.tls-laneerr{margin-top:auto;font:600 .72em/1.35 ${UI_STACK};color:${D};background:rgba(255,91,98,.1);
  border:1px solid rgba(255,91,98,.32);border-radius:.4em;padding:.45em .6em;word-break:break-word}

/* Intro burst */
.tls-burst{position:absolute;inset:0;z-index:50;display:grid;place-items:center;background:radial-gradient(60% 60% at 50% 50%,rgba(215,255,62,.16),rgba(3,6,10,.92) 70%);overflow:hidden;font-size:clamp(9px,1.45cqw,30px);font-family:${UI_STACK};color:${COLOUR.white};pointer-events:none}
.tls-burst[data-out="1"]{animation:tls-out .35s ease-in forwards}
.tls-streak{position:absolute;left:50%;top:50%;width:80%;height:.22em;transform-origin:0 50%;background:linear-gradient(90deg,rgba(215,255,62,.95),rgba(215,255,62,0));opacity:0;animation:tls-streak .75s cubic-bezier(.16,1,.3,1) forwards}
.tls-bnum{position:relative;font:800 22em/.85 ${DISPLAY_STACK};color:${A};text-shadow:0 0 .3em rgba(215,255,62,.7),0 .03em .06em rgba(0,0,0,.7);animation:tls-shake .45s linear}
.tls-bunit{position:relative;text-align:center;font:800 3.4em/1 ${DISPLAY_STACK};letter-spacing:.3em;margin-top:.4em}
.tls-bsub{position:relative;text-align:center;font:600 1.2em ${UI_STACK};letter-spacing:.22em;opacity:.8;margin-top:1em}
.tls-bttft{position:relative;text-align:center;font:700 .95em ${UI_STACK};letter-spacing:.18em;text-transform:uppercase;opacity:.62;margin-top:.75em}
.tls-flash{position:absolute;inset:0;background:#fff;opacity:0;animation:tls-fl .35s ease-out}

@keyframes tls-pop{0%{transform:scale(.86)}100%{transform:scale(1)}}
@keyframes tls-flash{0%{box-shadow:0 0 0 0 rgba(215,255,62,.9)}100%{box-shadow:0 0 0 1.6em rgba(215,255,62,0)}}
@keyframes tls-slide{0%{transform:translateY(-.8em);opacity:0}100%{transform:none;opacity:1}}
@keyframes tls-blink{50%{opacity:.25}}
@keyframes tls-out{to{opacity:0;transform:scale(1.06)}}
@keyframes tls-streak{0%{opacity:0;transform:rotate(var(--r)) scaleX(.05)}25%{opacity:1}100%{opacity:0;transform:rotate(var(--r)) scaleX(1.2)}}
@keyframes tls-fl{0%{opacity:.85}100%{opacity:0}}
@keyframes tls-shake{0%,100%{transform:translate(0)}20%{transform:translate(-.05em,.03em)}40%{transform:translate(.05em,-.03em)}60%{transform:translate(-.03em,-.02em)}80%{transform:translate(.03em,.02em)}}

/* Phone crop: one column, hero first, ticker trimmed */
@container (max-width: 640px){
  .tls-sp{grid-template-columns:1fr;grid-template-rows:auto;font-size:clamp(9px,3.1cqw,30px);padding:.8em;gap:.7em}
  .tls-hero{grid-row:auto}
  .tls-num{font-size:9em}
  .tls-call:nth-child(n+5){display:none}
  .tls-race{grid-template-columns:1fr;grid-auto-rows:1fr;font-size:clamp(9px,3.1cqw,30px);padding:.8em;gap:.7em}
  .tls-big{font-size:5.6em}
  .tls-x{font-size:3.4em}
  .tls-vs{top:50%;transform:translate(-50%,-50%)}
  .tls-text{min-height:4em}
  .tls-bnum{font-size:15em}
  /* Phone player: shrink the card to one slim chip (number + unit) in the top-right corner. */
  .tls-mini{width:auto;max-width:48%;top:calc(2.6% + 2.9em);right:3%;font-size:clamp(8px,2.7cqw,14px);gap:0;padding:.5em .8em .45em;border-radius:1em}
  .tls-mini-head,.tls-mini .tls-spark,.tls-mini-stats,.tls-mini-wait,.tls-mini-foot{display:none}
  .tls-mini-num{font-size:3em}
  .tls-mini-unit .u-long{display:none}
  .tls-mini-unit .u-short{display:inline;font-size:1.2em}
  .tls-racek{display:none}
  .tls-racefoot{flex-wrap:wrap}
}
@media (prefers-reduced-motion:reduce){.tls-streak,.tls-flash,.tls-bnum{animation:none}}
`;
