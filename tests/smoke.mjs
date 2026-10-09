// Renders every TUI screen with stub data. No network, no model calls.
import React from 'react';
import { render } from 'ink-testing-library';
import { loadConfig } from '../src/config.js';
import { Review } from '../src/review.js';
import { PrList } from '../src/tui/list.js';
import { Setup } from '../src/tui/setup.js';
import { Confirm, ReviewScreen } from '../src/tui/review.js';
import { CHECKS } from '../src/checks.js';

const h = React.createElement, dims = { w: 100, h: 30 };
const cfg = loadConfig();
const mkpr = (o) => ({ workspace: 'PICAF', updated_on: new Date().toISOString(), source_branch: 'feat', destination_branch: 'main', reviewers: ['A', 'B'], open_task_count: 0, ...o });
const bb = { listPrs: async (role) => (role === 'REVIEWER' ? [
  mkpr({ id: 971, repository: 'upi-inapp-wrapper', title: 'fix: QR-6518: manageVpa and vpas on session token', author: 'Sarfaraz Sheikh', open_task_count: 11 }),
  mkpr({ id: 962, repository: 'upi-inapp-wrapper', title: 'fix: UPI-105623: continue forked querying', author: 'Om Gaikwad' }),
  mkpr({ id: 1573, repository: 'hyper-upi', title: 'fix: UPI-26453: LTFS UI MERGE', author: 'Om Gaikwad' }),
  mkpr({ id: 5, workspace: 'AX', repository: 'kavach', title: 'rust: tighten attest', author: 'X Y' })]
  : [mkpr({ id: 1600, repository: 'hyper-upi', title: 'my change: mask vpa', author: 'me', open_task_count: 2 })]) };
const calls = [];
const tcfg = { ...cfg, llm: { ...cfg.llm, baseURL: 'http://127.0.0.1:9', apiKey: 'x', model: 'glm-latest', fastModel: 'glm-flash-experimental', models: ['glm-latest', 'glm-flash-experimental', 'kimi-latest', 'claude-sonnet-4-6', 'gemini-3-pro-preview'] } };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const show = (name, f) => console.log(`\n===== ${name} =====\n${f}`);

let r = render(h(Setup, { cfg, dims, first: true, onDone() {}, onCancel() {} })); await wait(50); show('SETUP', r.lastFrame()); r.unmount();
r = render(h(PrList, { bb, cfg: tcfg, dims, onModels: (c) => calls.push(c), onOpenUrl: async () => null, model: 'glm-latest', checks: new Set(CHECKS.filter((c) => c.default).map((c) => c.id)), setChecks() {}, onReview() {}, onSettings() {}, onHistory() {}, onQuit() {}, onModel() {} }));
await wait(150); show('PR LIST', r.lastFrame()); r.stdin.write('\t'); await wait(100); show('MY PRS TAB', r.lastFrame()); r.stdin.write('u'); await wait(100); show('URL PROMPT', r.lastFrame()); r.stdin.write('\x1b'); await wait(60); r.stdin.write('m'); await wait(200); show('MODEL PICKER', r.lastFrame()); r.stdin.write('j'); r.stdin.write('j'); await wait(50); r.stdin.write('\r'); await wait(50); r.stdin.write('\t'); r.stdin.write('j'); r.stdin.write('j'); await wait(50); r.stdin.write('\r'); await wait(80); show('PICKER AFTER SELECTS', r.lastFrame()); console.log('onModels calls:', JSON.stringify(calls)); r.unmount();

const rev = new Review({ cfg, bb, model: 'glm-latest', checks: ['bugs'], target: { workspace: 'AX', repository: 'kavach', id: 5, title: 'rust: tighten attest' } });
rev.data.estimate = { files: 12, reviewable: 7, skipped: 5, truncated: 1, chunks: 3, cachedChunks: 1, analyzeTokens: 41000, verifyTokens: 31000, totalTokens: 72000, budget: 400000 };
rev.data.pr.description = 'Adds attestation retry. Tightens the /scan handler so a missing session returns 401 instead of panicking.\n\nTested on Pixel 7 and a rooted emulator. Jira: QR-7305'; rev.data.notices = [{ level: 'warn', text: 'You already posted 3 comments on this exact commit (2026-10-08).' }]; rev.data.guidelines = ['CLAUDE.md', 'rasp-core/AGENTS.md']; rev.data.effort = 'medium'; rev.effort = { min: 80, passes: 1 };
rev.data.repo = { state: 'ready', dir: '/Users/me/.pr-sentinel/repos/AX/kavach' }; rev.data.status = 'ready'; rev.data.pr.src = 'feat'; rev.data.pr.dst = 'main';
r = render(h(Confirm, { review: rev, cfg, dims, onStart() {}, onBack() {} })); await wait(50); show('CONFIRM', r.lastFrame()); r.unmount();

rev.data.status = 'running'; rev.data.stages[0].state = 'done'; rev.data.stages[1].state = 'active'; rev.data.stages[1].detail = '0/3';
rev.data.live = [{ id: 1, label: 'analysis 1/3', model: 'glm-latest', phase: 'thinking', tokens: 2310, t0: Date.now() - 41000 }, { id: 2, label: 'analysis 2/3', model: 'glm-latest', phase: 'writing', tokens: 3900, t0: Date.now() - 52000 }];
rev.data.log = [{ t: new Date().toISOString(), msg: 'Repo ready at /x/y (PR head + base)' }];
r = render(h(ReviewScreen, { review: rev, cfg, dims, onBack() {}, onUserCancel() {} })); await wait(80); show('RUNNING + ACTIVITY', r.lastFrame()); r.unmount();
const mk = (o) => ({ score: 91, gate: { appropriate: true, reason: 'Real, reachable, and on a changed line.' }, failureScenario: 'A request body without an id makes body.id None and unwrap() panics the worker.', id: Math.random().toString(16).slice(2, 8), excerpt: [{ type: 'CONTEXT', no: 40, text: 'let x = req.body;' }, { type: 'ADDED', no: 41, text: 'let id = x.id.unwrap();' }, { type: 'CONTEXT', no: 42, text: 'store.write(id);' }], focus: 1, lineType: 'ADDED', category: 'bugs', confidence: 0.82, status: 'pending', asTask: true, verification: { verdict: 'confirmed', reason: 'Checked /scan handler: id is client-supplied; no guard earlier.', evidence: [{ op: 'grep', query: 'unwrap\\(', result: 'src/scan.rs:41: x.id.unwrap()' }] }, ...o });
rev.data.status = 'review'; rev.data.live = []; rev.data.stages.forEach((s) => (s.state = 'done'));
rev.data.usage = { total: 52000, budget: 400000, calls: 6 };
rev.data.summary = { text: 'Tightens attestation. One panic path remains on client-shaped input in /scan.', recommendation: 'blocked', post: true, gates: { gate_crash: 'BLOCKER src/scan.rs:41 unwrap on client id', gate_false_pos: 'PASS' } };
rev.data.findings = [
  mk({ file: 'src/scan.rs', line: 41, kind: 'bug', severity: 'blocker', title: 'unwrap on client-supplied id panics /scan', body: 'x.id comes straight from the request body, so a request without id panics the handler and takes the worker down. Return a typed AppError instead.' }),
  mk({ file: 'src/rules/defaults.rs', line: 9, kind: 'suggestion', severity: 'minor', title: 'Add test for new rule', asTask: false, status: 'approved', body: 'Worth a regression test for the new warn-tier code.' }),
  mk({ file: 'src/old.rs', line: 3, kind: 'bug', severity: 'major', title: 'Handled by caller', verification: { verdict: 'withdrawn', reason: 'Caller validates.', evidence: [] }, body: 'x' }),
];
const T0 = Date.now();
rev.data.discussion = { total: 3, open: 2, withReplies: 2, needReply: 1, threads: [
  { id: 101, path: 'src/scan.rs', line: 41, lineType: 'ADDED', resolved: false, task: true, open: true, needsReply: true, last: { role: 'author', who: 'Dev One', at: T0 - 3600e3 }, messages: [
    { id: 101, who: 'Reviewer One', role: 'me', text: 'unwrap will panic when the id is missing from the request body.', at: T0 - 86400e3, severity: 'BLOCKER' },
    { id: 102, who: 'Dev One', role: 'author', text: 'This is guarded earlier in the auth middleware, so id is always present at this point.', at: T0 - 3600e3, severity: 'NORMAL' }] },
  { id: 201, path: 'src/rules/defaults.rs', line: 9, lineType: 'ADDED', resolved: true, task: false, open: false, needsReply: false, last: { role: 'other', who: 'Reviewer Two', at: T0 - 5 * 86400e3 }, messages: [
    { id: 201, who: 'Reviewer Two', role: 'other', text: 'Should this be warn tier instead of block?', at: T0 - 5 * 86400e3, severity: 'NORMAL' }] },
  { id: 301, path: null, line: null, resolved: false, task: false, open: true, needsReply: false, last: { role: 'bot', who: 'xyne', at: T0 - 9e5 }, messages: [{ id: 301, who: 'xyne', role: 'bot', text: 'Release notes generated.', at: T0 - 9e5 }] }] };
rev.data.findings.push({ id: 'rp1', kind: 'reply', file: 'src/scan.rs', line: 41, lineType: 'ADDED', excerpt: [], focus: 0, category: 'reply', severity: 'minor', title: 'Reply to Dev One', thread: 101,
  body: 'I could not find a guard for a missing id in the code at the PR head, so I do not think the middleware covers it.\n\nbody.id is an Option read straight from the request, so a request without it still reaches unwrap() and panics the worker. If the guard lives in another file, point me at it and I will resolve this.',
  status: 'pending', asTask: false, score: null, gate: { appropriate: true, reason: 'x' }, reply: { parentId: 101, to: 'Dev One', verdict: 'not_addressed', conversation: rev.data.discussion.threads[0].messages },
  verification: { verdict: 'confirmed', reason: 'No such middleware guard appears in the code shown.', evidence: [{ op: 'read', query: 'src/scan.rs:33 (code now at PR head)', result: '33: fn handle(req)\n34:   let id = body.id.unwrap();' }] } });
r = render(h(ReviewScreen, { review: rev, cfg, dims, onBack() {}, onUserCancel() {} })); await wait(80); show('FINDINGS', r.lastFrame());
for (let i = 0; i < 4; i++) { r.stdin.write('f'); await wait(40); } await wait(60); show('REPLIES TAB', r.lastFrame());
r.stdin.write('f'); await wait(80); show('THREADS TAB', r.lastFrame()); r.stdin.write('j'); await wait(60); show('THREAD (2nd, resolved)', r.lastFrame()); r.stdin.write('k'); r.stdin.write('f'); r.stdin.write('f'); r.stdin.write('f'); r.stdin.write('f'); r.stdin.write('f'); r.stdin.write('f'); await wait(60);
r.stdin.write('j'); await wait(80); show('FINDINGS (2nd selected)', r.lastFrame());
r.stdin.write('p'); await wait(80); show('POST CONFIRM', r.lastFrame()); r.unmount();
process.exit(0);
