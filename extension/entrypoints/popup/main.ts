import { browser } from 'wxt/browser';
import { gpuBaselineConfig, gpuBaselineStatus, kimiModelError, type PresetId } from '@tacticlens/core';
import { getSettings, hasKey, setKey, setSettings } from '../../lib/llm/storage';
import { kimiModelId } from '../../lib/llm/model';
import { getBridgeEnabled, setBridgeEnabled } from '../../lib/bridge/settings';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const presetSel = $<HTMLSelectElement>('preset');
const raceSel = $<HTMLSelectElement>('race');
const mockSel = $<HTMLSelectElement>('mockProfile');
const mockRow = $<HTMLElement>('mockRow');
const modelInput = $<HTMLInputElement>('kimiModel');
const keyInput = $<HTMLInputElement>('key');
const bridgeInput = $<HTMLInputElement>('bridge');
const status = $('status');
const gpuInfo = $('gpuInfo');

/** Strictly Kimi: no other model family is ever offered. The mock is reachable only via ?mock=1. */
const MOCK_QUERY = new URLSearchParams(location.search).get('mock') === '1';
const KIMI_PRESETS: PresetId[] = ['cerebras-kimi', 'gpu-baseline'];
if (MOCK_QUERY) KIMI_PRESETS.push('mock');

function optionLabel(id: PresetId): string {
  if (id === 'gpu-baseline') {
    const s = gpuBaselineStatus();
    return s.configured ? `gpu-baseline (${s.provider})` : 'gpu-baseline (not configured)';
  }
  if (id === 'cerebras-kimi') return 'Cerebras: Kimi';
  return 'Mock (?mock=1 only)';
}

async function refreshStatus() {
  const p = presetSel.value as PresetId;
  if (p === 'mock') { status.textContent = 'Mock needs no key.'; return; }
  const cfg = gpuBaselineConfig();
  if (p === 'cerebras-kimi') {
    const model = kimiModelId(modelInput.value.trim());
    const missing = kimiModelError(model);
    if (missing) { status.textContent = `${missing} (popup or build env).`; return; }
  }
  if (p === 'gpu-baseline') {
    const s = gpuBaselineStatus(await hasKey('gpu-baseline') ? 'present' : '');
    if (!s.configured) { status.textContent = `gpu-baseline not configured: ${s.reason ?? 'set GPU_BASELINE_PROVIDER'}.`; return; }
    status.textContent = `GPU baseline: ${s.model} via ${s.provider}. ${await hasKey('gpu-baseline') ? 'A key is saved.' : 'Save an OpenRouter key below.'}`;
    gpuInfo.textContent = `${cfg.model} on ${cfg.provider}`;
    return;
  }
  status.textContent = (await hasKey(p)) ? 'A key is saved for this provider.' : 'No key saved for this provider.';
}

async function init() {
  presetSel.innerHTML = KIMI_PRESETS.map((i) => `<option value="${i}">${optionLabel(i)}</option>`).join('');
  raceSel.innerHTML = '<option value="">(off)</option>' + KIMI_PRESETS.map((i) => `<option value="${i}">${optionLabel(i)}</option>`).join('');
  const s = await getSettings();
  const allowed = (p: PresetId | null | undefined): p is PresetId => !!p && KIMI_PRESETS.includes(p);
  const preset = allowed(s.preset) ? s.preset : 'cerebras-kimi';
  if (preset !== s.preset) await setSettings({ preset });
  presetSel.value = preset;
  const race = allowed(s.racePreset) ? s.racePreset : '';
  if ((s.racePreset ?? '') !== race) await setSettings({ racePreset: race || null });
  raceSel.value = race;
  mockSel.value = s.mockProfile;
  mockRow.style.display = MOCK_QUERY ? '' : 'none';
  modelInput.value = s.kimiModel || kimiModelId();
  modelInput.placeholder = 'required: set CEREBRAS_KIMI_MODEL';
  const gpu = gpuBaselineConfig();
  gpuInfo.textContent = `${gpu.model}${gpu.provider ? ` on ${gpu.provider}` : ' (set GPU_BASELINE_PROVIDER to pin a host)'}`;
  bridgeInput.checked = await getBridgeEnabled();
  await refreshStatus();

  presetSel.onchange = async () => { await setSettings({ preset: presetSel.value as PresetId }); keyInput.value = ''; await refreshStatus(); };
  raceSel.onchange = () => setSettings({ racePreset: (raceSel.value || null) as PresetId | null });
  mockSel.onchange = () => setSettings({ mockProfile: mockSel.value as 'cerebras' | 'gpu' });
  modelInput.onchange = async () => { await setSettings({ kimiModel: modelInput.value.trim() }); await refreshStatus(); };
  bridgeInput.onchange = () => setBridgeEnabled(bridgeInput.checked);
  $('save').onclick = async () => {
    await setSettings({ kimiModel: modelInput.value.trim() });
    await setKey(presetSel.value as PresetId, keyInput.value.trim());
    keyInput.value = '';
    await refreshStatus();
  };
  $('toggle').onclick = async () => {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id !== undefined) await browser.runtime.sendMessage({ type: 'tl:popup-toggle', tabId: tab.id });
    window.close();
  };
}
void init();
