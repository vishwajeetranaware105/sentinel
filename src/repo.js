import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

const GENERIC = /^(Decode|Encode|Show|Eq|Ord|Generic|Maybe|Either|Unit|Array|String|Int|Number|Boolean|Effect|Aff|Object|Record|Newtype|Semigroup|Monoid|Functor|Monad|Type|State|Action|Props|Config|Error|Result|Value|Data|Item|Model|Util|Helper|Main)$/;
const SAFE_REF = /^[\w./@+-]+$/;

/** Run git. Auth is a Bearer header passed through env (never in argv / remote URL / .git/config). */
function git(cwd, args, { timeout = 120000, token, okCodes = [] } = {}) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (token) Object.assign(env, { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}` });
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout, maxBuffer: 30 * 1024 * 1024, env }, (err, stdout, stderr) => {
      if (err && !okCodes.includes(err.code)) return reject(new Error(redact((stderr || err.message).trim(), token).slice(0, 300)));
      resolve(stdout);
    });
  });
}
const redact = (s, t) => (t ? s.split(t).join('***') : s);

export function repoUrl(cfg, ws, repo) {
  if (cfg.cloneUrlTemplate) return cfg.cloneUrlTemplate.replaceAll('{ws}', ws).replaceAll('{repo}', repo);
  return `${cfg.bitbucket.baseUrl.replace(/\/+$/, '')}/scm/${ws.toLowerCase()}/${repo}.git`;
}

// Definition lines whose removal/change can break callers.
const DEF_RES = [
  /\b(?:fun|func|function|def|fn|class|interface|object|struct|enum|trait|type|data|newtype)\s+([A-Za-z_]\w{3,})/,
  /^(?:export\s+)?(?:val|var|const|let)\s+([A-Za-z_]\w{4,})\s*[:=]/, // top-level only: skip locals
  /^\s*([a-z_]\w{3,})\s*::/, // PureScript / Haskell signatures
  /\b(?:public|private|protected|internal|static|external)\b[\w\s<>,[\]?*&]*?\b([A-Za-z_]\w{3,})\s*\(/,
];
export function changedSymbols(files, max = 12) {
  const names = new Map();
  for (const f of files) for (const h of f.hunks) for (const l of h.lines) {
    if (l.type !== 'REMOVED') continue;
    for (const re of DEF_RES) {
      const m = l.text.match(re);
      if (m && !GENERIC.test(m[1]) && !/^(this|self|true|false|null|None|return|class|public|private|static|const|void|string)$/i.test(m[1])) { names.set(m[1], f.path); break; }
    }
  }
  return [...names].slice(0, max).map(([name, file]) => ({ name, file }));
}

/**
 * Local, shallow, checkout-less copy of just the PR head and base branches.
 * Gives the verifier real `git grep` over the code, and lets analysis see callers of changed symbols.
 */
export class RepoView {
  constructor({ cfg, bb, ws, repo, head, base, log, onState }) {
    Object.assign(this, { cfg, bb, ws, repo, head, base, log, onState });
    this.dir = path.join(cfg.workspaceRoot, ws, repo);
    this.token = cfg.bitbucket.token;
    this.local = false;
    this.state = { state: 'idle', dir: this.dir };
  }
  set(state, extra = {}) { this.state = { state, dir: this.dir, ...extra }; this.onState?.(this.state); }

  async prepare() {
    if (this.preparing) return this.preparing;
    this.preparing = (async () => {
      try {
        if (!SAFE_REF.test(this.head) || !SAFE_REF.test(this.base)) throw new Error('unsupported branch name');
        this.set('fetching');
        fs.mkdirSync(this.dir, { recursive: true });
        if (!fs.existsSync(path.join(this.dir, '.git'))) await git(this.dir, ['init', '--quiet']);
        const url = repoUrl(this.cfg, this.ws, this.repo);
        await git(this.dir, ['remote', 'remove', 'origin'], { okCodes: [2, 128] }).catch(() => {});
        await git(this.dir, ['remote', 'add', 'origin', url]);
        // depth=1 of two branches: every file at head and base, none of the history.
        await git(this.dir, ['fetch', '--quiet', '--no-tags', '--depth=1', 'origin',
          `+refs/heads/${this.head}:refs/sentinel/head`, `+refs/heads/${this.base}:refs/sentinel/base`],
        { timeout: 600000, token: this.token });
        this.local = true;
        const short = async (r) => (await git(this.dir, ['rev-parse', '--short=8', r]).catch(() => '')).trim();
        this.set('ready', { headSha: await short(this.ref('head')), baseSha: await short(this.ref('base')), head: this.head, base: this.base });
        this.log(`Repo ready at ${this.dir} (PR head + base)`);
      } catch (e) {
        this.local = false;
        this.set('fallback', { reason: e.message });
        this.log(`Local copy unavailable (${e.message}); falling back to Bitbucket search`);
      }
      return this.local;
    })();
    return this.preparing;
  }

  ref(side) { return side === 'base' ? 'refs/sentinel/base' : 'refs/sentinel/head'; }

  async grep({ pattern, glob, side = 'head', max = 25, word = false, excludeFile }) {
    if (!pattern || pattern.length > 300) return 'invalid pattern';
    if (this.local) {
      const args = ['grep', '-n', '-I', word ? '-wE' : '-E', '-e', pattern, this.ref(side), '--'];
      args.push(glob ? glob.replace(/^-+/, '') : '.');
      if (excludeFile) args.push(`:(exclude)${excludeFile}`);
      if (!glob) args.push(':(exclude)*.md', ':(exclude)docs/', ':(exclude)*CHANGELOG*', ':(exclude)*.lock', ':(exclude)*lock.json');
      try {
        const out = await git(this.dir, args, { timeout: 30000, okCodes: [1] });
        const lines = out.split('\n').filter(Boolean).map((l) => l.replace(/^refs\/sentinel\/(head|base):/, ''));
        return lines.length ? lines.slice(0, max).join('\n') + (lines.length > max ? `\n… ${lines.length - max} more` : '') : 'no matches';
      } catch (e) { return `grep failed: ${e.message}`; }
    }
    try {
      const r = await this.bb.grep(this.ws, this.repo, { query: pattern, branch: side === 'base' ? this.base : this.head, glob, max_results: max });
      return typeof r === 'string' ? r.slice(0, 4000) : JSON.stringify(r).slice(0, 4000);
    } catch (e) { return `grep failed: ${e.message}`; }
  }

  async read({ file, start = 1, count = 60, side = 'head' }) {
    count = Math.min(Math.max(+count || 60, 1), 200); start = Math.max(+start || 1, 1);
    if (this.local) {
      try {
        const out = await git(this.dir, ['show', `${this.ref(side)}:${file}`], { timeout: 30000 });
        return out.split('\n').slice(start - 1, start - 1 + count).map((t, i) => `${start + i}: ${t}`).join('\n') || 'empty / out of range';
      } catch (e) { return `read failed: ${e.message}`; }
    }
    try {
      const r = await this.bb.fileContent(this.ws, this.repo, file, { branch: side === 'base' ? this.base : this.head, start_line: start, line_count: count });
      return typeof r === 'string' ? r.slice(0, 6000) : JSON.stringify(r).slice(0, 6000);
    } catch (e) { return `read failed: ${e.message}`; }
  }

  /**
   * Token-free enrichment: who still uses the symbols this chunk removes or redefines?
   * Returns a compact text block for the prompt (empty if there is nothing to say).
   */
  async callerContext(files, { maxChars = 3500 } = {}) {
    if (!this.local) return '';
    const syms = changedSymbols(files);
    if (!syms.length) return '';
    const removed = new Set();
    for (const f of files) for (const h of f.hunks) for (const l of h.lines) if (l.type === 'REMOVED') removed.add(`${f.path}|${l.text.trim()}`);
    const parts = [];
    for (const s of syms) {
      const [h, b] = await Promise.all([
        this.grep({ pattern: s.name, side: 'head', word: true, max: 6, excludeFile: s.file }),
        this.grep({ pattern: s.name, side: 'base', word: true, max: 8, excludeFile: s.file }),
      ]);
      const parse = (out) => out.split('\n').map((l) => l.match(/^([^:]+):(\d+):(.*)$/)).filter(Boolean).map((m) => ({ path: m[1], line: m[2], text: m[3] }));
      const key = (x) => `${x.path}|${x.text.trim()}`;
      const onHead = parse(h), headKeys = new Set(onHead.map(key));
      // References on the latest target branch that the PR branch does not have, and that the PR itself did not remove:
      // typically callers added to main after this branch diverged. They break the moment the PR merges.
      const onlyMain = parse(b).filter((x) => !headKeys.has(key(x)) && !removed.has(key(x))).slice(0, 5);
      const fmt = (list) => list.map((x) => `    ${x.path}:${x.line}: ${x.text.trim().slice(0, 140)}`).join('\n');
      if (!onHead.length && !onlyMain.length) { parts.push(`${s.name}: no other references on the PR branch or on latest ${this.base}`); continue; }
      parts.push(`${s.name} (changed in ${s.file}):${onHead.length ? `\n  still used on the PR branch:\n${fmt(onHead)}` : ''}${onlyMain.length ? `\n  ONLY on latest ${this.base} (not on this branch; will still call it after merge):\n${fmt(onlyMain)}` : ''}`);
    }
    return parts.join('\n').slice(0, maxChars);
  }
}

const GUIDE_FILES = new Set(['CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md', '.cursorrules', 'copilot-instructions.md']);

/**
 * Guideline files that apply to this PR: from the repo root and from every directory above a changed file
 * (same rule Claude Code's review uses for CLAUDE.md). Needs the local copy; returns [{path, text}].
 */
RepoView.prototype.guidelines = async function guidelines(files, { maxChars = 5000, perFile = 2500 } = {}) {
  if (!this.local) return [];
  try {
    const dirs = new Set(['']);
    for (const f of files) { let d = path.posix.dirname(f.path); while (d && d !== '.') { dirs.add(d); d = path.posix.dirname(d); } }
    const tree = await git(this.dir, ['ls-tree', '-r', '--name-only', this.ref('head')], { timeout: 30000 });
    const found = tree.split('\n').filter((p) => GUIDE_FILES.has(path.posix.basename(p)) && dirs.has(path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p)))
      .sort((a, b) => a.split('/').length - b.split('/').length).slice(0, 8);
    const out = []; let used = 0;
    for (const p of found) {
      if (used >= maxChars) break;
      let text = await git(this.dir, ['show', `${this.ref('head')}:${p}`], { timeout: 15000 }).catch(() => '');
      text = text.trim().slice(0, Math.min(perFile, maxChars - used));
      if (text) { out.push({ path: p, text }); used += text.length; }
    }
    return out;
  } catch { return []; }
};

/** `sentinel clone WS/repo`: a full clone for people who want one around. */
export async function cloneRepo(cfg, ws, repo, log = console.log) {
  const dir = path.join(cfg.workspaceRoot, ws, repo);
  if (fs.existsSync(path.join(dir, '.git'))) { log(`✓ ${ws}/${repo} already present at ${dir}`); return dir; }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  log(`Cloning ${ws}/${repo} → ${dir}`);
  await git(path.dirname(dir), ['clone', '--quiet', repoUrl(cfg, ws, repo), repo], { timeout: 900000, token: cfg.bitbucket.token });
  return dir;
}
