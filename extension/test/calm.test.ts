import { describe, expect, it } from 'vitest';
import { CALM_CONFIG, CalmGate, motionPxS, type CalmMetrics } from '../lib/render/calm';

const good = (o: Partial<CalmMetrics> = {}): CalmMetrics => ({
  wide: true, ballOk: true, cutAgoS: 10, cameraPxS: 20, playerPxS: 30, tracks: 20, stableFraction: 0.95, ...o,
});

/** Run the gate forward in small steps so its settle/grace timers behave like the render loop. */
function feed(g: CalmGate, from: number, to: number, o: Partial<CalmMetrics> = {}, dt = 0.05): number {
  let t = from;
  for (; t < to - 1e-9; t += dt) g.update(t, good(o));
  g.update(to, good(o));
  return to;
}

describe('CalmGate', () => {
  it('never admits a heavy graphic while the picture is busy', () => {
    const g = new CalmGate();
    feed(g, 0, 8, { cameraPxS: 600 });
    expect(g.canAdmit(8)).toBe(false);
    expect(g.status).toMatch(/^busy/);
    const g2 = new CalmGate();
    feed(g2, 0, 8, { playerPxS: 500 });
    expect(g2.canAdmit(8)).toBe(false);
    expect(g2.status).toContain('players');
    const g3 = new CalmGate();
    feed(g3, 0, 8, { wide: false, ballOk: false });
    expect(g3.canAdmit(8)).toBe(false);
  });

  it('requires calm to hold for a full second (settling)', () => {
    const g = new CalmGate();
    g.update(0, good());
    g.update(0.9, good());
    expect(g.canAdmit(0.9)).toBe(false);
    expect(g.state).toBe('settling');
    g.update(1.05, good());
    expect(g.canAdmit(1.05)).toBe(true);
    expect(g.calm).toBe(true);
  });

  it('allows only one group, holds it at least 3 s, and waits 8 s between groups', () => {
    const g = new CalmGate();
    feed(g, 0, 1.1);
    expect(g.canAdmit(1.1)).toBe(true);
    g.admitted(1.1, 'shape');
    expect(g.canAdmit(1.5)).toBe(false);          // one group max
    expect(g.activeGroup).toBe('shape');
    feed(g, 1.1, 4.2);
    expect(g.shouldEnd(4.0)).toBe(false);          // min hold not reached
    expect(g.shouldEnd(4.2)).toBe(false);          // still calm, under max hold
    expect(g.shouldEnd(7.2)).toBe(true);           // max hold
    g.ended(7.2);
    feed(g, 7.2, 15.1);
    expect(g.canAdmit(15.1)).toBe(false);          // 7.9 s clean, under the 8 s gap
    g.update(15.25, good());
    expect(g.canAdmit(15.25)).toBe(true);
  });

  it('gives 0.5 s grace when calm breaks, never popping mid-hold', () => {
    const g = new CalmGate();
    feed(g, 0, 1.1);
    g.admitted(1.1, 'shape');
    feed(g, 1.1, 1.3);
    g.update(1.3, good({ cameraPxS: 900 }));       // busy from 1.3
    g.update(2.0, good({ cameraPxS: 900 }));
    expect(g.shouldEnd(2.0)).toBe(false);          // min hold not reached
    g.update(2.8, good({ cameraPxS: 900 }));
    expect(g.shouldEnd(2.8)).toBe(false);          // 1.7 s held, under the 2 s hold
    g.update(3.5, good({ cameraPxS: 900 }));
    expect(g.shouldEnd(3.5)).toBe(true);           // 2.4 s held, 0.5 s grace elapsed
    g.update(4.3, good());                         // calm returns before fade starts
    expect(g.shouldEnd(4.3)).toBe(false);
  });

  it('drops the fixed clean gap when the director is active but keeps min hold and fades', () => {
    const g = new CalmGate();
    g.setDirectorActive(true);
    feed(g, 0, 1.1);
    g.admitted(1.1, 'shape');
    feed(g, 1.1, 1.3);
    g.update(1.3, good({ cameraPxS: 900 }));
    g.update(2.8, good({ cameraPxS: 900 }));
    expect(g.shouldEnd(2.8)).toBe(false);          // min hold still applies
    g.update(3.5, good({ cameraPxS: 900 }));
    expect(g.shouldEnd(3.5)).toBe(true);
    g.ended(3.5);
    feed(g, 3.6, 4.7);
    expect(g.canAdmit(4.7)).toBe(true);            // no 8 s clean gap for the director

    const noDirector = new CalmGate();
    feed(noDirector, 0, 1.1);
    noDirector.admitted(1.1, 'shape');
    feed(noDirector, 1.1, 1.3);
    noDirector.update(1.3, good({ cameraPxS: 900 }));
    noDirector.update(3.5, good({ cameraPxS: 900 }));
    expect(noDirector.shouldEnd(3.5)).toBe(true);
    noDirector.ended(3.5);
    feed(noDirector, 3.6, 4.7);
    expect(noDirector.canAdmit(4.7)).toBe(false);  // rules pacing keeps the 8 s gap
  });

  it('uses the broadcast fade/hold thresholds from one config', () => {
    expect(CALM_CONFIG.fadeInS).toBeCloseTo(0.3, 5);
    expect(CALM_CONFIG.holdMinS).toBeCloseTo(2, 5);
    expect(CALM_CONFIG.holdMaxS).toBeCloseTo(6, 5);
    expect(CALM_CONFIG.directorHoldMaxS).toBeCloseTo(10, 5);
    expect(CALM_CONFIG.fadeOutS).toBeCloseTo(0.4, 5);
    expect(CALM_CONFIG.gapS).toBeCloseTo(8, 5);
    expect(CALM_CONFIG.directorGapS).toBeCloseTo(0, 5);
    expect(CALM_CONFIG.pendingMaxS).toBeCloseTo(3, 5);
  });

  it('bypasses entirely in freeze-frame/telestrator/showcase', () => {
    const g = new CalmGate();
    g.update(0, good({ wide: false, ballOk: false, cameraPxS: 900 }));
    g.setBypass(true);
    expect(g.canAdmit(0)).toBe(true);
    g.admitted(0, 'shape');
    expect(g.shouldEnd(10)).toBe(false);
    expect(g.status).toBe('bypass');
  });

  it('converts normalised camera motion to 1080p px/s', () => {
    expect(motionPxS(0, 0)).toBe(0);
    expect(motionPxS(0.5, 0)).toBeCloseTo(960, 5);
    expect(motionPxS(0.1, 0.1)).toBeCloseTo(Math.hypot(192, 108), 5);
  });
});
