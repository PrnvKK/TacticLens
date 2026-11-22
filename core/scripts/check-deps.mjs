// Dependency rule: core/ imports nothing from extension/ and touches no browser globals.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../src', import.meta.url));
const banned = /\b(window|document|chrome|navigator|HTMLElement)\b|from\s+['"][^'"]*extension\//;
const files = [];
(function walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.ts')) files.push(p);
  }
})(root);

let bad = 0;
for (const f of files) {
  readFileSync(f, 'utf8').split('\n').forEach((line, i) => {
    if (line.trimStart().startsWith('//')) return;
    if (banned.test(line)) {
      bad++;
      console.error(`${relative(process.cwd(), f)}:${i + 1}: forbidden DOM/extension reference: ${line.trim()}`);
    }
  });
}
if (bad) process.exit(1);
console.log(`check-deps: ${files.length} files clean`);
