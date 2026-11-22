// Popup toggle for the live bridge. The Theatre reads the same key and also honours ?bridge=1.
import { browser } from 'wxt/browser';

export const BRIDGE_ENABLED_KEY = 'tl:bridge:enabled';

export async function getBridgeEnabled(): Promise<boolean> {
  if (!browser?.storage?.local) return false;   // plain http page (dev/verification): no extension storage
  const v = (await browser.storage.local.get(BRIDGE_ENABLED_KEY))[BRIDGE_ENABLED_KEY];
  return v === true;
}

export async function setBridgeEnabled(on: boolean): Promise<void> {
  await browser.storage.local.set({ [BRIDGE_ENABLED_KEY]: on });
}

export function onBridgeEnabledChange(cb: (on: boolean) => void): () => void {
  const listener = (changes: Record<string, { newValue?: unknown }>, area: string): void => {
    if (area !== 'local' || !changes[BRIDGE_ENABLED_KEY]) return;
    cb(changes[BRIDGE_ENABLED_KEY].newValue === true);
  };
  if (!browser?.storage?.onChanged) return () => undefined;
  browser.storage.onChanged.addListener(listener);
  return () => browser.storage.onChanged.removeListener(listener);
}
