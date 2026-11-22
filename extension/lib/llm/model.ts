// Kimi model id resolution. The id is a setting, not code: the popup value wins, then the build-time
// __TL_KIMI_MODEL__ injected from CEREBRAS_KIMI_MODEL, then the cerebras-dev fallback in core.
import { resolveProvider, type LLMProvider, type PresetId } from '@tacticlens/core';

declare const __TL_KIMI_MODEL__: string;

function envModel(): string {
  return typeof __TL_KIMI_MODEL__ === 'string' ? __TL_KIMI_MODEL__.trim() : '';
}

/** Popup setting -> build-time env -> '' (core falls back to the cerebras-dev model). */
export function kimiModelId(setting?: string): string {
  return (setting?.trim() || envModel() || '').trim();
}

export function providerFor(preset: PresetId, key: string, kimiModel?: string): LLMProvider {
  if (preset !== 'cerebras-kimi') return resolveProvider(preset, key);
  const model = kimiModelId(kimiModel);
  return resolveProvider(preset, key, model ? { model } : undefined);
}
