import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Shared handles set by bin/sentinel.js so a screen can hand the terminal to $EDITOR and take it back. */
export const term = { out: null, painter: null, app: null, setRaw: null };

/** Open `text` in $VISUAL / $EDITOR (alt screen released meanwhile). Returns the edited text, or null on failure. */
export function editExternally(text) {
  const { out, painter, app, setRaw } = term;
  const file = path.join(os.tmpdir(), `sentinel-comment-${process.pid}-${Date.now()}.txt`);
  try {
    fs.writeFileSync(file, text + '\n', { mode: 0o600 });
    const editor = process.env.VISUAL || process.env.EDITOR || 'vi';
    out?.write('\x1b[0m\x1b[?1049l'); setRaw?.(false);
    const r = spawnSync(`${editor} "${file}"`, { stdio: 'inherit', shell: true });
    setRaw?.(true); out?.write('\x1b[?1049h'); painter?.prime(); app?.clear();
    if (r.error || r.status !== 0) return null;
    return fs.readFileSync(file, 'utf8').replace(/\s+$/, '');
  } catch { return null; }
  finally { try { fs.unlinkSync(file); } catch {} }
}
