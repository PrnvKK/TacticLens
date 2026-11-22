import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';
import { registerLlmHost } from './llm';

// Toolbar toggle. On/off state is kept per tab in chrome.storage.session.
const key = (tabId: number) => `tl:tab:${tabId}`;

async function toggle(tabId: number): Promise<boolean> {
  const k = key(tabId);
  const current = (await browser.storage.session.get(k))[k] === true;
  const next = !current;
  await browser.storage.session.set({ [k]: next });
  await browser.action.setBadgeText({ tabId, text: next ? 'ON' : '' });

  const msg = { type: 'tl:toggle', on: next };
  try {
    await browser.tabs.sendMessage(tabId, msg);
  } catch {
    // Page loaded before the extension was installed: inject, then retry.
    await browser.scripting.executeScript({ target: { tabId }, files: ['/content-scripts/content.js'] });
    await browser.tabs.sendMessage(tabId, msg);
  }
  return next;
}

export default defineBackground(() => {
  registerLlmHost();

  // Fires only when no popup is set; with the popup present, the popup's button sends tl:popup-toggle instead.
  browser.action.onClicked.addListener(async (tab) => {
    if (tab.id !== undefined) await toggle(tab.id);
  });

  browser.runtime.onMessage.addListener((msg: { type?: string; tabId?: number }, _sender, sendResponse) => {
    if (msg?.type === 'tl:popup-toggle' && typeof msg.tabId === 'number') {
      toggle(msg.tabId).then((on) => sendResponse({ on }), (e) => sendResponse({ error: String(e) }));
      return true;
    }
    if (msg?.type === 'tl:popup-state' && typeof msg.tabId === 'number') {
      const k = key(msg.tabId);
      browser.storage.session.get(k).then((r) => sendResponse({ on: r[k] === true }));
      return true;
    }
    return undefined;
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    void browser.storage.session.remove(key(tabId));
  });
});
