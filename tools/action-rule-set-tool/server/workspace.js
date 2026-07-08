import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, rmSync, statSync, cpSync, readdirSync } from 'fs';
import { dirname, join, resolve, sep } from 'path';
import { fileURLToPath } from 'url';
import { tmpdir } from 'os';

// A staging ("shadow") copy of every data file the tool touches. All server
// reads/writes go through workingPath(), so edits land in the shadow and the
// real files stay untouched until saveToFile() flushes them. The shadow lives
// in the OS temp dir and is cleared on each server start, so a session always
// begins from the real files on disk.
const SHADOW_ROOT = join(tmpdir(), 'klugh-tool-shadow');
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..'); // not used for paths; kept for parity

const mirrored = new Map(); // real absolute path -> shadow absolute path

function shadowFor(absReal) {
  // Flatten the absolute path so distinct files never collide in the flat root.
  return join(SHADOW_ROOT, absReal.split(sep).filter(Boolean).join('__'));
}

// The shadow path for a real file, seeded from the real file the first time it
// is touched. Everything else in the server resolves paths through here.
export function workingPath(realPath) {
  if (!realPath) return realPath;
  const abs = resolve(realPath);
  let shadow = mirrored.get(abs);
  if (!shadow) { shadow = shadowFor(abs); mirrored.set(abs, shadow); }
  if (!existsSync(shadow) && existsSync(abs)) {
    if (statSync(abs).isFile()) {
      mkdirSync(dirname(shadow), { recursive: true });
      copyFileSync(abs, shadow);
    } else if (statSync(abs).isDirectory()) {
      mkdirSync(dirname(shadow), { recursive: true });
      cpSync(abs, shadow, { recursive: true });
    }
  }
  return shadow;
}

const read = (p) => (existsSync(p) && statSync(p).isFile() ? readFileSync(p, 'utf-8') : null);

// Real paths whose shadow has diverged — the unsaved edits.
export function pendingChanges() {
  const changed = [];
  
  function check(real, shadow) {
    if (existsSync(real) && statSync(real).isDirectory()) {
      // It's a mirrored directory. Crawl all files recursively.
      if (!existsSync(shadow)) return;
      function walk(dirReal, dirShadow) {
        const items = readdirSync(dirShadow);
        for (const item of items) {
          const itemReal = join(dirReal, item);
          const itemShadow = join(dirShadow, item);
          if (statSync(itemShadow).isDirectory()) {
            walk(itemReal, itemShadow);
          } else {
            if (read(itemShadow) !== read(itemReal)) changed.push(itemReal);
          }
        }
      }
      walk(real, shadow);
    } else {
      if (read(shadow) !== read(real)) changed.push(real);
    }
  }

  for (const [real, shadow] of mirrored) check(real, shadow);
  return changed.sort();
}

// Flush every diverged shadow file back to its real  Returns what was saved.
export function saveToFile() {
  const saved = [];
  
  function flush(real, shadow) {
    if (existsSync(real) && statSync(real).isDirectory()) {
      if (!existsSync(shadow)) return;
      function walk(dirReal, dirShadow) {
        const items = readdirSync(dirShadow);
        for (const item of items) {
          const itemReal = join(dirReal, item);
          const itemShadow = join(dirShadow, item);
          if (statSync(itemShadow).isDirectory()) {
            walk(itemReal, itemShadow);
          } else {
            const s = read(itemShadow);
            if (s !== null && s !== read(itemReal)) {
              mkdirSync(dirname(itemReal), { recursive: true });
              writeFileSync(itemReal, s);
              saved.push(itemReal);
            }
          }
        }
      }
      walk(real, shadow);
    } else {
      const s = read(shadow);
      if (s !== null && s !== read(real)) {
        mkdirSync(dirname(real), { recursive: true });
        writeFileSync(real, s);
        saved.push(real);
      }
    }
  }

  for (const [real, shadow] of mirrored) flush(real, shadow);
  return saved;
}

// Drop the whole shadow, reverting to the real files on the next access.
export function discardShadow() {
  if (existsSync(SHADOW_ROOT)) rmSync(SHADOW_ROOT, { recursive: true, force: true });
  mirrored.clear();
}

discardShadow(); // fresh shadow per server start
