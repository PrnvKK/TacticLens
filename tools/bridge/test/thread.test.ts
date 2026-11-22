import { describe, expect, it } from 'vitest';
import { AnalystThread } from '../src/prompts';
import { BridgeStore } from '../src/store';
import { fixture } from './fixtures';

describe('AnalystThread (append-only)', () => {
  it('keeps the system prompt and earlier turns byte-identical and appends a tiny trigger last', () => {
    const store = new BridgeStore({ snapshotDir: '' });
    const th = new AnalystThread();
    store.ingest(fixture.states[0]!, 1000);
    const a = th.next(store.memory, { updateNumber: 1, includeStatLine: false });
    th.commit('Arsenal are pressing high.');
    for (const s of fixture.states.slice(1, 40)) store.ingest(s, 2000);
    const b = th.next(store.memory, { updateNumber: 2, includeStatLine: false });
    expect(b.slice(0, a.length).map((m) => m.content)).toEqual(a.map((m) => m.content));
    expect(b[a.length]!.role).toBe('assistant');
    expect(b[b.length - 1]!.role).toBe('user');
    expect(b[b.length - 1]!.content).toContain('Update #2');
    expect(b[b.length - 1]!.content).not.toContain('previousUpdates');
  });
});
