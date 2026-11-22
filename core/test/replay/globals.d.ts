// Test-only ambient declarations (core tsconfig has no node types).
declare module 'node:fs' {
  export function readFileSync(path: string, enc: 'utf8'): string;
}
declare const process: { cwd(): string };
