// Settings and API keys in chrome.storage.local. Keys are read only by the background; pages never call getKey.
import { browser } from 'wxt/browser';
import type { PresetId } from '@tacticlens/core';
import { DEFAULT_SETTINGS, type LLMSettings } from './protocol';

const KEY_PREFIX = 'tl:llm:key:';
const SETTINGS = 'tl:llm:settings';

export async function setKey(preset: PresetId, key: string): Promise<void> {
  if (key) await browser.storage.local.set({ [KEY_PREFIX + preset]: key });
  else await browser.storage.local.remove(KEY_PREFIX + preset);
}
export async function getKey(preset: PresetId): Promise<string> {
  const k = KEY_PREFIX + preset;
  return ((await browser.storage.local.get(k))[k] as string | undefined) ?? '';
}
export async function hasKey(preset: PresetId): Promise<boolean> { return (await getKey(preset)).length > 0; }

export async function getSettings(): Promise<LLMSettings> {
  if (!browser?.storage?.local) return { ...DEFAULT_SETTINGS };   // plain http page (dev/verification)
  const s = (await browser.storage.local.get(SETTINGS))[SETTINGS] as Partial<LLMSettings> | undefined;
  return { ...DEFAULT_SETTINGS, ...s };
}
export async function setSettings(s: Partial<LLMSettings>): Promise<LLMSettings> {
  const next = { ...(await getSettings()), ...s };
  await browser.storage.local.set({ [SETTINGS]: next });
  return next;
}
