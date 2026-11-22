// Test-only ambient declarations (core tsconfig has no DOM/node types).
declare const console: { log(...a: unknown[]): void };
declare function setTimeout(fn: () => void, ms?: number): unknown;
declare class AbortController { signal: { aborted: boolean; addEventListener(t: 'abort', f: () => void): void; removeEventListener(t: 'abort', f: () => void): void }; abort(): void }
