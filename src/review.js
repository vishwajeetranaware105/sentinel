import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { RUNS_DIR, CACHE_DIR } from './config.js';
import { CHECKS, profileFor } from './checks.js';
import { parseDiff, isNoise, isLowValue, riskScore, capFile, chunkFiles, renderFile, windowFor, locate, nearestAnchor } from './diff.js';
import { RepoView } from './repo.js';
import { LLM, estimateTokens } from './llm.js';

const PROMPT_VERSION = 'v3';
const STAGES = [
  ['fetch', 'Fetch PR & diff'],
  ['analyze', 'Analyze changes'],
  ['verify', 'Verify findings'],
  ['gate', 'Score & vet comments'],
  ['replies', 'Check replies'],
  ['summarize', 'Summarize'],
];

const COMMENT_STYLE = `Write "body" as the comment a careful reviewer would leave on that exact line, in plain prose, in two short paragraphs. First paragraph: what is wrong (or could be better) in this specific code, naming the function, variable or condition involved. Second paragraph: why it matters, with the concrete input, state or caller that triggers it and what then happens (crash, wrong result, breaks existing callers or older clients, harder to maintain), and how to fix it; add a short fenced code snippet only if it makes the fix clearer. Never begin with or include a label, heading or severity word such as "Bug:", "Blocker", "Suggestion", "Issue:" or "Major"; no markdown headings, no bullet or numbered lists, no emoji, no praise, no restating the diff.`;

/** Safety net: strip any label/heading the model (or an edit) put at the top of a comment. */
export function cleanComment(text) {
  let s = String(text ?? '').trim();
  for (let i = 0; i < 3; i++) {
    const before = s;
    s = s.replace(/^\s*\[\s*(?:blocker|bug|breaking(?:[ -]change)?|suggestion|issue|major|minor|critical|high|medium|low|nit|warning|security|risk|reply|response|follow-up|answer|comment)\s*\]\s*/i, '')
      .replace(/^\s*#{1,6}\s+[^\n]*\n+/, '')
      .replace(/^\s*(?:\*\*|__)?\s*(?:severity|type|category|kind)\s*:[^\n]*\n+/i, '')
      .replace(/^\s*(?:\*\*|__)?\s*\[?\s*(?:blocker|bug|breaking(?:[ -]change)?|suggestion|issue|major|minor|critical|high|medium|low|nit|warning|security|risk|reply|response|follow-up|answer|comment)\s*\]?\s*(?:\*\*|__)?\s*[:|–—-]\s*(?:\*\*|__)?\s*/i, '')
      .trim();
    if (s === before) break;
  }
  return s;
}

/** Review depth, modelled on Claude Code's effort levels. `min` is the 0-100 score a bug/breaking finding needs to be shown. */
export const EFFORT = {
  low:    { min: 85, minSuggestion: 75, maxVerify: 6,  maxKeep: 6,  passes: 1 },
  medium: { min: 80, minSuggestion: 65, maxVerify: 12, maxKeep: 15, passes: 1 },
  high:   { min: 70, minSuggestion: 60, maxVerify: 20, maxKeep: 25, passes: 2 },
};

// Adapted from Claude Code's code-review command: what must NOT be reported.
const FALSE_POSITIVES = `Do NOT report any of these (they are false positives):
- Pre-existing issues, or real issues on lines this PR did not add or change.
- Something that looks like a bug but is not actually a bug.
- Pedantic nitpicks a senior engineer would not call out.
- Anything a linter, type checker or compiler would catch (imports, type errors, formatting, style).
- General code-quality gripes (missing tests, docs, naming) unless the repo guidelines explicitly require them.
- Changes in behaviour that are clearly intentional and part of what the PR description says it does.
- Issues the code explicitly silences (lint-ignore comments).`;

const RUBRIC = `Score the issue 0-100 with this rubric:
0: not confident; a false positive that does not survive light scrutiny, or pre-existing.
25: somewhat confident; might be real but you could not verify it; or purely stylistic and not required by the guidelines.
50: moderately confident; verified as real but a nitpick or rare in practice.
75: highly confident; double-checked, very likely hit in practice, existing approach insufficient, directly affects functionality.
100: absolutely certain; confirmed, will happen frequently, the evidence directly proves it.`;

const ANALYZE_SYSTEM = `You are a meticulous senior reviewer reading a pull request diff. First understand what the PR is trying to do from its title, description and commits; judge the code against that intent. Report only real, specific problems you can point to in the added or changed code; never invent code. Focus on large bugs; fewer, higher-signal findings beat many weak ones.
${FALSE_POSITIVES}
Every finding must be on an added/changed line, cite its destination line number from the left gutter (prefer an added "+" line), and for kind bug or breaking MUST include "failure_scenario": the concrete input or state that triggers it and the wrong result ("when X is empty, parse() returns null and the caller dereferences it -> crash"). No concrete scenario means do not report it.
kind: bug (wrong behaviour / crash / security) | breaking (breaks existing callers, clients, data or contract) | suggestion (a real improvement that is worth the author's time).
severity: blocker | major | minor. confidence: 0..1, your honest probability it is correct.
If a claim depends on code outside the diff, still report it with lower confidence and put up to 2 grep patterns that would prove or refute it in "verify" (the tool runs them for you).
If repo guideline files are provided, flag a violation only when a guideline explicitly says so, and quote the rule in "failure_scenario".
${COMMENT_STYLE}
Reply ONLY with JSON: {"findings":[{"file":"","line":0,"snippet":"exact line text","kind":"","category":"check id","severity":"","title":"6-10 words","failure_scenario":"","body":"","confidence":0.0,"verify":[{"grep":"regex that proves or refutes it","glob":"*.ext"}]}]} - or {"findings":[]}.`;

// High effort adds an independent second reader with a different lens (Claude Code runs several independent reviewers).
const PASS_B_SYSTEM = `You are a second, independent reviewer. A first reviewer already looked for plain bugs; you look through a different lens:
(1) Does the change actually do what the PR description and commits say, completely? Flag missed call sites, half-applied renames, behaviour the description does not mention, and code that contradicts the stated intent.
(2) Does it violate an explicit rule in the repo guideline files provided, or contradict a comment in the surrounding code (TODO/NOTE/invariant comments visible in the diff)?
(3) Regressions: could this change break a flow that previously worked, given the references shown from outside the diff?
${FALSE_POSITIVES}
Same output contract as the first reviewer: every finding on an added/changed line with a destination line number, a concrete "failure_scenario" for bug/breaking, kind, severity, confidence.
${COMMENT_STYLE}
Reply ONLY with JSON: {"findings":[{"file":"","line":0,"snippet":"","kind":"","category":"","severity":"","title":"","failure_scenario":"","body":"","confidence":0.0,"verify":[{"grep":"","glob":""}]}]} - or {"findings":[]}.`;

// Independent scorer + appropriateness gate: nothing reaches the screen without passing this.
const GATE_SYSTEM = `You are the final gate before review comments are shown to a human. You did not write them. For each finding decide (a) a score and (b) whether the comment is appropriate to post on this PR.
${RUBRIC}
A finding is NOT appropriate if any of these hold:
- it is a false positive, pre-existing, or on code this PR did not change;
- it is a nitpick, a style or linter-level point, or general quality noise;
- the claim is not supported by the code and evidence shown, or its failure scenario cannot actually happen;
- it contradicts the PR's stated intent, or merely restates what the PR description says it does;
- it duplicates another finding in this batch or a comment already on the PR (set "duplicate_of");
- the wording is wrong for a code-review comment: a label or heading ("Bug:", "Suggestion", "Blocker"), a list, praise, emoji, vague hand-waving, speculation presented as fact, or an accusatory tone.
A finding that was never verified against the code cannot score above 50 if it is a bug or breaking claim.
If the finding is real but the comment text is weak, keep it and put a better "body" (same rules: plain prose, two short paragraphs, no labels).
Reply ONLY with JSON: {"results":[{"id":"","score":0,"appropriate":true,"reason":"one sentence","duplicate_of":null,"body":"optional rewrite"}]}`;

// Follow-ups: the reviewer commented earlier and somebody replied. Is the reply right?
const REPLY_SYSTEM = `You help a code reviewer follow up on review threads they took part in. Each thread shows the conversation (roles: you = the reviewer you are helping, author = the PR author, other, bot) and the code NOW at the PR head near the thread's line.
Decide for each thread:
- "addressed": the reply or the current code settles the point (fixed, or explained convincingly). No reply needed.
- "not_addressed": the reply is wrong, dodges the point, or the code still has the problem.
- "needs_answer": the reply asks the reviewer something or pushes back in a way that deserves an answer.
Only for not_addressed / needs_answer write "reply": what the reviewer would write back, in plain prose, one or two short paragraphs, specific to the code shown (name the function / condition and what happens), no label, no greeting, no thanks, no emoji, no markdown heading or list. If you cannot tell from the code shown, do not invent a problem: choose addressed unless a direct question was asked.
If "force" is true the reviewer explicitly asked for a reply: always write one (agree and acknowledge briefly if the author is right).
Reply ONLY with JSON: {"results":[{"id":"","verdict":"addressed|not_addressed|needs_answer","reason":"one sentence","reply":""}]}`;

const VERIFY_SYSTEM = `You verify code-review findings before the author sees them. You did not write them. Be skeptical: refute a finding if the code does not support it. Each finding comes with the diff near its line and search evidence already fetched from the real repository (the PR head branch).
For each finding reply with a final verdict, or - only if essential - up to 2 extra searches:
{"results":[{"id":"","verdict":"confirmed|downgrade|withdraw","severity":"blocker|major|minor","kind":"bug|breaking|suggestion","line":0,"reason":"one sentence: what you checked and found"},{"id":"","need":[{"op":"grep","pattern":"regex","glob":"*.kt","side":"head"},{"op":"read","file":"path","start":1,"count":40,"side":"head"}]}]}
Add "body" (a corrected comment) ONLY if the existing comment is inaccurate; otherwise omit it.
withdraw = wrong, already handled (earlier guard, caller validates, fixed elsewhere in this PR) or unprovable. A "breaking" claim needs an actual consumer in the evidence. Trace each failure_scenario through the code: if you cannot show it can happen, withdraw. The PR description states the intent, so behaviour it describes is not a bug. ${COMMENT_STYLE}`;

export const runs = new Map();
const sha = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 24);
const cacheGet = (k) => { try { return JSON.parse(fs.readFileSync(path.join(CACHE_DIR, `${k}.json`), 'utf8')); } catch { return null; } };
const cachePut = (k, v) => { try { fs.mkdirSync(CACHE_DIR, { recursive: true }); fs.writeFileSync(path.join(CACHE_DIR, `${k}.json`), JSON.stringify(v)); } catch {} };

export class Review extends EventEmitter {
  constructor({ cfg, bb, target, model, checks }) {
    super();
    this.cfg = cfg; this.bb = bb; this.llm = new LLM(cfg);
    this.effort = EFFORT[cfg.effort] || EFFORT.medium;
    this.id = crypto.randomBytes(5).toString('hex');
    this.data = {
      id: this.id, pr: { ...target }, model: model || cfg.llm.model, verifyModel: cfg.llm.fastModel || model || cfg.llm.model,
      checks, effort: EFFORT[cfg.effort] ? cfg.effort : 'medium', notices: [], status: 'preparing', stages: STAGES.map(([id, label]) => ({ id, label, state: 'pending' })),
      log: [], files: [], findings: [], summary: null, estimate: null, usage: null, createdAt: new Date().toISOString(),
    };
    this.abort = new AbortController();
    this.live = new Map();
    this.llm.onProgress = (p) => {
      if (p.done) this.live.delete(p.id); else this.live.set(p.id, p);
      this.data.live = [...this.live.values()];
      this.emitEvent('activity', {});
    };
    this.llm.onUsage = (u) => { this.data.usage = { ...u, total: this.llm.total, budget: this.llm.budget }; this.emitEvent('usage', { usage: this.data.usage }); };
    runs.set(this.id, this);
  }

  static rehydrate(id, ctx) {
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, `${id}.json`), 'utf8')); } catch { return null; }
    const r = new Review({ ...ctx, target: data.pr, model: data.model, checks: data.checks });
    runs.delete(r.id); r.id = data.id; r.data = data; r.files = []; runs.set(r.id, r);
    return r;
  }

  emitEvent(type, payload) { this.emit('event', { type, ...payload }); }
  log(msg) { const e = { t: new Date().toISOString(), msg }; this.data.log.push(e); this.emitEvent('log', e); }
  stage(id, state, detail) {
    const s = this.data.stages.find((x) => x.id === id);
    s.state = state; if (detail !== undefined) s.detail = detail; this.emitEvent('stage', { stage: s });
  }
  setStatus(status, extra = {}) { Object.assign(this.data, { status }, extra); this.emitEvent('status', { status, ...extra }); }
  persist() { try { fs.mkdirSync(RUNS_DIR, { recursive: true }); fs.writeFileSync(path.join(RUNS_DIR, `${this.id}.json`), JSON.stringify(this.data)); } catch {} }
  push(f) { this.data.findings.push(f); this.emitEvent('finding', { finding: f }); }
  cancel() { this.abort.abort(); this.setStatus('cancelled'); }

  // ---- phase 1: free (Bitbucket reads only, zero model tokens) ------------------------------
  async prepare() {
    const d = this.data, { workspace: ws, repository: repo, id: prId } = d.pr;
    try {
      this.stage('fetch', 'active');
      const [pr, diffText, commits] = await Promise.all([
        this.bb.getPr(ws, repo, prId), this.bb.getDiff(ws, repo, prId), this.bb.listCommits(ws, repo, prId).catch(() => null),
      ]);
      Object.assign(d.pr, { title: pr.title, description: String(pr.description || '').slice(0, 6000), author: pr.author, src: pr.source_branch, dst: pr.destination_branch,
        url: pr.web_url, version: pr.version, headCommit: pr.source_commit, state: pr.state, authorEmail: String(pr.author_username || '').toLowerCase() });
      this.eligibility(pr);
      this.commitMsgs = (commits?.commits || commits?.values || []).map((c) => (c.message || '').split('\n')[0]).filter(Boolean).slice(0, 15);
      const threads = await this.bb.discussion(ws, repo, prId).catch((e) => { this.log(`Could not read the existing comments (${e.message}); reviewing without them`); return null; });
      this.setupDiscussion(threads);
      this.files = parseDiff(typeof diffText === 'string' ? diffText : diffText?.diff || '');
      if (!this.files.length) throw new Error('Could not parse any files from the PR diff');

      const skipReason = (f) => (f.binary ? 'binary' : isNoise(f.path) ? 'generated' : isLowValue(f.path) ? 'docs/strings' : null);
      d.files = this.files.map((f) => ({ path: f.path, status: f.status, added: f.added, removed: f.removed, skip: skipReason(f) }));
      let reviewable = this.files.filter((f) => !skipReason(f));
      if (!reviewable.length) reviewable = this.files.filter((f) => !f.binary && !isNoise(f.path)); // only docs changed: review them after all
      reviewable = reviewable.map(capFile).sort((a, b) => riskScore(b) - riskScore(a) || a.path.localeCompare(b.path));
      this.reviewable = reviewable;
      this.noteTrivial();
      this.active = CHECKS.filter((c) => d.checks.includes(c.id));
      this.profile = profileFor(repo);
      this.chunks = chunkFiles(reviewable, this.cfg.chunkChars || 150000);

      // Start the local repo copy now, in the background, so it is ready by the time the user confirms.
      this.view = new RepoView({ cfg: this.cfg, bb: this.bb, ws, repo, head: d.pr.src, base: d.pr.dst, log: (m) => this.log(m),
        onState: (st) => { d.repo = st; this.emitEvent('repo', { repo: st }); } });
      this.guideP = this.view.prepare().then(async (ok) => {          // repo guideline files (the CLAUDE.md step), as soon as the copy exists
        this.guide = ok ? await this.view.guidelines(this.files) : [];
        d.guidelines = this.guide.map((g) => g.path);
        if (this.guide.length) this.log(`Guidelines found: ${d.guidelines.join(', ')}`);
        this.emitEvent('update', {});
      }).catch(() => { this.guide = []; });

      this.computeEstimate();
      this.stage('fetch', 'done', `${reviewable.length}/${this.files.length} files`);
      this.setStatus('ready');
      return d.estimate;
    } catch (e) {
      this.log(`Failed: ${e.message}`); this.setStatus('error', { error: e.message }); this.persist();
      throw e;
    }
  }

  // ---- existing discussion on the PR: other reviewers, you, and the PR author's replies -----------------
  roleOf(m) {
    if (/(\.bot\b|bot@|\bbot\b|curator|euler|xyne|jenkins|sonar|dependabot|github-actions)/i.test(`${m.email} ${m.slug} ${m.who}`)
      || /^\s*🤖|CURATOR_SLACK_METADATA|Review WITH RESEARCH AGENT|Generated with \[Claude/i.test(m.text || '')) return 'bot';
    const me = String(this.cfg.bitbucket.username || '').toLowerCase();
    if (me && (m.email === me || String(m.slug).toLowerCase() === me)) return 'me';
    const a = this.data.pr;
    if ((a.authorEmail && m.email === a.authorEmail) || (a.author && m.who === a.author)) return 'author';
    return 'other';
  }
  setupDiscussion(threads) {
    const d = this.data;
    this.threads = (threads || []).map((t) => {
      const messages = t.messages.map((m) => ({ ...m, role: this.roleOf(m), text: m.text.slice(0, 900) }));
      const last = messages[messages.length - 1];
      const mine = messages.some((m) => m.role === 'me');
      return { ...t, messages, open: !t.resolved, last, mine, needsReply: mine && !t.resolved && !!last && last.role !== 'me' && last.role !== 'bot' };
    });
    const human = this.threads.filter((t) => t.messages.some((m) => m.role !== 'bot'));
    d.discussion = {
      total: human.length, open: human.filter((t) => t.open).length, withReplies: human.filter((t) => t.messages.length > 1).length,
      needReply: this.threads.filter((t) => t.needsReply).length,
      threads: human.sort((a, b) => Number(b.open) - Number(a.open) || b.last.at - a.last.at).slice(0, 150)
        .map((t) => ({ ...t, messages: t.messages.map((m) => ({ id: m.id, who: m.who, role: m.role, text: m.text, at: m.at, severity: m.severity, state: m.state })) })),
    };
    // compact digest for the model: what was said, what the author answered, what is already settled
    const q = (m) => `"${m.text.replace(/\s+/g, ' ').slice(0, 110)}"`;
    // bots' general chatter is noise, but their inline findings are worth not repeating
    const useful = this.threads.filter((t) => t.messages.some((m) => m.role !== 'bot') || t.path).sort((a, b) => Number(b.open) - Number(a.open) || b.last.at - a.last.at);
    this.others = useful.slice(0, 25).map((t) => {
      const [first, ...rest] = t.messages;
      const who = (m) => (m.role === 'me' ? 'you' : m.role === 'author' ? 'author' : m.role === 'bot' ? 'bot' : m.who);
      return `- ${t.path ? `${t.path}:${t.line || ''}` : 'general'}${t.resolved ? ' (resolved)' : ''} ${who(first)}: ${q(first)}${rest.slice(0, 2).map((m) => ` -> ${who(m)}: ${q(m)}`).join('')}`.slice(0, 330);
    });
  }
  replyCandidates() { return (this.threads || []).filter((t) => t.needsReply).sort((a, b) => b.last.at - a.last.at).slice(0, 12); }

  /** Cheap-model check of whether replies on the reviewer's own threads hold up; drafts a reply when they do not. */
  async assessReplies(threads, { force = false } = {}) {
    const d = this.data, out = [];
    for (let i = 0; i < threads.length; i += 4) {
      const batch = threads.slice(i, i + 4);
      const items = [];
      for (const t of batch) {
        let code = '';
        if (t.path && t.line) code = String(await this.view.read({ file: t.path, start: Math.max(1, t.line - 8), count: 18, side: t.lineType === 'REMOVED' ? 'base' : 'head' }).catch(() => '')).slice(0, 1600);
        t.codeNow = code;
        items.push({ id: String(t.id), file: t.path, line: t.line, resolved: t.resolved, task: t.task, code_now_at_pr_head: code,
          thread: t.messages.map((m) => ({ role: m.role, who: m.who, text: m.text.slice(0, 600) })) });
      }
      const key = sha([PROMPT_VERSION, 'reply', d.verifyModel, force, JSON.stringify(items)].join('|'));
      let results = cacheGet(key);
      if (!results) {
        const r = await this.llm.json([{ role: 'system', content: REPLY_SYSTEM }, { role: 'user', content: `PR: ${d.pr.title}\nDescription: ${(d.pr.description || '(none)').replace(/\s+/g, ' ').slice(0, 600)}\nforce: ${force}\nThreads:\n${JSON.stringify(items)}` }],
          { model: d.verifyModel, maxTokens: 1500 + batch.length * 500, reasoning: 'low', signal: this.abort.signal, label: force ? 'draft reply' : `check replies ${i / 4 + 1}` });
        results = Array.isArray(r) ? r : r.results || [];
        cachePut(key, results);
      }
      const byId = new Map(results.map((x) => [String(x.id), x]));
      for (const t of batch) {
        const r = byId.get(String(t.id));
        if (!r) continue;
        if (!force && r.verdict === 'addressed') { t.assessment = { verdict: 'addressed', reason: r.reason || '' }; continue; }
        if (!r.reply || String(r.reply).trim().length < 15) continue;
        out.push(this.replyFinding(t, r));
      }
    }
    return out;
  }
  replyFinding(t, r) {
    const last = t.messages[t.messages.length - 1];
    return {
      id: crypto.randomBytes(4).toString('hex'), kind: 'reply', file: t.path, line: t.line, lineType: t.lineType, excerpt: [], focus: 0,
      category: 'reply', severity: 'minor', title: `Reply to ${last.who}`, body: cleanComment(r.reply), failureScenario: '', confidence: 0.7, score: null,
      gate: { appropriate: true, reason: r.reason || '' }, status: 'pending', asTask: false, thread: t.id,
      reply: { parentId: t.id, to: last.who, verdict: r.verdict, conversation: t.messages.slice(-4).map((m) => ({ who: m.who, role: m.role, text: m.text.slice(0, 500) })) },
      verification: { verdict: 'confirmed', reason: r.reason || '', evidence: t.codeNow ? [{ op: 'read', query: `${t.path}:${Math.max(1, (t.line || 1) - 8)} (code now at PR head)`, result: t.codeNow }] : [] },
    };
  }
  /** On demand (key `r` on a thread): draft a reply to any thread, even ones the reviewer was not part of. */
  async draftReply(threadId) {
    const t = (this.threads || []).find((x) => x.id === threadId);
    if (!t || !this.view) throw new Error('This thread is not available (reopen the review from the PR list).');
    const existing = this.data.findings.find((f) => f.kind === 'reply' && f.thread === threadId && f.status !== 'posted');
    if (existing) return existing;
    this.llm.resetUsage(this.cfg.tokenBudget); this.llm.budget = 0;
    const [f] = await this.assessReplies([t], { force: true });
    if (!f) throw new Error('The model did not produce a reply.');
    this.push(f); this.persist();
    return f;
  }

  /** Claude Code's step 1: skip closed / draft / trivial / already-reviewed PRs. We warn instead of silently refusing. */
  eligibility(pr) {
    const d = this.data, n = d.notices = [];
    if (pr.state && pr.state !== 'OPEN') { n.push({ level: 'bad', text: `This PR is ${pr.state}; there is nothing to review.` }); d.blocked = true; }
    if (pr.draft || /^\s*\[?(wip|draft)\b/i.test(pr.title || '')) n.push({ level: 'warn', text: 'This PR looks like a draft / work in progress.' });
    try {
      for (const f of fs.readdirSync(RUNS_DIR)) {
        const o = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), 'utf8'));
        if (o.id === this.id || o.pr?.workspace !== d.pr.workspace || o.pr?.repository !== d.pr.repository || o.pr?.id !== d.pr.id) continue;
        const posted = (o.findings || []).filter((x) => x.status === 'posted').length;
        if (posted && o.pr.headCommit && o.pr.headCommit === d.pr.headCommit) { n.push({ level: 'warn', text: `You already posted ${posted} comment${posted === 1 ? '' : 's'} on this exact commit (${String(o.createdAt).slice(0, 10)}).` }); break; }
      }
    } catch {}
  }
  noteTrivial() {
    const lines = this.files.reduce((n, f) => n + f.added + f.removed, 0);
    if (lines <= 6) this.data.notices.push({ level: 'info', text: `Very small change (${lines} lines); a review may not be needed.` });
  }

  setEffort(name) {
    if (!EFFORT[name] || this.data.status === 'running') return;
    this.data.effort = name; this.effort = EFFORT[name];
    if (this.chunks) this.computeEstimate();
    this.emitEvent('update', {});
  }

  /** Token estimate for the current models; cheap to recompute (no network, no tokens). */
  computeEstimate() {
    const d = this.data;
    const header = this.header().length;
    let cached = 0, tokens = 0;
    for (const ch of this.chunks) {
      if (cacheGet(this.chunkKey(ch))) { cached++; continue; }
      tokens += (estimateTokens(ch.map(renderFile).join('\n\n')) + estimateTokens(ANALYZE_SYSTEM) + header / 3.6 + 700) * this.effort.passes;
    }
    const verifyCalls = Math.min(this.effort.maxVerify, Math.max(2, this.chunks.length * 2));
    const gateCalls = Math.ceil(Math.min(this.effort.maxKeep, verifyCalls + 2) / 8);
    const verifyTokens = cached === this.chunks.length ? 0 : Math.ceil(verifyCalls / 4) * 4200 + gateCalls * 3000;
    d.estimate = {
      files: this.files.length, reviewable: this.reviewable.length, skipped: this.files.length - this.reviewable.length,
      truncated: this.reviewable.filter((f) => f.truncated).length,
      chunks: this.chunks.length, cachedChunks: cached,
      effort: this.data.effort, passes: this.effort.passes, replyTokens: Math.ceil(Math.min(this.replyCandidates().length, 12) / 4) * 3500, analyzeTokens: Math.round(tokens), verifyTokens, totalTokens: Math.round(tokens + verifyTokens + Math.ceil(Math.min(this.replyCandidates().length, 12) / 4) * 3500), budget: this.cfg.tokenBudget,
    };
    return d.estimate;
  }

  /** Switch models before the run starts (e.g. from the estimate screen); cache hits depend on the model. */
  setModels({ model, fastModel }) {
    if (this.data.status === 'running') return;
    if (model) this.data.model = model;
    if (fastModel) this.data.verifyModel = fastModel;
    if (this.chunks) this.computeEstimate();
    this.emitEvent('update', {});
  }

  header() {
    const d = this.data;
    return [
      `PR: ${d.pr.title} (${d.pr.workspace}/${d.pr.repository}, ${d.pr.src} -> ${d.pr.dst})`,
      d.pr.description ? `Description: ${d.pr.description.replace(/\s+/g, ' ').slice(0, 1500)}` : 'Description: (the author left it empty; infer the intent from the title and commits, and be extra careful not to flag deliberate behaviour)',
      this.commitMsgs.length ? `Commits: ${this.commitMsgs.join(' | ').slice(0, 500)}` : '',
      `Files: ${this.files.map((f) => f.path).slice(0, 40).join(', ')}${this.files.length > 40 ? ` (+${this.files.length - 40} more)` : ''}`,
      this.others.length ? `Existing discussion on the PR (do not repeat points already raised or resolved; the author's replies explain intent):\n${this.others.join('\n')}` : '',
      `Checks:\n${this.active.map((c) => `- ${c.id}: ${c.prompt}`).join('\n')}`,
      this.profile ? `Repo requirements:\n${this.profile.prompt}` : '',
    ].filter(Boolean).join('\n');
  }
  guideText() { return (this.guide || []).map((g) => `### ${g.path}\n${g.text}`).join('\n\n'); }
  chunkKey(chunk) {
    return sha([PROMPT_VERSION, this.data.model, this.data.checks.slice().sort().join(), this.profile?.id, this.effort.passes, sha(this.guideText()), chunk.map(renderFile).join('\n')].join('|'));
  }

  // ---- phase 2: spends tokens, only after the user confirms the estimate ------------------------
  async execute() {
    const d = this.data;
    this.llm.resetUsage(this.cfg.tokenBudget);
    this.setStatus('running');
    try {
      await this.view.prepare();            // normally finished while the user read the estimate
      await this.guideP;
      this.stage('analyze', 'active', `0/${this.chunks.length * this.effort.passes}`);
      let done = 0; const raw = [];
      const jobs = [];
      for (let pass = 0; pass < this.effort.passes; pass++) this.chunks.forEach((chunk, i) => jobs.push({ chunk, i, pass }));
      await pool(jobs, 3, async ({ chunk, i, pass }) => {
        if (this.abort.signal.aborted) return;
        if (this.llm.overBudget()) { d.budgetHit = true; return; }
        try { raw.push(...await this.analyzeChunk(chunk, i, pass)); }
        catch (e) { if (e.budget) d.budgetHit = true; else this.log(`Chunk ${i + 1} (pass ${pass + 1}) failed: ${e.message}`); }
        this.stage('analyze', 'active', `${++done}/${jobs.length}`);
      });
      if (d.budgetHit) this.log(`Token budget (${fmt(this.cfg.tokenBudget)}) reached - lower-risk files were not analyzed`);

      // Mechanical filters first (cost nothing): concrete failure scenario, and only on lines this PR changed.
      const candidates = [];
      for (const c of this.dedupe(raw)) {
        const kind = normKind(c.kind);
        const why = kind !== 'suggestion' && String(c.failure_scenario || '').trim().length < 12 ? 'No concrete failure scenario was given.'
          : this.onChangedLine(c) ? null : 'On a line this PR did not change (pre-existing).';
        if (why) this.push(this.withdrawn(c, why)); else candidates.push(c);
      }
      this.log(`${candidates.length} candidate${candidates.length === 1 ? '' : 's'} after mechanical filters; ${d.findings.length} dropped for free`);
      this.stage('analyze', 'done', `${candidates.length} candidates`);

      // Verification is the second-biggest cost: spend it only where it matters.
      const rank = (c) => ({ blocker: 3, major: 2, minor: 1 }[c.severity] ?? 1) * (+c.confidence || 0.5);
      candidates.sort((a, b) => rank(b) - rank(a));
      const toVerify = candidates.filter((c) => normKind(c.kind) !== 'suggestion').slice(0, this.effort.maxVerify);
      const rest = candidates.filter((c) => !toVerify.includes(c));
      const keepRest = rest.filter((c) => (+c.confidence || 0) >= 0.6).slice(0, this.effort.maxKeep);
      const cut = rest.length - keepRest.length;
      if (cut) this.log(`Dropped ${cut} low-confidence candidates without spending tokens`);

      this.stage('verify', 'active', `0/${toVerify.length}`);
      if (toVerify.length) await this.view.prepare();
      const survivors = [];
      let vdone = 0;
      const batches = [];
      for (let i = 0; i < toVerify.length; i += 4) batches.push(toVerify.slice(i, i + 4));
      await pool(batches, 2, async (batch) => {
        if (this.abort.signal.aborted) return;
        survivors.push(...await this.verifyBatch(batch));
        vdone += batch.length;
        this.stage('verify', 'active', `${vdone}/${toVerify.length}`);
      });
      for (const c of keepRest) survivors.push(this.baseFinding(c, c.kind === 'suggestion' ? 'Suggestion: not checked against the repo (saves tokens)' : 'Not verified (verification limit reached)'));
      this.stage('verify', 'done', `${survivors.filter((f) => f.verification.verdict !== 'withdrawn').length} survive`);

      // Independent score + appropriateness gate. Only what passes is ever shown.
      this.stage('gate', 'active');
      await this.gate(survivors);
      for (const f of survivors) this.push(f);
      const shown = d.findings.filter((f) => f.verification.verdict !== 'withdrawn');
      this.log(`Shown: ${shown.length}. Withdrawn before display: ${d.findings.length - shown.length}.`);
      this.stage('gate', 'done', `${shown.length} shown`);

      this.stage('replies', 'active');
      const rc = this.replyCandidates();
      if (rc.length) {
        try { for (const rf of await this.assessReplies(rc)) this.push(rf); }
        catch (e) { this.log(`Reply check failed: ${e.budget ? 'token budget reached' : e.message}`); }
      }
      this.stage('replies', 'done', rc.length ? `${d.findings.filter((f) => f.kind === 'reply').length} to post` : 'none needed');

      this.stage('summarize', 'active');
      d.summary = await this.summarize();
      this.stage('summarize', 'done');
      if (this.abort.signal.aborted) return;
      d.live = [];
      this.log(`Done. ${fmt(this.llm.total)} tokens, ${this.llm.usage.calls} model calls. Nothing has been posted.`);
      this.setStatus('review');
    } catch (e) {
      this.log(`Failed: ${e.message}`); this.setStatus('error', { error: e.message });
    } finally { this.persist(); }
  }

  async analyzeChunk(chunk, i, pass = 0) {
    const key = this.chunkKey(chunk) + (pass ? `:p${pass}` : '');
    const hit = cacheGet(key);
    const tag = `Chunk ${i + 1}/${this.chunks.length}${this.effort.passes > 1 ? ` pass ${pass + 1}` : ''}`;
    if (hit) { this.log(`${tag}: cached (0 tokens)`); return hit; }
    const callers = await this.view.callerContext(chunk).catch(() => '');
    const guide = this.guideText();
    const user = `${this.header()}\n${guide ? `\nREPO GUIDELINE FILES:\n${guide}\n` : ''}\nGutter numbers are destination-file line numbers.\n\n${chunk.map(renderFile).join('\n\n')}${callers ? `\n\nCODE OUTSIDE THE DIFF (real references found by search on the PR branch AND on the latest target branch; a reference marked ONLY on latest <branch> will break when this PR merges; use these to judge breaking changes):\n${callers}` : ''}`;
    const res = await this.llm.json([{ role: 'system', content: pass ? PASS_B_SYSTEM : ANALYZE_SYSTEM }, { role: 'user', content: user }],
      { model: this.data.model, maxTokens: 8000, reasoning: this.data.effort, signal: this.abort.signal, label: `analysis ${i + 1}/${this.chunks.length}${pass ? ' (2nd reader)' : ''}` });
    const list = (Array.isArray(res) ? res : res.findings || []).filter((f) => f && f.body && f.file);
    cachePut(key, list);
    this.log(`${tag}: ${chunk.length} file${chunk.length === 1 ? '' : 's'} -> ${list.length}`);
    return list;
  }

  /** True if the finding's line is (or snaps to within 3 lines of) a line this PR added; breaking changes may sit on context. */
  onChangedLine(c) {
    const file = this.files.find((f) => f.path === c.file) || this.files.find((f) => f.path.endsWith(c.file) || String(c.file).endsWith(f.path));
    if (!file) return false;
    const line = +c.line || 0;
    const added = file.hunks.flatMap((h) => h.lines).filter((l) => l.type === 'ADDED');
    if (added.some((l) => l.new === line)) return true;
    if (c.snippet && c.snippet.trim().length > 6 && added.some((l) => l.text.trim() === c.snippet.trim())) return true;
    if (added.some((l) => Math.abs(l.new - line) <= 3)) return true;
    return normKind(c.kind) === 'breaking' && !!locate(this.files, file.path, line)?.lineType;
  }

  /** A finding shown only in the Withdrawn tab, with the reason it was dropped. */
  withdrawn(c, reason) {
    const f = this.baseFinding(c);
    f.verification = { verdict: 'withdrawn', reason, evidence: [] }; f.status = 'rejected'; f.score = 0;
    return f;
  }

  /**
   * Independent scorer + appropriateness gate (Claude Code's "score each issue, filter below the threshold"),
   * run in batches by the cheap model. Mutates findings: score, gate verdict, possibly a better body.
   */
  async gate(findings) {
    const d = this.data, live = findings.filter((f) => f.verification.verdict !== 'withdrawn');
    const existing = this.others.join('\n');
    for (let i = 0; i < live.length; i += 8) {
      const batch = live.slice(i, i + 8);
      const items = batch.map((f) => ({
        id: f.id, file: f.file, line: f.line, kind: f.kind, severity: f.severity, title: f.title,
        failure_scenario: f.failureScenario, comment: f.body,
        checked_against_repo: f.verification.verdict !== 'unverified', verifier_note: f.verification.reason,
        code_near_line: windowFor(this.files.find((x) => x.path === f.file), f.line || 0, 8, 1200),
      }));
      const user = `PR: ${d.pr.title}\nDescription (the stated intent): ${(d.pr.description || '(none)').replace(/\s+/g, ' ').slice(0, 1200)}\n${existing ? `Comments already on the PR:\n${existing}\n` : ''}\nFindings:\n${JSON.stringify(items)}`;
      let results = [];
      try {
        const r = await this.llm.json([{ role: 'system', content: GATE_SYSTEM }, { role: 'user', content: user }],
          { model: d.verifyModel, maxTokens: 2500, reasoning: 'low', signal: this.abort.signal, label: `vet comments ${i / 8 + 1}` });
        results = Array.isArray(r) ? r : r.results || [];
      } catch (e) {
        this.log(`Vetting step failed (${e.budget ? 'token budget' : e.message}); those findings are shown unvetted`);
        for (const f of batch) { f.score = null; f.gate = { appropriate: null, reason: 'Not vetted (the vetting step could not run).' }; }
        continue;
      }
      const byId = new Map(results.map((x) => [x.id, x]));
      for (const f of batch) {
        const g = byId.get(f.id);
        if (!g) { f.score = null; f.gate = { appropriate: null, reason: 'Not vetted (no verdict returned).' }; continue; }
        f.score = Math.max(0, Math.min(100, Math.round(+g.score || 0)));
        f.gate = { appropriate: g.appropriate !== false && !g.duplicate_of, reason: g.reason || '' };
        const need = f.kind === 'suggestion' ? this.effort.minSuggestion : this.effort.min;
        if (g.duplicate_of) this.reject(f, `Duplicate of another finding. ${g.reason || ''}`);
        else if (g.appropriate === false) this.reject(f, `Not appropriate to post: ${g.reason || 'failed the vetting step'}`);
        else if (f.score < need) this.reject(f, `Scored ${f.score}/100, below the ${need} needed at ${d.effort} effort. ${g.reason || ''}`);
        else if (g.body && String(g.body).trim().length > 40) f.body = cleanComment(g.body);
      }
    }
    // Cap what is shown, best first (the effort level decides how much the reviewer is willing to read).
    const kept = findings.filter((f) => f.verification.verdict !== 'withdrawn').sort((a, b) => (b.score ?? 50) - (a.score ?? 50));
    for (const f of kept.slice(this.effort.maxKeep)) this.reject(f, `Below the cut: only the top ${this.effort.maxKeep} findings are shown at ${d.effort} effort.`);
  }
  reject(f, reason) { f.verification = { ...f.verification, verdict: 'withdrawn', reason }; f.status = 'rejected'; }

  dedupe(list) {
    const seen = new Set(), out = [];
    for (const f of list) {
      const key = `${f.file}:${f.line}:${(f.title || f.body).toLowerCase().slice(0, 40)}`;
      if (!seen.has(key)) { seen.add(key); out.push(f); }
    }
    return out.slice(0, 40);
  }

  baseFinding(c, note = '') {
    const a = this.anchor(c);
    const f = {
      id: crypto.randomBytes(4).toString('hex'), file: a.file, line: a.line, lineType: a.lineType, excerpt: a.excerpt, focus: a.focus,
      kind: normKind(c.kind), category: c.category || 'general', severity: normSev(c.severity), title: c.title || 'Finding',
      body: cleanComment(c.body), failureScenario: String(c.failure_scenario || '').trim(), confidence: +c.confidence || 0.5, score: null, gate: null, status: 'pending',
      verification: { verdict: 'unverified', reason: note, evidence: [] },
    };
    f.asTask = defaultTask(f);
    return f;
  }

  /** Search evidence fetched in code (free) so the verifier can usually answer in a single call. */
  async evidenceFor(c) {
    const out = [];
    const hints = (Array.isArray(c.verify) ? c.verify : []).filter((h) => h && typeof h === 'object' && h.grep).slice(0, 2);
    for (const h of hints) out.push({ op: 'grep', query: String(h.grep).slice(0, 200), result: (await this.view.grep({ pattern: String(h.grep).slice(0, 200), glob: h.glob || undefined, max: 8 })).slice(0, 800) });
    if (normKind(c.kind) === 'breaking') {
      const g = String((hints[0]?.grep) || (String(c.snippet || '').match(/[A-Za-z_]\w{5,}/g) || [])[0] || '');
      if (g) out.push({ op: 'grep', query: `${g}  [latest ${this.data.pr.dst}]`, result: (await this.view.grep({ pattern: g, side: 'base', word: !/[^\w]/.test(g), max: 8, excludeFile: String(c.file) })).slice(0, 800) });
    }
    if (!out.length) {
      const id = (String(c.snippet || '').match(/[A-Za-z_]\w{5,}/g) || []).find((w) => !/^(return|String|Boolean|Object|const|function|import|export)$/.test(w));
      if (id) out.push({ op: 'grep', query: id, result: (await this.view.grep({ pattern: id, word: true, max: 6, excludeFile: String(c.file) })).slice(0, 700) });
    }
    return out;
  }

  /** Verify up to 4 findings in one model call (cache first, evidence pre-fetched, one optional follow-up round). */
  async verifyBatch(cands) {
    const d = this.data, done = [], todo = [];
    for (const c of cands) {
      const f = this.baseFinding(c);
      const key = sha([PROMPT_VERSION, d.verifyModel, f.file, f.line, f.body, sha(windowFor(this.files.find((x) => x.path === f.file), f.line || 0))].join('|'));
      const hit = cacheGet(key);
      if (hit) { f.verification = hit.verification; done.push(this.applyVerdict(f, hit.verdict)); } else todo.push({ c, f, key });
    }
    if (!todo.length) return done;
    for (const t of todo) t.f.verification.evidence = await this.evidenceFor(t.c);
    const view = (t) => ({
      id: t.f.id, file: t.f.file, line: t.f.line, kind: t.f.kind, severity: t.f.severity, title: t.f.title, failure_scenario: t.f.failureScenario, comment: t.f.body,
      diff: windowFor(this.files.find((x) => x.path === t.f.file), t.f.line || 0, 14, 2000), evidence: t.f.verification.evidence.map((e) => `${e.op} ${e.query}\n${e.result}`),
    });
    const ask = async (items, label) => {
      const user = `PR: ${d.pr.title}\nPR description (the intent): ${(d.pr.description || '(none)').replace(/\s+/g, ' ').slice(0, 800)}\nSearch: ${this.view.local ? 'git grep on the real branches' : 'Bitbucket search only'}\nFindings:\n${JSON.stringify(items.map(view))}`;
      const r = await this.llm.json([{ role: 'system', content: VERIFY_SYSTEM }, { role: 'user', content: user }],
        { model: d.verifyModel, maxTokens: Math.min(4000, 600 + items.length * 500), reasoning: 'low', signal: this.abort.signal, label });
      return new Map((Array.isArray(r) ? r : r.results || []).map((x) => [x.id, x]));
    };
    let byId = new Map();
    try {
      byId = await ask(todo, `verify ${todo.length} finding${todo.length === 1 ? '' : 's'}`);
      const more = todo.filter((t) => { const r = byId.get(t.f.id); return r && !r.verdict && Array.isArray(r.need) && r.need.length; });
      if (more.length) {
        for (const t of more) for (const n of byId.get(t.f.id).need.slice(0, 2)) {
          const out = n.op === 'read' ? await this.view.read({ ...n, count: Math.min(+n.count || 40, 80) }) : await this.view.grep({ ...n, max: 10 });
          t.f.verification.evidence.push({ op: n.op, query: n.op === 'read' ? `${n.file}:${n.start || 1}` : n.pattern, result: out.slice(0, 900) });
        }
        const second = await ask(more, `verify ${more.length} more`);
        for (const [k, v] of second) byId.set(k, v);
      }
    } catch (e) {
      const why = e.budget ? 'Token budget reached before verification - check manually.' : `Verification error: ${e.message}`;
      for (const t of todo) t.f.verification.reason = why;
    }
    for (const t of todo) {
      const r = byId.get(t.f.id);
      if (r?.verdict) { cachePut(t.key, { verification: t.f.verification, verdict: r }); done.push(this.applyVerdict(t.f, r)); }
      else { t.f.verification.reason ||= 'Verifier gave no verdict - check manually.'; done.push(t.f); }
    }
    return done;
  }

  applyVerdict(f, r) {
    const v = String(r.verdict).toLowerCase();
    f.verification.reason = r.reason || '';
    if (v.startsWith('withdraw')) { f.verification.verdict = 'withdrawn'; f.status = 'rejected'; }
    else {
      f.verification.verdict = v.startsWith('down') ? 'downgraded' : 'confirmed';
      if (r.severity) f.severity = normSev(r.severity);
      if (r.kind) f.kind = normKind(r.kind);
      if (r.body && r.body.trim().length > 10) f.body = cleanComment(r.body);
      if (r.line && +r.line !== f.line) {
        const a = this.anchor({ file: f.file, line: +r.line });
        if (a.lineType) Object.assign(f, { line: a.line, lineType: a.lineType, excerpt: a.excerpt, focus: a.focus });
      }
    }
    f.asTask = defaultTask(f);
    return f;
  }

  anchor(c) {
    const line = +c.line || 0;
    const file = this.files.find((f) => f.path === c.file)?.path
      || this.files.find((f) => f.path.endsWith(c.file) || String(c.file).endsWith(f.path))?.path || c.file;
    const exact = locate(this.files, file, line);
    if (exact?.lineType) return { file: exact.path, line, lineType: exact.lineType, excerpt: exact.excerpt, focus: exact.focus };
    const near = nearestAnchor(this.files, file, line, c.snippet);
    const loc = near ? locate(this.files, file, near) : null;
    if (loc?.lineType) return { file: loc.path, line: near, lineType: loc.lineType, excerpt: loc.excerpt, focus: loc.focus };
    return { file, line: null, lineType: null, excerpt: [], focus: 0 };
  }

  /** Built in code: no model call. Brief, like Claude Code's final comment. */
  async summarize() {
    const d = this.data, kept = d.findings.filter((f) => f.verification.verdict !== 'withdrawn' && f.kind !== 'reply');
    const issues = kept.filter((f) => f.kind !== 'suggestion'), sugg = kept.length - issues.length;
    const blocking = issues.filter((f) => f.severity === 'blocker' || f.asTask);
    const rec = blocking.some((f) => f.severity === 'blocker') ? 'blocked' : issues.length ? 'needs_work' : 'approve';
    const n = this.files.length, files = `${n} changed file${n === 1 ? '' : 's'}`;
    const text = !kept.length ? `Went through the ${files} and did not find anything that needs to change before this merges.`
      : `Went through the ${files} and found ${issues.length ? `${issues.length} issue${issues.length === 1 ? '' : 's'} worth fixing` : 'no blocking issues'}${sugg ? `${issues.length ? ' and' : ','} ${sugg} suggestion${sugg === 1 ? '' : 's'}` : ''}${issues.length ? `: ${issues.slice(0, 4).map((f) => f.title.replace(/[.\s]+$/, '')).join('; ')}` : ''}. The details are in the inline comments.`;
    let gates = null;
    if (this.profile) {
      gates = Object.fromEntries(['gate_crash', 'gate_false_pos', 'gate_no_decrease', 'gate_loophole', 'cross_repo'].map((g) => {
        const f = kept.find((x) => String(x.category).toLowerCase().includes(g));
        return [g, f ? `BLOCKER ${f.file}:${f.line || '?'} ${f.title}` : 'PASS'];
      }));
    }
    return { text, recommendation: rec, gates, post: true };
  }

  // ---- posting: only ever called after explicit user confirmation -------------------------------
  async post({ includeSummary = false } = {}) {
    const d = this.data, { workspace: ws, repository: repo, id } = d.pr;
    const results = [];
    for (const f of d.findings.filter((x) => x.status === 'approved')) {
      if (f.kind === 'reply') {
        try { const r = await this.bb.addComment(ws, repo, id, { comment_text: cleanComment(f.body), parent_comment_id: f.reply.parentId, severity: f.asTask ? 'BLOCKER' : 'NORMAL' }); f.status = 'posted'; f.postedId = r?.id ?? null; results.push({ id: f.id, ok: true }); }
        catch (e) { f.status = 'failed'; f.postError = e.message; results.push({ id: f.id, ok: false, error: e.message }); }
        this.emitEvent('finding_update', { finding: f }); continue;
      }
      const link = !f.line && f.file && d.pr.headCommit ? `\n\n${this.cfg.bitbucket.baseUrl.replace(/\/+$/, '')}/projects/${ws}/repos/${repo}/browse/${f.file}?at=${d.pr.headCommit}` : '';
      const args = { comment_text: cleanComment(f.body) + link, severity: f.asTask ? 'BLOCKER' : 'NORMAL' };
      if (f.file && f.line) Object.assign(args, { file_path: f.file, line_number: f.line, line_type: f.lineType || 'CONTEXT' });
      try {
        const r = await this.bb.addComment(ws, repo, id, args);
        f.status = 'posted'; f.postedId = r?.id ?? r?.comment_id ?? null; results.push({ id: f.id, ok: true });
      } catch (e) { f.status = 'failed'; f.postError = e.message; results.push({ id: f.id, ok: false, error: e.message }); }
      this.emitEvent('finding_update', { finding: f });
    }
    if (includeSummary && d.summary?.text && !d.summary.posted) {
      try { await this.bb.addComment(ws, repo, id, { comment_text: cleanComment(d.summary.text), severity: 'NORMAL' }); d.summary.posted = true; results.push({ id: 'summary', ok: true }); }
      catch (e) { results.push({ id: 'summary', ok: false, error: e.message }); }
    }
    this.persist();
    return results;
  }
}

export const fmt = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n));
const normKind = (k) => (['bug', 'breaking', 'suggestion'].includes(String(k).toLowerCase()) ? String(k).toLowerCase() : 'bug');
const normSev = (s) => (['blocker', 'major', 'minor'].includes(String(s).toLowerCase()) ? String(s).toLowerCase() : 'major');
/** Bugs / breaking-change risks that matter become Bitbucket tasks; everything else is a normal comment. */
const defaultTask = (f) => f.kind !== 'suggestion' && f.severity !== 'minor';

async function pool(items, size, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) { const i = next++; await fn(items[i], i); }
  }));
}
