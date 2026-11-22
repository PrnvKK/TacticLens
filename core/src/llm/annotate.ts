// Frame-annotation spec: pure function returning draw commands for IDs and team colours on a W px wide frame.
// extension/lib/llm/frame.ts renders these with OffscreenCanvas. Nothing here touches a canvas.
import type { FrameState, Team, Track } from '../types';

export type DrawCmd =
  | { op: 'ellipse'; cx: number; cy: number; rx: number; ry: number; stroke: string; lineWidth: number }
  | { op: 'rect'; x: number; y: number; w: number; h: number; fill: string }
  | { op: 'text'; x: number; y: number; text: string; fontPx: number; fill: string; align: 'center' }
  | { op: 'circle'; cx: number; cy: number; r: number; stroke: string; lineWidth: number };

export interface AnnotateOptions {
  width?: number;                       // default 768
  aspect?: number;                      // height/width of the frame, default 9/16
  colours?: Partial<Record<Team, string>>;
  minAgeS?: number;                     // confirmed tracks only, default 0.3
  fontPx?: number;                      // >= 14
}

export const DEFAULT_TEAM_COLOURS: Record<Team, string> = { A: '#ff5a5a', B: '#4aa8ff', OTHER: '#d0d0d0' };
export const BALL_COLOUR = '#ffe14a';

export function annotationSpec(frame: FrameState, opts: AnnotateOptions = {}): { width: number; height: number; cmds: DrawCmd[] } {
  const W = opts.width ?? 768;
  const H = Math.round(W * (opts.aspect ?? 9 / 16));
  const font = Math.max(14, opts.fontPx ?? 14);
  const colours = { ...DEFAULT_TEAM_COLOURS, ...opts.colours };
  const minAge = opts.minAgeS ?? 0.3;
  const cmds: DrawCmd[] = [];

  const confirmed = frame.tracks
    .filter((t: Track) => (t.cls === 'player' || t.cls === 'goalkeeper') && t.age >= minAge && t.timeSinceUpdate < 0.5)
    .sort((a, b) => a.foot[1] - b.foot[1]); // far players first so near tags draw on top

  for (const t of confirmed) {
    const fx = t.foot[0] * W;
    const fy = t.foot[1] * H;
    const bw = (t.box[2] - t.box[0]) * W;
    const col = colours[t.team];
    const rx = Math.max(6, bw * 0.5);
    cmds.push({ op: 'ellipse', cx: fx, cy: fy, rx, ry: Math.max(3, rx * 0.35), stroke: col, lineWidth: 2 });
    const label = String(t.id);
    const tw = Math.ceil(label.length * font * 0.62) + 8;
    const th = font + 6;
    const topY = t.box[1] * H;
    const ty = Math.max(0, topY - th - 2);
    const tx = Math.min(W - tw, Math.max(0, fx - tw / 2));
    cmds.push({ op: 'rect', x: tx, y: ty, w: tw, h: th, fill: 'rgba(0,0,0,0.75)' });
    cmds.push({ op: 'text', x: tx + tw / 2, y: ty + th - 4, text: label, fontPx: font, fill: col, align: 'center' });
  }
  if (frame.ball.xy && frame.ball.state === 'visible') {
    cmds.push({ op: 'circle', cx: frame.ball.xy[0] * W, cy: frame.ball.xy[1] * H, r: 7, stroke: BALL_COLOUR, lineWidth: 2 });
  }
  return { width: W, height: H, cmds };
}
