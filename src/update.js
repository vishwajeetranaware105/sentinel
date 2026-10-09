/** Update check: compares this version with the newest `vX.Y.Z` tag on GitHub (cached 12h, never blocks startup). */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { HOME_DIR } from './config.js';

export const APP_REPO = 'vishwajeetranaware105/sentinel';
const CACHE = path.join(HOME_DIR, 'update.json');
const TTL = 12 * 3600 * 1000;

const parts = (v) => String(v).replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0);
export const isNewer = (a, b) => { const x = parts(a), y = parts(b); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };

const readCache = () => { try { return JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch { return null; } };

/** Newest version we already know about, from the last check (instant, offline-safe). */
export function knownLatest(current) {
  const c = readCache();
  return c?.latest && isNewer(c.latest, current) ? c.latest : null;
}

/** Ask GitHub for tags (3s timeout) and cache the newest one. Safe to fire and forget. */
export async function refreshLatest({ force = false } = {}) {
  const c = readCache();
  if (!force && c && Date.now() - c.at < TTL) return c.latest;
  try {
    const r = await fetch(`https://api.github.com/repos/${APP_REPO}/tags?per_page=30`, { signal: AbortSignal.timeout(3000), headers: { accept: 'application/vnd.github+json' } });
    if (!r.ok) return c?.latest || null;
    const tags = (await r.json()).map((t) => t.name).filter((n) => /^v?\d+\.\d+\.\d+$/.test(n));
    const latest = tags.sort((a, b) => (isNewer(a, b) ? -1 : isNewer(b, a) ? 1 : 0))[0]?.replace(/^v/, '') || null;
    fs.mkdirSync(HOME_DIR, { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify({ at: Date.now(), latest }));
    return latest;
  } catch { return c?.latest || null; }
}

/** How was this copy installed? Decides which command upgrades it. */
export function installKind() {
  let p = ''; try { p = realpathSync(process.argv[1]); } catch { p = process.argv[1] || ''; }
  return /[\\/]Cellar[\\/]|[\\/]Homebrew[\\/]/.test(p) ? 'brew' : 'npm';
}

export function runUpdate() {
  const kind = installKind();
  const [cmd, args] = kind === 'brew' ? ['sh', ['-c', 'brew update && brew upgrade sentinel']] : ['npm', ['install', '-g', `github:${APP_REPO}`]];
  console.log(`Updating Sentinel (${kind}): ${kind === 'brew' ? 'brew update && brew upgrade sentinel' : `npm install -g github:${APP_REPO}`}\n`);
  return spawnSync(cmd, args, { stdio: 'inherit' }).status === 0;
}
