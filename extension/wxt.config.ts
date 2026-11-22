import { defineConfig } from 'wxt';
import preact from '@preact/preset-vite';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(__dirname, '..');
/** Build-time value from the process env, else the repo-root .env. The Cerebras API key is never injected; it stays in the background. */
function envValue(name: string): string {
  if (process.env[name]) return process.env[name]!.trim();
  try {
    const text = readFileSync(resolve(root, '.env'), 'utf8');
    const m = new RegExp(`^${name}\\s*=\\s*(.*)$`, 'm').exec(text);
    return m ? m[1]!.trim().replace(/^["']|["']$/g, '') : '';
  } catch {
    return '';
  }
}
const KIMI_MODEL = envValue('CEREBRAS_KIMI_MODEL');
// GPU baseline (race): the Kimi K3.1 Pro model id and the single pinned OpenRouter host. No API key here.
const GPU_BASELINE_MODEL = envValue('GPU_BASELINE_MODEL');
const GPU_BASELINE_PROVIDER = envValue('GPU_BASELINE_PROVIDER');
// Shared secret for the local Telegram bridge. Injected like the model id; pages never read .env.
const BRIDGE_TOKEN = envValue('BRIDGE_TOKEN');
const BRIDGE_URL = envValue('BRIDGE_URL') || 'http://127.0.0.1:8787';
const ORT_DIST = resolve(__dirname, 'node_modules/onnxruntime-web/dist');
// Assets the brain loads at runtime (models + ORT-web), copied into the build from their sources so the build is
// self-contained and ships only what loads. ort.webgpu.min.mjs references only the asyncify wasm variant
// (the jsep pair in node_modules is for the non-webgpu bundles), so only that pair ships.
const ASSETS: { src: string; dest: string }[] = [
  { src: resolve(root, 'models/onnx/soccana_640.onnx'), dest: 'models/soccana_640.onnx' },
  { src: resolve(root, 'models/onnx/yolo11n_soccernet_ball_640.onnx'), dest: 'models/ball_640.onnx' },
  { src: resolve(root, 'models/onnx/yolo11n_soccernet_ball_1280.onnx'), dest: 'models/ball_1280.onnx' },
  ...['ort.webgpu.min.mjs', 'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'].map((f) => ({ src: resolve(ORT_DIST, f), dest: `ort/${f}` })),
];

// https://wxt.dev/api/config.html
export default defineConfig({
  // The assets above are the only static files shipped (fonts are bundled by Vite through theatre.css), so WXT's public/ copy
  // is turned off: a populated public/ would also copy ORT's unused jsep wasm into the build.
  publicDir: 'no-public',
  vite: () => ({
    plugins: [preact()],
    define: {
      __TL_KIMI_MODEL__: JSON.stringify(KIMI_MODEL),
      __TL_GPU_BASELINE_MODEL__: JSON.stringify(GPU_BASELINE_MODEL),
      __TL_GPU_BASELINE_PROVIDER__: JSON.stringify(GPU_BASELINE_PROVIDER),
      __TL_BRIDGE_TOKEN__: JSON.stringify(BRIDGE_TOKEN),
      __TL_BRIDGE_URL__: JSON.stringify(BRIDGE_URL),
    },
  }),
  hooks: {
    'build:publicAssets': (_wxt, files) => {
      for (const a of ASSETS) {
        if (!existsSync(a.src)) throw new Error(`TacticLens build: missing asset ${a.src} (models: see models/README.md; ORT: pnpm install)`);
        files.push({ absoluteSrc: a.src, relativeDest: a.dest });
      }
    },
  },
  manifest: {
    name: 'TacticLens',
    description: 'Live tactical overlay for football video.',
    action: { default_title: 'TacticLens: toggle overlay' },
    permissions: ['storage', 'activeTab', 'scripting'],
    host_permissions: ['https://api.cerebras.ai/*', 'https://openrouter.ai/*', 'http://127.0.0.1:8787/*'],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
    web_accessible_resources: [
      { resources: ['brain.html'], matches: ['<all_urls>'] },
    ],
  },
});
