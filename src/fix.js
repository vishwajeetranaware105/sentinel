import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { git, repoUrl } from './repo.js';
import { HOME_DIR, RUNS_DIR } from './config.js';
import { LLM } from './llm.js';

const PROTECTED = /^(master|main|develop|development|staging|production|prod|release([/-].*)?|hotfix([/-].*)?)$/i;
const SAFE_REF = /^[\w./@+-]+$/;
const BOT = /(\.bot\b|bot@|\bbot\b|curator|euler|xyne|jenkins|sonar|dependabot|github-actions)/i;

const FIX_SYSTEM = `You are the author of a pull request and a reviewer left a comment on your code. Decide what to change, then make the smallest correct edit.
Reply ONLY with JSON:
{"action":"edit"|"no_change","edits":[{"file":"path","find":"exact text copied from the file","replace":"new text"}],"summary":"one sentence: what you changed and why","reply":"one or two plain sentences you would answer the reviewer with"}
Rules:
- "find" must be copied exactly from the file shown (without the line-number gutter), include enough surrounding lines to be unique, keep indentation identical.
- Change only what the comment asks for. No refactors, no unrelated formatting, no new files.
- If the comment is a question, a discussion, or you disagree with it, use "no_change" and put your answer in "reply".
- If you cannot be sure from the code shown, ask for a lookup instead of guessing: {"need":[{"grep":"regex","glob":"*.ext"},{"file":"path","start":1,"count":60}]} (at most 4, run for you; you then get one more turn).`;

/** Findings Sentinel already produced for this PR (the newest saved run that has any): bugs, breaking changes, suggestions still worth acting on. */
export function latestFindings(pr) {
  let best = null;
  try {
    for (const f of fs.readdirSync(RUNS_DIR)) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), 'utf8'));
        if (d.pr?.workspace === pr.workspace && d.pr?.repository === pr.repository && String(d.pr?.id) === String(pr.id) && Array.isArray(d.findings) && d.findings.length && (!best || d.createdAt > best.createdAt)) best = d;
      } catch {}
    }
  } catch {}
  return best ? best.findings.filter((x) => x.kind !== 'reply' && x.verification?.verdict !== 'withdrawn' && x.status !== 'rejected' && x.status !== 'posted') : [];
}

/** Work on your own PR: turn open review comments into code changes in a real checkout, then commit and push on request. */
export class FixSession extends EventEmitter {
  constructor({ cfg, bb, pr, llm, findings = null }) {
    super();
    this.findingsIn = findings;
    this.cfg = cfg; this.bb = bb; this.pr = pr; this.llm = llm || new LLM(cfg);
    this.src = pr.source_branch; this.dst = pr.destination_branch;
    this.dir = path.join(HOME_DIR, 'fix', pr.workspace, pr.repository, `pr-${pr.id}`);
    this.token = cfg.bitbucket.token;
    this.threads = []; this.results = new Map(); this.base = null; this.committed = null;
  }
  log(msg) { this.emit('log', msg); }

  isMine(m) {
    const me = String(this.cfg.bitbucket.username || '').toLowerCase();
    return !!me && (m.email === me || String(m.slug).toLowerCase() === me);
  }

  /**
   * What can be fixed: Sentinel's own findings for this PR (bugs, breaking changes) first, then every open comment thread
   * from people (including comments you posted yourself while reviewing), skipping bots.
   */
  async load() {
    const live = (x) => x.kind !== 'reply' && x.verification?.verdict !== 'withdrawn' && x.status !== 'rejected' && x.status !== 'posted';
    const fromFindings = (this.findingsIn ?? latestFindings(this.pr)).filter(live).map((f) => ({
      id: `f:${f.id}`, source: 'finding', path: f.file || null, line: f.line || null, resolved: false, task: f.severity === 'blocker', answered: false,
      label: `${f.kind || 'bug'}${f.severity ? ' · ' + f.severity : ''}: ${f.title || ''}`,
      messages: [{ id: f.id, who: 'Sentinel', email: '', slug: 'sentinel', at: 0,
        text: `${f.body || ''}${f.failureScenario ? `\nFails when: ${f.failureScenario}` : ''}` }],
    }));
    let all = [];
    try { all = await this.bb.discussion(this.pr.workspace, this.pr.repository, this.pr.id); } catch (e) { this.log(`Could not read comments: ${e.message}`); }
    const human = (m) => !BOT.test(`${m.email} ${m.slug} ${m.who}`) && !/Generated with \[Claude|CURATOR_SLACK_METADATA/i.test(m.text);
    const fromThreads = all.filter((t) => !t.resolved && t.messages.some(human)).map((t) => {
      const last = t.messages[t.messages.length - 1];
      return { ...t, source: 'thread', answered: this.isMine(last) && t.messages.some((m) => !this.isMine(m) && human(m)) };
    }).sort((a, b) => Number(a.answered) - Number(b.answered) || (a.path || '').localeCompare(b.path || '') || (a.line || 0) - (b.line || 0));
    this.threads = [...fromFindings, ...fromThreads];
    return this.threads;
  }

  protectedReason() {
    if (!SAFE_REF.test(this.src || '')) return 'unsupported branch name';
    if (this.src === this.dst || PROTECTED.test(this.src)) return `"${this.src}" looks like a shared branch; Sentinel only pushes to your own PR branch`;
    return null;
  }

  g(args, o = {}) { return git(this.dir, args, { token: this.token, ...o }); }

  /** A real checkout of the PR source branch. Never discards a commit that was made but not pushed. */
  async prepareTree() {
    const why = this.protectedReason(); if (why) throw new Error(why);
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(path.join(this.dir, '.git'))) await this.g(['init', '--quiet']);
    await this.g(['remote', 'remove', 'origin'], { okCodes: [2, 128] }).catch(() => {});
    await this.g(['remote', 'add', 'origin', repoUrl(this.cfg, this.pr.workspace, this.pr.repository)]);
    await this.g(['fetch', '--quiet', '--no-tags', '--depth=50', 'origin', `+refs/heads/${this.src}:refs/remotes/origin/${this.src}`], { timeout: 600000 });
    const remote = (await this.g(['rev-parse', `refs/remotes/origin/${this.src}`])).trim();
    const local = (await this.g(['rev-parse', '--verify', '-q', 'HEAD'], { okCodes: [1, 128] }).catch(() => '')).trim();
    const ahead = local ? +(await this.g(['rev-list', '--count', `${remote}..HEAD`]).catch(() => '0')).trim() : 0;
    if (ahead > 0) {         // a commit from an earlier session that was never pushed: keep it
      this.committed = { sha: (await this.g(['rev-parse', '--short=8', 'HEAD'])).trim(), mode: 'new', pending: true };
      this.base = remote; return { resumed: true, ahead };
    }
    await this.g(['checkout', '-q', '-f', '-B', this.src, remote]);
    await this.g(['clean', '-fdq']);
    this.base = remote; this.committed = null;
    return { resumed: false, ahead: 0 };
  }

  safePath(file) {
    const f = String(file || '').replace(/^[ab]\//, '');
    if (!f || f.startsWith('/') || f.split(/[\\/]/).includes('..') || f.split(/[\\/]/).includes('.git')) return null;
    const abs = path.join(this.dir, f);
    return abs.startsWith(this.dir + path.sep) && fs.existsSync(abs) && fs.statSync(abs).isFile() ? { f, abs } : null;
  }

  window(file, line) {
    const sp = this.safePath(file); if (!sp) return '';
    const lines = fs.readFileSync(sp.abs, 'utf8').split('\n');
    const a = lines.length <= 400 ? 0 : Math.max(0, (line || 1) - 130), b = lines.length <= 400 ? lines.length : Math.min(lines.length, (line || 1) + 130);
    return lines.slice(a, b).map((t, i) => `${String(a + i + 1).padStart(5)}  ${t}`).join('\n');
  }

  async lookup(n) {
    if (n.grep || n.pattern) {
      const out = await git(this.dir, ['grep', '-n', '-I', '-E', '-e', String(n.grep || n.pattern).slice(0, 200), '--', n.glob ? String(n.glob).replace(/^-+/, '') : '.'], { timeout: 30000, okCodes: [1] }).catch((e) => `grep failed: ${e.message}`);
      return String(out).split('\n').slice(0, 14).join('\n') || 'no matches';
    }
    const sp = this.safePath(n.file); if (!sp) return 'file not found';
    const start = Math.max(1, +n.start || 1), count = Math.min(120, +n.count || 60);
    return fs.readFileSync(sp.abs, 'utf8').split('\n').slice(start - 1, start - 1 + count).map((t, i) => `${start + i}: ${t}`).join('\n');
  }

  /** Apply one exact-text edit. Returns null on success, or the reason it could not be applied. */
  applyEdit(e) {
    const sp = this.safePath(e?.file); if (!sp) return `file "${e?.file}" not found in the checkout`;
    const find = String(e.find ?? ''), rep = String(e.replace ?? '');
    if (!find.trim()) return 'empty "find" text';
    let text = fs.readFileSync(sp.abs, 'utf8');
    const crlf = text.includes('\r\n'); if (crlf) text = text.replace(/\r\n/g, '\n');
    const count = text.split(find).length - 1;
    if (count !== 1) return count === 0 ? `the text to replace was not found in ${sp.f}` : `the text to replace matches ${count} places in ${sp.f}`;
    text = text.replace(find, () => rep);
    fs.writeFileSync(sp.abs, crlf ? text.replace(/\n/g, '\r\n') : text);
    return null;
  }

  /** Ask the model for a fix to one thread and apply it. Sequential, so each thread sees the edits before it. */
  async fixThread(t) {
    const thread = t.messages.map((m) => `${this.isMine(m) ? 'you (author)' : m.who}: ${m.text.slice(0, 700)}`).join('\n');
    const where = t.path ? `${t.path}${t.line ? `:${t.line}` : ''}` : 'a general comment (no file)';
    const what = t.source === 'finding' ? 'Review finding (found by an automated review of your PR; it may be wrong: check it against the code and use no_change if it does not hold)' : 'Comment';
    const code = t.path ? this.window(t.path, t.line) : '';
    const user = `PR: ${this.pr.title}\n${what} on ${where}\n\nThread:\n${thread}\n\n${code ? `The file now (line numbers on the left are not part of the file):\n${code}` : 'No file is attached to this comment. Use a lookup if you need code, or answer with no_change.'}`;
    const messages = [{ role: 'system', content: FIX_SYSTEM }, { role: 'user', content: user }];
    const opts = { model: this.cfg.llm.model, maxTokens: 12000, reasoning: 'low', label: `fix ${where}` };
    let r = await this.llm.json(messages, opts);
    const need = (Array.isArray(r?.need) ? r.need : []).filter((n) => n && (n.grep || n.pattern || n.file)).slice(0, 4);
    if (need.length) {
      const got = []; for (const n of need) got.push(`${n.grep || n.pattern ? `grep ${n.grep || n.pattern}` : `read ${n.file}`}\n${String(await this.lookup(n)).slice(0, 1800)}`);
      messages.push({ role: 'assistant', content: JSON.stringify({ need }) }, { role: 'user', content: `Lookup results:\n${got.join('\n\n')}\n\nNow answer with the final JSON. No more lookups.` });
      r = await this.llm.json(messages, { ...opts, label: opts.label + ' + lookups' });
    }
    const res = { thread: t.id, where, summary: String(r?.summary || '').trim(), reply: String(r?.reply || '').trim(), files: [], failed: [] };
    if (r?.action !== 'edit' || !Array.isArray(r.edits) || !r.edits.length) { res.status = 'no_change'; return res; }
    // all-or-nothing per thread: back up, apply, restore on any failure
    const backups = new Map();
    for (const e of r.edits) { const sp = this.safePath(e?.file); if (sp && !backups.has(sp.abs)) backups.set(sp.abs, fs.readFileSync(sp.abs)); }
    for (const e of r.edits) { const why = this.applyEdit(e); if (why) { res.failed.push(why); break; } else res.files.push(this.safePath(e.file).f); }
    if (res.failed.length) { for (const [abs, buf] of backups) fs.writeFileSync(abs, buf); res.files = []; res.status = 'failed'; return res; }
    res.files = [...new Set(res.files)]; res.status = 'applied';
    return res;
  }

  async proposeFor(threadIds, onEach) {
    for (const id of threadIds) {
      const t = this.threads.find((x) => x.id === id); if (!t) continue;
      onEach?.({ id, state: 'working' });
      try { const r = await this.fixThread(t); this.results.set(id, r); onEach?.({ id, state: r.status, result: r }); }
      catch (e) { const r = { thread: id, where: t.path || 'general', status: 'failed', failed: [e.message], files: [], summary: '', reply: '' }; this.results.set(id, r); onEach?.({ id, state: 'failed', result: r }); }
    }
  }

  async diff() { await this.g(['add', '-A', '-N']); return this.g(['diff', 'HEAD']); }
  async changedFiles() { return (await this.g(['diff', '--name-only', 'HEAD'])).split('\n').filter(Boolean); }

  defaultMessage() {
    const done = [...this.results.values()].filter((r) => r.status === 'applied' && r.summary);
    return `Address review comments\n\n${done.map((r) => `- ${r.summary.replace(/\s+/g, ' ')}`).join('\n')}`.trim();
  }

  async identity() {
    const get = async (k) => (await git(this.dir, ['config', k], { okCodes: [1] }).catch(() => '')).trim();
    const name = (await get('user.name')) || this.cfg.bitbucket.username || 'sentinel', email = (await get('user.email')) || '';
    return email ? [] : ['-c', `user.name=${name}`, '-c', `user.email=${String(this.cfg.bitbucket.username || 'sentinel')}@users.noreply.local`];
  }

  /** mode: 'new' (a new commit on top, safe) | 'amend' (rewrites your last commit; needs a force push). */
  async commit({ mode = 'new', message } = {}) {
    if (!(await this.changedFiles()).length) throw new Error('There are no changes to commit.');
    await this.g(['add', '-A']);
    const id = await this.identity();
    const before = (await this.g(['rev-parse', 'HEAD'])).trim();
    await this.g([...id, 'commit', '-q', ...(mode === 'amend' ? ['--amend', '--no-edit'] : ['-m', message || this.defaultMessage()])]);
    this.committed = { sha: (await this.g(['rev-parse', '--short=8', 'HEAD'])).trim(), mode, before, pending: true };
    return this.committed;
  }

  /** The exact git arguments for the push (kept separate so they can be checked without a remote). */
  pushArgs() {
    const why = this.protectedReason(); if (why) throw new Error(why);
    if (!this.committed) throw new Error('Nothing is committed yet.');
    const ref = `refs/heads/${this.src}`;
    const args = ['push', 'origin', `HEAD:${ref}`];
    // an amend rewrites history: force only if the remote branch is still exactly where we fetched it
    if (this.committed.mode === 'amend') args.splice(1, 0, `--force-with-lease=${ref}:${this.base}`);
    return args;
  }

  async push() {
    const out = await this.g(this.pushArgs(), { timeout: 300000 });
    this.committed.pending = false; this.base = (await this.g(['rev-parse', 'HEAD'])).trim();
    return out.trim();
  }

  async discard() {
    await this.g(['reset', '-q', '--hard', this.base || `refs/remotes/origin/${this.src}`]);
    await this.g(['clean', '-fdq']); this.committed = null; this.results.clear();
  }
}
