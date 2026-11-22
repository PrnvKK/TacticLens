// Synthetic broadcast feed for the offline Theatre, Gallery and Showcase. The stadium, mown
// grass, LEDs and crowd are painted once; players and the ball are redrawn from the same mock
// world the overlay consumes, so rings sit on real silhouettes instead of empty grass.
import type { MediaClock } from '../lib/video';
import { snapshotAt } from '../lib/mock/world';
import { shade } from '../lib/render/tokens';

const W = 1280;
const H = 720;

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function drawBackdrop(g: CanvasRenderingContext2D): void {
  // Night sky / roof
  const roof = g.createLinearGradient(0, 0, 0, H * 0.13);
  roof.addColorStop(0, '#05080d');
  roof.addColorStop(1, '#0b121c');
  g.fillStyle = roof;
  g.fillRect(0, 0, W, H * 0.13);

  // Floodlight bloom in the roof
  for (const x of [0.16, 0.5, 0.84]) {
    const f = g.createRadialGradient(W * x, -H * 0.02, 0, W * x, 0, H * 0.34);
    f.addColorStop(0, 'rgba(210,232,255,0.24)');
    f.addColorStop(0.4, 'rgba(180,215,255,0.075)');
    f.addColorStop(1, 'rgba(180,215,255,0)');
    g.fillStyle = f;
    g.fillRect(W * x - W * 0.3, 0, W * 0.6, H * 0.36);
  }

  // Crowd bands, top and bottom
  const drawCrowd = (y0: number, y1: number): void => {
    const crowd = g.createLinearGradient(0, y0, 0, y1);
    crowd.addColorStop(0, '#0a0f17');
    crowd.addColorStop(0.55, '#111925');
    crowd.addColorStop(1, '#070b11');
    g.fillStyle = crowd;
    g.fillRect(0, y0, W, y1 - y0);
    const rnd = seeded(19);
    for (let i = 0; i < 2400; i++) {
      const x = rnd() * W;
      const y = y0 + rnd() * (y1 - y0);
      const s = 0.7 + rnd() * 1.7;
      const warm = rnd();
      g.fillStyle = warm > 0.82 ? 'rgba(255,206,142,0.5)' : warm > 0.6 ? 'rgba(150,190,235,0.32)' : 'rgba(215,228,244,0.18)';
      g.fillRect(x, y, s, s);
    }
    // subtle LED wash
    const wash = g.createLinearGradient(0, y0, 0, y1);
    wash.addColorStop(0, 'rgba(25,80,140,0.16)');
    wash.addColorStop(0.7, 'rgba(0,0,0,0)');
    g.fillStyle = wash;
    g.fillRect(0, y0, W, y1 - y0);
  };
  drawCrowd(0, H * 0.085);
  drawCrowd(H * 0.935, H);

  // Pitch surround
  g.fillStyle = '#123a21';
  g.fillRect(0, H * 0.085, W, H * 0.85);

  // Mown grass: vertical bands with a light falloff toward the stands
  const grass = g.createLinearGradient(0, H * 0.085, 0, H * 0.935);
  grass.addColorStop(0, '#205c34');
  grass.addColorStop(0.48, '#2c7d44');
  grass.addColorStop(1, '#256a3a');
  g.fillStyle = grass;
  g.fillRect(0, H * 0.085, W, H * 0.85);
  for (let i = 0; i < 18; i++) {
    const x = (W / 18) * i;
    g.fillStyle = i % 2 ? 'rgba(255,255,255,0.016)' : 'rgba(0,0,0,0.045)';
    g.fillRect(x, H * 0.085, W / 18, H * 0.85);
  }
  // faint horizontal mow seams
  for (let i = 1; i < 7; i++) {
    g.fillStyle = 'rgba(0,0,0,0.035)';
    g.fillRect(0, H * 0.085 + (H * 0.85 * i) / 7, W, 1);
  }

  // LED advertising boards
  const board = (y: number, height: number): void => {
    g.fillStyle = '#060b11';
    g.fillRect(0, y, W, height);
    g.fillStyle = 'rgba(215,255,62,0.16)';
    g.fillRect(0, y + height - 1, W, 1);
    g.save();
    g.beginPath();
    g.rect(0, y, W, height);
    g.clip();
    g.font = `700 ${Math.round(height * 0.52)}px "Barlow Condensed", "Inter", sans-serif`;
    g.textBaseline = 'middle';
    for (let x = -40; x < W + 160; x += 250) {
      g.fillStyle = 'rgba(235,245,255,0.26)';
      g.fillText('TACTICLENS', x, y + height * 0.54);
      g.fillStyle = 'rgba(215,255,62,0.35)';
      g.fillRect(x + 126, y + height * 0.28, 3, height * 0.44);
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.fillRect(x + 142, y + height * 0.3, 34, height * 0.4);
    }
    g.restore();
  };
  board(H * 0.085 - H * 0.026, H * 0.026);
  board(H * 0.935, H * 0.026);

  // Pitch markings
  g.save();
  g.strokeStyle = 'rgba(240,248,255,0.62)';
  g.lineWidth = 2;
  g.shadowColor = 'rgba(180,230,255,0.35)';
  g.shadowBlur = 6;
  const l = W * 0.035, r = W * 0.965, t = H * 0.105, b = H * 0.915;
  g.strokeRect(l, t, r - l, b - t);
  g.beginPath(); g.moveTo(W / 2, t); g.lineTo(W / 2, b); g.stroke();
  g.beginPath(); g.ellipse(W / 2, H / 2, W * 0.075, H * 0.1, 0, 0, Math.PI * 2); g.stroke();
  g.beginPath(); g.arc(W / 2, H / 2, 4, 0, Math.PI * 2); g.fillStyle = 'rgba(240,248,255,0.8)'; g.fill();
  g.strokeRect(l, H / 2 - H * 0.22, W * 0.145, H * 0.44);
  g.strokeRect(r - W * 0.145, H / 2 - H * 0.22, W * 0.145, H * 0.44);
  g.strokeRect(l, H / 2 - H * 0.095, W * 0.048, H * 0.19);
  g.strokeRect(r - W * 0.048, H / 2 - H * 0.095, W * 0.048, H * 0.19);
  g.beginPath(); g.arc(l + W * 0.1, H / 2, 3.5, 0, Math.PI * 2); g.fill();
  g.beginPath(); g.arc(r - W * 0.1, H / 2, 3.5, 0, Math.PI * 2); g.fill();
  g.restore();

  // Vignette to keep the HUD glass readable at the frame edges
  const vig = g.createRadialGradient(W / 2, H * 0.53, H * 0.2, W / 2, H * 0.53, H * 0.82);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(0.72, 'rgba(0,0,0,0.06)');
  vig.addColorStop(1, 'rgba(0,0,0,0.42)');
  g.fillStyle = vig;
  g.fillRect(0, 0, W, H);
}

function drawPlayer(
  g: CanvasRenderingContext2D, x: number, footY: number, height: number, kit: string, cls: string, seed: number,
): void {
  const h = Math.max(10, height);
  const w = h * 0.27;
  const body = cls === 'goalkeeper' ? shade(kit, 0.18) : kit;
  const shorts = cls === 'goalkeeper' ? '#151a20' : shade(kit, -0.55);
  const sock = cls === 'goalkeeper' ? '#1a2029' : shade(kit, -0.35);
  const skin = seed % 3 === 0 ? '#8a5b3c' : seed % 3 === 1 ? '#c68b63' : '#e0ab82';
  const dark = shade(body, -0.62);

  // contact shadow
  const sh = g.createRadialGradient(x, footY - h * 0.02, 0, x, footY - h * 0.02, w * 1.5);
  sh.addColorStop(0, 'rgba(0,0,0,0.38)');
  sh.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = sh;
  g.beginPath(); g.ellipse(x, footY - h * 0.015, w * 1.4, h * 0.055, 0, 0, Math.PI * 2); g.fill();

  // legs / socks
  const legTop = footY - h * 0.48;
  g.lineCap = 'round';
  g.strokeStyle = sock;
  g.lineWidth = Math.max(1.4, w * 0.22);
  g.beginPath(); g.moveTo(x - w * 0.2, legTop); g.lineTo(x - w * 0.24, footY - h * 0.03); g.stroke();
  g.beginPath(); g.moveTo(x + w * 0.2, legTop); g.lineTo(x + w * 0.24, footY - h * 0.03); g.stroke();
  g.strokeStyle = skin;
  g.lineWidth = Math.max(1.2, w * 0.2);
  g.beginPath(); g.moveTo(x - w * 0.24, footY - h * 0.1); g.lineTo(x - w * 0.24, footY - h * 0.03); g.stroke();
  g.beginPath(); g.moveTo(x + w * 0.24, footY - h * 0.1); g.lineTo(x + w * 0.24, footY - h * 0.03); g.stroke();

  // shorts
  g.fillStyle = shorts;
  g.beginPath(); g.roundRect(x - w * 0.42, legTop - h * 0.11, w * 0.84, h * 0.16, Math.max(1, w * 0.1)); g.fill();

  // torso with a soft lit edge
  const jersey = g.createLinearGradient(x - w * 0.5, legTop - h * 0.55, x + w * 0.5, legTop);
  jersey.addColorStop(0, shade(body, 0.16));
  jersey.addColorStop(0.55, body);
  jersey.addColorStop(1, dark);
  g.fillStyle = jersey;
  g.beginPath(); g.roundRect(x - w * 0.5, legTop - h * 0.42, w, h * 0.36, Math.max(1.5, w * 0.16)); g.fill();
  // sleeves
  g.fillStyle = shade(body, -0.08);
  g.beginPath(); g.roundRect(x - w * 0.72, legTop - h * 0.4, w * 0.3, h * 0.18, w * 0.1); g.fill();
  g.beginPath(); g.roundRect(x + w * 0.42, legTop - h * 0.4, w * 0.3, h * 0.18, w * 0.1); g.fill();
  // collar
  g.fillStyle = shade(body, -0.32);
  g.beginPath(); g.roundRect(x - w * 0.18, legTop - h * 0.44, w * 0.36, h * 0.045, 1); g.fill();

  // head + hair
  const headR = w * 0.31;
  const headY = legTop - h * 0.52;
  g.fillStyle = skin;
  g.beginPath(); g.arc(x, headY, headR, 0, Math.PI * 2); g.fill();
  g.fillStyle = seed % 2 ? '#221a16' : '#3b2a1f';
  g.beginPath(); g.arc(x, headY - headR * 0.22, headR * 0.96, Math.PI * 1.04, Math.PI * 1.96); g.fill();

  // rim light
  g.strokeStyle = 'rgba(210,235,255,0.28)';
  g.lineWidth = Math.max(0.8, w * 0.07);
  g.beginPath(); g.moveTo(x + w * 0.4, legTop - h * 0.4); g.lineTo(x + w * 0.46, legTop - h * 0.12); g.stroke();
}

export type MockPhaseMode = 'live' | 'replay' | 'ballout';

export interface MockPitch {
  canvas: HTMLCanvasElement;
  tick(nowS: number): void;
}

export function createMockPitch(clock: MediaClock, opts: { phase?: () => MockPhaseMode } = {}): MockPitch {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  canvas.className = 'tl-media';
  const g = canvas.getContext('2d');
  if (!g) return { canvas, tick: () => undefined };

  const back = document.createElement('canvas');
  back.width = W;
  back.height = H;
  const bg = back.getContext('2d')!;
  drawBackdrop(bg);
  if (document.fonts?.ready) void document.fonts.ready.then(() => drawBackdrop(bg));

  let last = -1;
  return {
    canvas,
    tick: (nowS: number): void => {
      const t = clock.currentTime;
      if (Math.abs(t - last) < 0.006 && last >= 0) return;
      last = t;
      g.clearRect(0, 0, W, H);
      g.drawImage(back, 0, 0);
      const mode = opts.phase?.() ?? 'live';
      const force = mode === 'replay'
        ? { forcePhase: { liveness: 'REPLAY' as const, calibrated: true, ball: 'visible' as const, coasting: 0, scene: 'REPLAY' as const, replay: true } }
        : mode === 'ballout'
          ? { forcePhase: { liveness: 'LIVE' as const, calibrated: true, ball: 'absent' as const, coasting: 2, scene: 'WIDE' as const } }
          : undefined;
      const snap = snapshotAt(t, t, true, force);
      const kitA = snap.match.scout?.kitColours.A ?? '#3d8bff';
      const kitB = snap.match.scout?.kitColours.B ?? '#ff4d4f';
      const players = snap.tracks.slice().sort((a, b) => a.foot[1] - b.foot[1]);
      for (const tr of players) {
        const boxH = (tr.box[3] - tr.box[1]) * H;
        if (boxH > H * 0.36) continue; // close-up: leave the frame to the HUD card
        const kit = tr.cls === 'referee' ? '#20262e' : tr.team === 'B' ? kitB : kitA;
        drawPlayer(g, tr.foot[0] * W, tr.foot[1] * H, boxH, kit, tr.cls, tr.id);
      }
      const ball = snap.ball.xy;
      if (ball) {
        const bx = ball[0] * W, by = ball[1] * H;
        const br = 5.4 + 2.2 * ball[1];
        g.fillStyle = 'rgba(0,0,0,0.32)';
        g.beginPath(); g.ellipse(bx, by + br * 0.9, br * 1.1, br * 0.4, 0, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#f7fbff';
        g.beginPath(); g.arc(bx, by, br, 0, Math.PI * 2); g.fill();
        g.fillStyle = 'rgba(15,20,26,0.72)';
        g.beginPath(); g.arc(bx - br * 0.24, by - br * 0.12, br * 0.24, 0, Math.PI * 2); g.fill();
        g.beginPath(); g.arc(bx + br * 0.3, by + br * 0.26, br * 0.18, 0, Math.PI * 2); g.fill();
      }
      void nowS;
    },
  };
}

