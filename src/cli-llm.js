/**
 * Model backends that shell out to a locally installed, already-logged-in CLI (Claude Code or Codex),
 * so no API key is needed. Prompts go through stdin; the CLI runs in an empty temp dir with tools disabled
 * so it only answers and never reads or edits anything.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CLI_PROVIDERS = {
  claude: { bin: 'claude', label: 'Claude Code', models: ['sonnet', 'opus', 'haiku'], strong: 'sonnet', fast: 'haiku' },
  codex: { bin: 'codex', label: 'Codex', models: [], strong: '', fast: '' },     // empty = the model set in ~/.codex/config.toml
};
export const isCli = (p) => Object.hasOwn(CLI_PROVIDERS, p);

const flat = (messages) => messages.map((m) => (m.role === 'system' ? `[Instructions]\n${m.content}` : m.content)).join('\n\n');

/** Returns { text, usage|null }. Rejects with .fatal for auth/usage problems. */
export function runCli(provider, messages, { model, signal, onChunk } = {}) {
  const spec = CLI_PROVIDERS[provider];
  const dir = mkdtempSync(join(tmpdir(), 'sentinel-llm-'));
  const outFile = join(dir, 'last.txt');
  const args = provider === 'claude'
    ? ['-p', '--output-format', 'json', '--tools', '', '--no-session-persistence', '--setting-sources', '', '--system-prompt', 'You are a precise code-review engine. Follow the instructions in the user message exactly and answer only in the requested format.', ...(model ? ['--model', model] : [])]
    : ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '--output-last-message', outFile, '-C', dir, ...(model ? ['-m', model] : []), '-'];
  return new Promise((resolve, reject) => {
    const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} };
    const child = spawn(spec.bin, args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    let out = '', err = '';
    const kill = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', (d) => { out += d; onChunk?.(); });
    child.stderr.on('data', (d) => { err += d; onChunk?.(); });
    child.on('error', (e) => { cleanup(); reject(Object.assign(new Error(e.code === 'ENOENT' ? `${spec.bin} not found on PATH — install ${spec.label} and log in` : e.message), { fatal: true })); });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', kill);
      try {
        if (signal?.aborted) return reject(signal.reason || new Error('aborted'));
        if (provider === 'claude') {
          let j; try { j = JSON.parse(out); } catch { j = null; }
          if (!j || j.is_error || code) return reject(Object.assign(new Error(`${spec.label}: ${String(j?.result || err || out).slice(0, 300) || `exit ${code}`}`), { fatal: true }));
          const u = j.usage || {};
          const prompt = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0);
          return resolve({ text: j.result || '', usage: prompt || u.output_tokens ? { prompt_tokens: prompt, completion_tokens: u.output_tokens || 0 } : null });
        }
        let text = ''; try { text = readFileSync(outFile, 'utf8'); } catch {}
        if (code || !text.trim()) return reject(Object.assign(new Error(`${spec.label}: ${(err || out).trim().split('\n').slice(-3).join(' ').slice(0, 300) || `exit ${code}`}`), { fatal: true }));
        resolve({ text, usage: null });
      } finally { cleanup(); }
    });
    child.stdin.on('error', () => {});
    child.stdin.end(flat(messages));
  });
}
