import { describe, expect, it } from 'vitest';
import { classifyHttpError, classifyNetworkError, headersExhausted, looksQueueFull } from '../../src/llm/errors';

const headers = (values: Record<string, string>) => ({
  get: (n: string) => values[n.toLowerCase()] ?? null,
});
const QUEUE_BODY = JSON.stringify({
  message: "We're experiencing high traffic right now! Please try again soon.",
  type: 'too_many_requests_error',
  param: 'queue',
  code: 'queue_exceeded',
});

describe('HTTP error classification', () => {
  it('recognises Cerebras queue_exceeded as queue_full', () => {
    const e = classifyHttpError(429, QUEUE_BODY);
    expect(e.kind).toBe('queue_full');
    expect(e.status).toBe(429);
    expect(e.code).toBe('queue_exceeded');
    expect(e.message).toContain('high traffic');
  });

  it('treats a plain 429 as rate_limited', () => {
    const e = classifyHttpError(429, JSON.stringify({ message: 'Rate limit exceeded', code: 'rate_limit_exceeded' }));
    expect(e.kind).toBe('rate_limited');
    expect(e.code).toBe('rate_limit_exceeded');
  });

  it('treats a 429 with exhausted x-ratelimit headers as rate_limited even if the text is vague', () => {
    const e = classifyHttpError(429, '{"message":"slow down"}', headers({ 'x-ratelimit-remaining-requests': '0' }));
    expect(e.kind).toBe('rate_limited');
    expect(headersExhausted(headers({ 'x-ratelimit-remaining-requests': '0' }))).toBe(true);
  });

  it('classifies 5xx as server and other 4xx as client', () => {
    expect(classifyHttpError(503, 'unavailable').kind).toBe('server');
    expect(classifyHttpError(500).kind).toBe('server');
    expect(classifyHttpError(400, '{"message":"bad request"}').kind).toBe('client');
    expect(classifyHttpError(401).kind).toBe('client');
  });

  it('classifies a transport failure without a status as network', () => {
    expect(classifyHttpError(undefined, 'fetch failed').kind).toBe('network');
    expect(classifyNetworkError(new TypeError('fetch failed'))).toMatchObject({ kind: 'network' });
  });

  it('finds queue markers in nested bodies and in the message alone', () => {
    expect(looksQueueFull(JSON.stringify({ error: { code: 'queue_exceeded' } }))).toBe(true);
    expect(looksQueueFull(JSON.stringify({ param: 'queue' }))).toBe(true);
    expect(looksQueueFull('{"message":"We are experiencing HIGH TRAFFIC"}')).toBe(true);
    expect(looksQueueFull('{"message":"rate limit"}')).toBe(false);
    expect(classifyHttpError(429, JSON.stringify({ error: { param: 'queue' } })).kind).toBe('queue_full');
  });

  it('keeps retry-after on the event info', () => {
    const e = classifyHttpError(429, 'slow down', headers({ 'retry-after': '2' }));
    expect(e.retryAfterMs).toBe(2000);
    expect(e.kind).toBe('rate_limited');
  });
});
