import { afterEach, describe, expect, it } from 'vitest';
import {
  PRESETS, GPU_BASELINE_DEFAULT_MODEL, configureGpuBaseline, gpuBaselineConfig, gpuBaselineStatus, kimiModelError,
  resolveProvider, type PresetId,
} from '../../src/llm/providers';

const BANNED = /gpt-oss|qwen|llama|glm/i;

afterEach(() => configureGpuBaseline(null));

describe('Kimi-only presets', () => {
  it('has no non-Kimi model id reachable in any runtime preset', () => {
    for (const p of Object.values(PRESETS)) {
      expect(p.provider.model).not.toMatch(BANNED);
    }
    for (const id of Object.keys(PRESETS) as PresetId[]) {
      expect(resolveProvider(id, '').model).not.toMatch(BANNED);
    }
  });

  it('requires CEREBRAS_KIMI_MODEL instead of falling back to another family', () => {
    expect(resolveProvider('cerebras-kimi', 'k').model).toBe('');
    expect(kimiModelError('')).toMatch(/CEREBRAS_KIMI_MODEL/);
    expect(kimiModelError('moonshotai-kimi-k3.1-pro-trial')).toBeNull();
  });
});

describe('gpu-baseline preset', () => {
  it('is "not configured" without a pinned GPU provider, with no fake data', () => {
    configureGpuBaseline({ model: GPU_BASELINE_DEFAULT_MODEL, provider: '' });
    const s = gpuBaselineStatus('');
    expect(s.configured).toBe(false);
    expect(s.label).toBe('not configured');
    expect(s.reason).toMatch(/GPU_BASELINE_PROVIDER/);
    expect(gpuBaselineConfig().model).toBe('moonshotai/kimi-k3.1-pro');
  });

  it('pins one host through the provider-routing field and labels it for the race UI', () => {
    configureGpuBaseline({ provider: 'Fireworks' });
    const s = gpuBaselineStatus('sk-or-key');
    expect(s.configured).toBe(true);
    expect(s.label).toBe('gpu-baseline:Fireworks');
    const p = resolveProvider('gpu-baseline', 'sk-or-key');
    expect(p.model).toBe('moonshotai/kimi-k3.1-pro');
    expect(p.baseURL).toBe('https://openrouter.ai/api/v1');
    expect(p.name).toBe('gpu-baseline:Fireworks');
    expect((p.extra as any).provider).toEqual({ order: ['Fireworks'], allow_fallbacks: false });
  });

  it('reports the missing key honestly', () => {
    configureGpuBaseline({ provider: 'Fireworks' });
    const s = gpuBaselineStatus('');
    expect(s.configured).toBe(false);
    expect(s.reason).toMatch(/OPENROUTER_API_KEY/);
  });
});
