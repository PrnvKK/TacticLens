import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import type { StatKey } from '../../src/types';
import { BALL_DEPENDENT } from '../../src/engine';
import { SYNTH_FIXTURES, SessionRecorder, generateSynth, parseSession, runSession, serializeSession, toFrameStates, type FrameOut } from '../../src/replay';

const inWin = (w: [number, number][], t: number) => w.some(([a, b]) => t >= a && t < b);
const vals = (o: FrameOut, keys?: Iterable<StatKey>) => {
  const ks = keys ? [...keys] : (Object.keys(o.match.stats) as StatKey[]);
  return JSON.stringify(ks.map((k) => [k, o.match.stats[k].value, o.match.stats[k].updatedAt]).concat([['possession', o.match.possession.value, o.match.possession.updatedAt]] as never));
};

for (const cfg of SYNTH_FIXTURES) {
  describe(`fixture ${cfg.name}`, () => {
    const syn = generateSynth(cfg);
    const session = parseSession(serializeSession(syn.header, syn.frames));
    const { outs, report } = runSession(session);
    const L = syn.labels;

    it('possession within +/-10 points of the generator ground truth', () => {
      expect(Math.abs(report.possession.A - L.possession.A)).toBeLessThanOrEqual(10);
      expect(Math.abs(report.possession.B - L.possession.B)).toBeLessThanOrEqual(10);
    });

    it('detects every scheduled turnover (within 2 s) and invents none', () => {
      const found = report.events.filter((e) => e.type === 'turnover');
      for (const tv of L.turnovers) {
        expect(found.some((e) => e.team === tv.to && e.t >= tv.t && e.t <= tv.t + 2), `turnover to ${tv.to} at ${tv.t}`).toBe(true);
      }
      expect(found.length).toBe(L.turnovers.length);
    });

    it('zero stat changes and no events during replay and close-up segments', () => {
      for (const win of [...L.replay, ...L.close]) {
        const inside = outs.filter((o) => o.frame.t >= win[0] && o.frame.t < win[1]);
        expect(inside.length).toBeGreaterThan(5);
        const before = outs.filter((o) => o.frame.t < win[0]).pop()!;
        for (const o of inside) {
          expect(vals(o)).toBe(vals(before));
          expect(o.events).toEqual([]);
          expect(o.match.liveness).not.toBe('LIVE');
        }
      }
    });

    it('ball absent: every ball-dependent stat is paused and frozen, nothing credited, no ball events', () => {
      for (const [a, b] of L.absent) {
        const gap = outs.filter((o) => o.frame.t >= a && o.frame.t < b && o.frame.ball.state === 'absent');
        expect(gap.length).toBeGreaterThan(5);
        const ref = vals(gap[0]!, BALL_DEPENDENT);
        for (const o of gap) {
          expect(vals(o, BALL_DEPENDENT)).toBe(ref);
          for (const k of BALL_DEPENDENT) expect(o.match.stats[k].paused, k).toBe(true);
          expect(o.match.possession.paused).toBe(true);
          expect(o.detail.possessionState).toBe('DEAD');
          expect(o.events.filter((e) => ['turnover', 'pass', 'spell', 'counter_attack', 'switch_of_play'].includes(e.type))).toEqual([]);
        }
        // ball-independent stats keep running through the gap
        expect(gap[gap.length - 1]!.match.stats.compactness.updatedAt).toBeGreaterThan(gap[0]!.match.stats.compactness.updatedAt);
        expect(gap[gap.length - 1]!.match.stats.compactness.paused).toBeUndefined();
        // and credited time did not move
        expect(gap[gap.length - 1]!.detail.credited).toEqual(gap[0]!.detail.credited);
      }
    });

    it('no turnover is produced across a gap, replay or close-up', () => {
      const bad = [...L.absent, ...L.replay, ...L.close];
      for (const e of report.events.filter((x) => x.type === 'turnover')) {
        // the first confirmed hold after a gap is an acquisition, not a turnover
        expect(bad.some(([a, b]) => e.t > a && e.t < b + 0.8), `turnover at ${e.t}`).toBe(false);
      }
    });

    it('formation guess and shape come out as 4-4-2 with attack direction found', () => {
      const last = outs.filter((o) => o.match.liveness === 'LIVE').pop()!;
      expect(last.detail.formation).toEqual({ A: '4-4-2', B: '4-4-2' });
      expect(last.match.attackDir.A).toBe('right');
      expect(last.match.lineHeight.A.value).toBeGreaterThan(0);
    });

    it('stats expose a confidence and a gate; possession is shown during clean play', () => {
      const clean = outs.filter((o) => o.frame.t > 8 && o.frame.t < 15 && o.frame.ball.state === 'visible').pop()!;
      expect(clean.match.possession.gate).toBe('shown');
      expect(clean.match.possession.confidence).toBeGreaterThan(0.75);
      for (const k of Object.keys(clean.match.stats) as StatKey[]) {
        const s = clean.match.stats[k];
        expect(s.confidence).toBeGreaterThanOrEqual(0);
        expect(['shown', 'held', 'hidden']).toContain(s.gate);
      }
    });

    it('scene timeline in the report matches the labels', () => {
      const replays = report.scenes.filter((s) => s.kind === 'REPLAY').map((s) => [s.t0, s.t1]);
      expect(replays.length).toBe(L.replay.length);
      L.replay.forEach(([a, b], i) => { expect(replays[i]![0]).toBeCloseTo(a, 0); expect(replays[i]![1]).toBeGreaterThan(b - 1); });
      expect(inWin(L.replay, 0)).toBe(false);
    });
  });
}

describe('committed fixtures', () => {
  for (const cfg of SYNTH_FIXTURES) {
    it(`${cfg.name}.jsonl matches the generator and replays`, () => {
      const text = readFileSync(`${process.cwd()}/../fixtures/${cfg.name}.jsonl`, 'utf8');
      const g = generateSynth(cfg);
      expect(text).toBe(serializeSession(g.header, g.frames));
      const labels = JSON.parse(readFileSync(`${process.cwd()}/../fixtures/${cfg.name}.labels.json`, 'utf8')) as typeof g.labels;
      expect(labels).toEqual(JSON.parse(JSON.stringify(g.labels)));
    });
  }
});

describe('raw fixture runs the perception layers', () => {
  it('raw replay yields tracks, calibrates teams and finds the ball states', () => {
    const cfg = SYNTH_FIXTURES.find((c) => c.mode === 'raw')!;
    const g = generateSynth(cfg);
    const { frames, mode } = toFrameStates(parseSession(serializeSession(g.header, g.frames)));
    expect(mode).toBe('raw');
    const f = frames.find((x) => x.t > 15 && x.scene.kind === 'WIDE')!;
    expect(f.teamsCalibrated).toBe(true);
    expect(f.tracks.filter((t) => t.team === 'A').length).toBeGreaterThanOrEqual(8);
    expect(frames.some((x) => x.ball.state === 'absent')).toBe(true);
  });
});

describe('tracker v2 on raw replay', () => {
  it('keeps wide-play churn below 5 new IDs/min and beats the v1 fallback', () => {
    const cfg = SYNTH_FIXTURES.find((c) => c.mode === 'raw')!;
    const g = generateSynth(cfg);
    const s = parseSession(serializeSession(g.header, g.frames));
    const v1 = runSession(s, { tracker: 'v1' }).report;
    const v2 = runSession(s, { tracker: 'v2' }).report;
    expect(v2.newIds).toBeLessThan(v1.newIds);
    expect(v2.newIdsPerMinute).toBeLessThan(5);
    expect(Math.abs(v2.possession.A - v1.possession.A)).toBeLessThanOrEqual(0.5);
  });
});

describe('recorder', () => {
  it('round-trips FrameState through JSONL with a header and respects maxFrames', () => {
    const g = generateSynth({ ...SYNTH_FIXTURES[0]!, durationS: 5 });
    const lines: string[] = [];
    const rec = new SessionRecorder((l) => lines.push(l), { source: 'extension', hz: 5, maxFrames: 10 });
    let pushed = 0;
    for (const r of g.frames) if (rec.push(r.frame as never)) pushed++;
    expect(pushed).toBe(10);
    const s = parseSession(lines.join('\n'));
    expect(s.header.source).toBe('extension');
    expect(s.header.hasRaw).toBe(false);
    expect(s.frames.length).toBe(10);
    expect(runSession(s).report.frames).toBe(10);
  });
  it('rejects a bad line with its line number', () => {
    expect(() => parseSession('{"kind":"header","version":1,"source":"x","hasRaw":false}\n{oops')).toThrow(/line 2/);
  });
});
