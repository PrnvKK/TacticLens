import { describe, expect, it } from 'vitest';
import type { FrameState, LLMProvider } from '../src/types';
import * as tracking from '../src/tracking';

describe('core smoke', () => {
  it('exposes typed contracts and the tracking module', () => {
    const frame: FrameState = {
      t: 0,
      tMedia: 0,
      playbackRate: 1,
      globalMotion: [0, 0],
      quality: 3,
      frameIdx: 0,
      scene: { kind: 'WIDE', confidence: 1 },
      tracks: [],
      ball: { xy: null, visibility: 0, coastingS: 0, state: 'absent' },
      teamsCalibrated: false,
    };
    const provider: LLMProvider = {
      name: 'mock',
      baseURL: 'http://localhost',
      model: 'mock',
      apiKey: '',
      supportsImages: false,
    };
    expect(frame.tracks).toHaveLength(0);
    expect(provider.name).toBe('mock');
    expect(tracking).toBeDefined();
  });
});
