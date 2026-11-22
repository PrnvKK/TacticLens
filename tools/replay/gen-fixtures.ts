// pnpm replay:gen  ->  writes fixtures/<name>.jsonl and fixtures/<name>.labels.json from the synthetic generator.
import { mkdirSync, writeFileSync } from 'node:fs';
import { SYNTH_FIXTURES, generateSynth, serializeSession } from '../../core/src/replay/index';

mkdirSync('fixtures', { recursive: true });
for (const cfg of SYNTH_FIXTURES) {
  const { header, frames, labels } = generateSynth(cfg);
  writeFileSync(`fixtures/${cfg.name}.jsonl`, serializeSession(header, frames));
  writeFileSync(`fixtures/${cfg.name}.labels.json`, JSON.stringify(labels, null, 2) + '\n');
  console.log(`fixtures/${cfg.name}.jsonl  ${frames.length} frames  truth A ${labels.possession.A}% B ${labels.possession.B}%  turnovers ${labels.turnovers.length}`);
}
