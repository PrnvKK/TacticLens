// End-to-end exit hygiene for the live LLM tools: a mocked Cerebras that always refuses with
// queue_exceeded must not crash Node on Windows (the old process.exit() race) and must report a
// non-zero exit code for calibrate, a clean finish for soak.
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BODY = JSON.stringify({
  message: "We're experiencing high traffic right now! Please try again soon.",
  type: 'too_many_requests_error',
  param: 'queue',
  code: 'queue_exceeded',
});

let server: Server;
let baseURL = '';

beforeAll(async () => {
  server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(429, { 'Content-Type': 'application/json' });
      res.end(BODY);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('no port');
  baseURL = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Run { code: number | null; stdout: string; stderr: string }

function runTool(script: string, extraEnv: Record<string, string>): Promise<Run> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      '--no-warnings', '--experimental-transform-types',
      '--import', './tools/replay/register.mjs', script,
    ], {
      cwd: ROOT,
      env: {
        ...process.env,
        CEREBRAS_API_KEY: 'test-key-not-real',
        CEREBRAS_KIMI_MODEL: 'kimi-test-model',
        CEREBRAS_BASE_URL: baseURL,
        ...extraEnv,
      },
    });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString(); });
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function expectNoHandleCrash(r: Run): void {
  expect(r.stderr).not.toMatch(/UV_HANDLE_CLOSING|Assertion failed|src[\\/]win[\\/]async\.c/);
}

describe('live LLM tools exit cleanly after queue_full refusals', () => {
  it('calibrate sets exitCode 1 after retries instead of crashing', async () => {
    const r = await runTool('tools/llm/calibrate.ts', { LLM_CALIBRATE_MAX: '1' });
    expectNoHandleCrash(r);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('[calibrate] call failed');
    expect(r.stdout).toContain('queue_full');
  }, 60_000);

  it('soak completes and reports queue refusals separately', async () => {
    const r = await runTool('tools/llm/soak.ts', {
      LLM_SOAK_SECONDS: '1', LLM_SOAK_MAX: '2', LLM_SOAK_HZ: '3', LLM_SOAK_WATCH_EVERY_S: '10',
    });
    expectNoHandleCrash(r);
    expect(r.code).toBe(0);
    const json = JSON.parse(r.stdout.slice(r.stdout.indexOf('{'))) as Record<string, unknown>;
    expect(json.queueFullRefusals).toBeGreaterThan(0);
    expect(json).toHaveProperty('retrySuccessPct');
    expect(json).toHaveProperty('queueCongestionPct');
  }, 90_000);
});
