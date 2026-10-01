import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join, resolve } from 'path';

// Optional local .env (gitignored) in the tool folder, so a submodule host can
// persist RUE_CONFIG without editing tracked files. Only KEY=VALUE lines;
// existing env wins. Imported first by the tool's entry points so RUE_CONFIG is
// set before the RUE server locates its project config.
const toolRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const envPath  = join(toolRoot, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf-8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
