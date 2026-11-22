// Registers a resolve hook so Node (type stripping, see package.json "replay" script) can load the core/src TypeScript,
// which uses extensionless relative imports (Bundler resolution).
import { register } from 'node:module';
register('./resolve-hook.mjs', import.meta.url);
