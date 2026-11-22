// pnpm replay fixtures/<x>.jsonl [--frames] [--events N] [--json]
// Runs tracking/teams/scene on raw detections if the file has them (else starts from FrameState), then the engine.
import { readFileSync } from 'node:fs';
import { parseSession, runSession, type Report } from '../../core/src/replay/index';

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--') && !/^\d+$/.test(a));
const flag = (n: string) => args.includes(n);
const maxEvents = (() => { const i = args.indexOf('--events'); return i >= 0 ? Number(args[i + 1]) : 40; })();

if (!files.length) {
  console.error('usage: pnpm replay fixtures/<x>.jsonl [--frames] [--events N] [--json]');
  process.exit(2);
}

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const f1 = (v: number) => v.toFixed(1);

function print(file: string, r: Report, headerSource: string): void {
  const p = r.possession;
  console.log(`\n=== ${file} ===`);
  console.log(`source ${headerSource} | mode ${r.mode} | ${r.frames} frames | ${f1(r.durationS)} s | engine ${r.engineMsPerFrame.toFixed(3)} ms/frame`);
  console.log(`\npossession   A ${f1(p.A)}%  B ${f1(p.B)}%   (credited A ${f1(p.creditedS.A)} s, B ${f1(p.creditedS.B)} s)`);
  console.log(`ball         visible ${f1(r.ball.visible)}%  searching ${f1(r.ball.searching)}%  absent ${f1(r.ball.absent)}%`);
  console.log(`liveness     ${Object.entries(r.liveness).map(([k, v]) => `${k} ${f1(v as number)}%`).join('  ')}`);
  console.log(`formation    A ${r.formation.A ?? '-'}  B ${r.formation.B ?? '-'}   | gate toggles ${r.gateToggles}`);
  console.log('\nscene timeline');
  for (const s of r.scenes) console.log(`  ${pad(s.kind, 7)} ${f1(s.t0).padStart(6)} s -> ${f1(s.t1).padStart(6)} s`);
  console.log(`\nevents (${r.events.length})`);
  for (const e of r.events.slice(0, maxEvents)) console.log(`  ${f1(e.t).padStart(6)} s  ${pad(e.type, 18)} ${pad(e.team, 5)} conf ${e.confidence.toFixed(2)}  ${JSON.stringify(e.detail)}`);
  if (r.events.length > maxEvents) console.log(`  ... ${r.events.length - maxEvents} more (use --events N)`);
  const by: Record<string, number> = {};
  for (const e of r.events) by[e.type] = (by[e.type] ?? 0) + 1;
  console.log(`\nsummary      ${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(', ') || 'no events'}`);
}

let code = 0;
for (const file of files) {
  try {
    const session = parseSession(readFileSync(file, 'utf8'));
    const { report } = runSession(session, { preferFrames: flag('--frames') }, () => performance.now());
    if (flag('--json')) console.log(JSON.stringify({ file, ...report }));
    else print(file, report, session.header.source);
  } catch (e) {
    console.error(`${file}: ${(e as Error).message}`);
    code = 1;
  }
}
process.exit(code);
