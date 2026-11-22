import { describe, expect, it } from 'vitest';
import { Governor } from '../../src/llm/governor';

function clock() { let t = 0; return { now: () => t, adv: (ms: number) => { t += ms; } }; }

describe('Governor', () => {
  it('cancel-and-replace: one in flight per lane, other lanes independent', () => {
    const c = clock();
    const g = new Governor({ now: c.now });
    const a = g.acquire('watch');
    const r = g.acquire('reflex');
    expect(a.admit && r.admit).toBe(true);
    const b = g.acquire('watch');
    expect(b.admit && b.replaced).toBe(true);
    if (a.admit) expect(a.signal.aborted).toBe(true);
    if (r.admit) expect(r.signal.aborted).toBe(false);
  });
  it('drop policy refuses when busy', () => {
    const g = new Governor();
    g.acquire('reflex');
    expect(g.acquire('reflex', { policy: 'drop' })).toEqual({ admit: false, reason: 'busy' });
  });
  it('token bucket: burst then refill at 90/min', () => {
    const c = clock();
    const g = new Governor({ now: c.now, burst: 6, capPerMin: 90 });
    for (let i = 0; i < 6; i++) { const a = g.acquire('reflex'); expect(a.admit).toBe(true); if (a.admit) a.release(); }
    const x = g.acquire('reflex');
    expect(x.admit).toBe(false);
    c.adv(700); // 90/min = 1 per 667 ms
    expect(g.acquire('reflex').admit).toBe(true);
  });
  it('dedupes the same key inside the window only', () => {
    const c = clock();
    const g = new Governor({ now: c.now, dedupeMs: 1000 });
    expect(g.acquire('reflex', { key: 'turnover@12.4' }).admit).toBe(true);
    expect(g.acquire('reflex', { key: 'turnover@12.4' })).toMatchObject({ admit: false, reason: 'dedupe' });
    c.adv(1500);
    expect(g.acquire('reflex', { key: 'turnover@12.4' }).admit).toBe(true);
  });
  it('429 backs off with growth, success resets', () => {
    const c = clock();
    const g = new Governor({ now: c.now, random: () => 1, backoffBaseMs: 500 });
    expect(g.notify429()).toBe(500);
    expect(g.acquire('watch')).toMatchObject({ admit: false, reason: 'backoff' });
    c.adv(600);
    expect(g.notify429()).toBe(1000);
    expect(g.notify429(3000)).toBe(3000);
    g.notifySuccess();
    c.adv(5000);
    expect(g.acquire('watch').admit).toBe(true);
    expect(g.notify429()).toBe(500);
  });
});
