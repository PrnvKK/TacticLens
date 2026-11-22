// Re-runs the perception layers (tracking, teams, scene, ball) on recorded raw detections and yields FrameState,
// mirroring extension/entrypoints/brain/pipeline.ts. Uses the same layer code unchanged.
import type { FrameState, SceneKind, Track } from '../types';
import { ByteTrackLite, type PersonDet } from '../tracking/bytetrack';
import type { GreyFrame } from '../tracking/camera';
import { BallTracker } from '../tracking/ball';
import { TeamAssigner } from '../teams/assigner';
import { labDist, type Lab } from '../teams/lab';
import { SceneAnalyzer, GRID_H, GRID_W, type SceneOpts } from '../scene/analyzer';
import { iou } from '../perception/decode';
import type { FrameStub, RawFrame } from './format';

declare function atob(s: string): string;

function decodeThumb(b64: string): Uint8ClampedArray | null {
  const bin = atob(b64);
  if (bin.length !== GRID_W * GRID_H * 4) return null;
  const a = new Uint8ClampedArray(bin.length);
  for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
  return a;
}

/** The recorded 64x36 RGBA scene thumb doubles as a tiny greyscale frame for camera flow. */
function thumbGrey(rgba: Uint8ClampedArray): GreyFrame {
  const data = new Uint8Array(GRID_W * GRID_H);
  for (let i = 0; i < data.length; i++) {
    data[i] = 0.299 * rgba[i * 4]! + 0.587 * rgba[i * 4 + 1]! + 0.114 * rgba[i * 4 + 2]!;
  }
  return { data, width: GRID_W, height: GRID_H };
}

/**
 * Compact Lab histogram (5 x 5 x 5) for a recorded torso sample. Bins are wide enough that kit colour noise
 * does not cross them, so the cut gallery and edge re-entry work on raw fixtures without RGB pixels.
 */
export function labHistogram(lab: readonly [number, number, number]): number[] {
  const bin = (v: number, lo: number, step: number) => Math.max(0, Math.min(4, Math.floor((v - lo) / step)));
  const h = new Array<number>(125).fill(0);
  h[bin(lab[0], 0, 20) * 25 + bin(lab[1], -100, 40) * 5 + bin(lab[2], -100, 40)] = 1;
  return h;
}

function withAppearance(
  persons: PersonDet[],
  labs: (Lab | null)[] | undefined,
  teams: TeamAssigner,
): PersonDet[] {
  if (!labs) return persons;
  return persons.map((p, i) => {
    const lab = labs[i];
    if (!lab) return p;
    const out: PersonDet = { ...p, hist: p.hist ?? labHistogram(lab) };
    // Provisional team from the frozen team centres, so a confirmed track can consult the cut gallery before
    // the team assigner has seen its new track id. The assigner remains the source of truth downstream.
    if (teams.calibrated && teams.centres) {
      const dA = labDist(lab, teams.centres[0]), dB = labDist(lab, teams.centres[1]);
      const dn = Math.min(dA, dB);
      if (dn <= Math.max(24, 2.6 * teams.spread)) out.team = dA <= dB ? 'A' : 'B';
    }
    return out;
  });
}

export interface RawPipelineOpts {
  tracker?: 'v1' | 'v2';
  scene?: Partial<SceneOpts>;
}

export class RawPipeline {
  readonly tracker: ByteTrackLite;
  readonly ball = new BallTracker();
  readonly teams = new TeamAssigner();
  readonly scene: SceneAnalyzer;
  /** Video time of the last thumb fed to the tracker; the flow displacement spans [greyT, t]. */
  private greyT: number | null = null;

  constructor(o: RawPipelineOpts = {}) {
    this.tracker = new ByteTrackLite({ tracker: o.tracker ?? 'v2' });
    this.scene = new SceneAnalyzer(o.scene);
  }

  step(stub: FrameStub, raw: RawFrame): FrameState {
    const { t, tMedia } = stub;
    const persons = withAppearance(raw.persons, raw.labs, this.teams);
    const hi = this.tracker.opts.highScore;
    let kind: SceneKind, confidence: number, cut: boolean;
    const thumb = raw.thumb ? decodeThumb(raw.thumb) : null;
    let frame: GreyFrame | undefined;
    if (thumb) {
      const r = this.scene.update(t, thumb, persons.filter((p) => p.score >= hi && p.cls !== 'referee').map((p) => p.box[3] - p.box[1]));
      kind = r.kind; confidence = r.confidence; cut = r.cut;
      frame = thumbGrey(thumb);
    } else {
      kind = raw.scene?.kind ?? 'WIDE'; confidence = raw.scene?.confidence ?? 0.9; cut = raw.scene?.cut ?? false;
    }
    if (cut) this.ball.reset();
    const tracks0 = this.tracker.update(persons, t, tMedia, cut, { scene: kind, frame });
    // Flow is a displacement over [greyT, t], while FrameState.globalMotion is a per-second pan rate (the
    // medianVelocity fallback and the engine/renderer both work in normalised units per second).
    const flow = this.tracker.motion;
    const span = this.greyT === null ? 0 : t - this.greyT;
    const globalMotion: [number, number] = flow && span > 0
      ? [flow.dx / span, flow.dy / span]
      : ByteTrackLite.medianVelocity(tracks0);
    if (frame) this.greyT = t;
    const wide = kind === 'WIDE';
    if (wide && raw.labs) {
      for (const tr of tracks0) {
        if (tr.cls === 'referee' || tr.timeSinceUpdate > 0.05) continue;
        let bi = -1, bv = 0.3;
        persons.forEach((p, i) => { const v = iou(tr.box, p.box); if (v > bv && raw.labs![i]) { bv = v; bi = i; } });
        if (bi >= 0) this.teams.observe(tr.id, raw.labs[bi]!, t);
      }
    }
    const tracks: Track[] = this.teams.assign(tracks0, t, wide);
    this.tracker.noteTeams(tracks);
    const b = this.ball.update(t, raw.ballCands ?? [], cut);
    return {
      t, tMedia, playbackRate: stub.playbackRate, globalMotion, quality: stub.quality, frameIdx: stub.frameIdx,
      scene: { kind, confidence }, tracks, ball: b, teamsCalibrated: this.teams.calibrated,
    };
  }
}
