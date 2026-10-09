// End-to-end review pipeline with a fake Bitbucket and a scripted model: no network, no tokens.
import os from 'node:os'; import path from 'node:path'; import fs from 'node:fs';
process.env.SENTINEL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sentinel-test-'));
const { loadConfig } = await import('../src/config.js');
const { Review } = await import('../src/review.js');

const DIFF = `diff --git src://src/auth.rs dst://src/auth.rs
index 111..222 100644
--- src://src/auth.rs
+++ dst://src/auth.rs
@@ -10,6 +10,9 @@ fn handle(req: Req) -> Res {
     let body = req.body();
-    let id = body.id.ok_or(Err::Missing)?;
+    let id = body.id.unwrap();
+    let token = make_token(id);
+    log::info!("issued {}", token);
     store.write(id);
     Ok(Res::ok())
 }
@@ -40,4 +43,6 @@ fn helper() {
     // existing code
     let legacy = old_call();
+    let n = items.len() - 1;
+    items[n].touch();
 }
`;
const cfg = loadConfig();
cfg.bitbucket.username = 'me@x.com'; cfg.bitbucket.baseUrl = 'http://127.0.0.1:9'; cfg.bitbucket.token = 'x'; cfg.llm.apiKey = 'x'; cfg.workspaceRoot = path.join(process.env.SENTINEL_HOME, 'repos');
const mkBb = (state = 'OPEN', title = 'Return typed errors in auth handler') => ({
  getPr: async () => ({ title, state, description: 'Adds token issuing to the auth handler. Missing ids should still fail the request.', author: 'Dev One',
    author_username: 'dev@x.com', source_branch: 'feat', destination_branch: 'main', source_commit: 'abc123def456', web_url: 'x', version: 1, active_comments: [{ author: 'Rev', text: 'Please add a log line when tokens are issued' }] }),
  discussion: async () => [
    { id: 101, path: 'src/auth.rs', line: 13, lineType: 'ADDED', orphaned: false, resolved: false, task: true, messages: [
      { id: 101, parentId: null, who: 'Me Reviewer', email: 'me@x.com', slug: 'me', text: 'unwrap will panic when the id is missing', at: 1000, state: 'OPEN', severity: 'BLOCKER' },
      { id: 102, parentId: 101, who: 'Dev One', email: 'dev@x.com', slug: 'dev', text: 'this is guarded earlier in the auth middleware, so id is always present', at: 2000, state: 'OPEN', severity: 'NORMAL' }] },
    { id: 201, path: 'src/auth.rs', line: 44, lineType: 'ADDED', orphaned: false, resolved: true, task: false, messages: [
      { id: 201, parentId: null, who: 'Other Rev', email: 'o@x.com', slug: 'o', text: 'nit: rename items', at: 500, state: 'RESOLVED', severity: 'NORMAL' }] },
    { id: 301, path: null, line: null, lineType: null, orphaned: false, resolved: false, task: false, messages: [
      { id: 301, parentId: null, who: 'Tara', email: 'tara@x.com', slug: 'tara', text: '🤖 Curator Bot - Slack Thread Link', at: 100, state: 'OPEN', severity: 'NORMAL' }] }],
  getDiff: async () => DIFF, listCommits: async () => ({ commits: [{ message: 'auth: issue tokens' }] }), addComment: async () => ({ id: 1 }),
});

const cands = [
  { file: 'src/auth.rs', line: 13, snippet: 'let id = body.id.unwrap();', kind: 'bug', severity: 'blocker', title: 'unwrap on missing id panics', confidence: 0.9,
    failure_scenario: 'A request body without an id makes body.id None, unwrap() panics and the worker thread dies.', body: '**Bug:** body.id is optional here but unwrap() is called on it.\n\nA request without id panics the handler instead of returning Err::Missing as before; keep the ok_or(...)? form.' },
  { file: 'src/auth.rs', line: 14, kind: 'bug', severity: 'major', title: 'No scenario given', confidence: 0.7, failure_scenario: '', body: 'This might be wrong somehow.' },
  { file: 'src/auth.rs', line: 41, snippet: 'let legacy = old_call();', kind: 'bug', severity: 'major', title: 'Pre-existing legacy call', confidence: 0.8, failure_scenario: 'old_call() returns a stale value when the cache is cold, so legacy is wrong.', body: 'old_call() is stale.' },
  { file: 'src/auth.rs', line: 44, kind: 'bug', severity: 'major', title: 'len() - 1 underflows on empty items', confidence: 0.85,
    failure_scenario: 'When items is empty, items.len() - 1 underflows (usize) and items[n] panics.', body: 'items.len() - 1 underflows when items is empty.\n\nThen items[n] panics. Guard with if let Some(last) = items.last_mut().' },
  { file: 'src/auth.rs', line: 15, kind: 'bug', severity: 'minor', title: 'Token written to logs', confidence: 0.8, failure_scenario: 'Every issued token is written to the info log so anyone with log access can replay it.', body: 'The issued token is logged in clear text at info level, so anyone with log access can replay it. Log the id only.' },
  { file: 'src/auth.rs', line: 15, kind: 'suggestion', severity: 'minor', title: 'Log token issuance', confidence: 0.7, failure_scenario: '', body: 'Consider adding a log line when a token is issued.' },
  { file: 'src/auth.rs', line: 14, kind: 'suggestion', severity: 'minor', title: 'Rename make_token', confidence: 0.7, failure_scenario: '', body: 'Maybe rename make_token to issue_token for naming consistency.' },
];
const gateScores = { 'unwrap on missing id panics': [97, true, 'Traced: unwrap on Option from client body.'], 'len() - 1 underflows on empty items': [82, true, 'Reachable when items is empty.'],
  'Token written to logs': [91, true, 'Real exposure of a bearer secret.'], 'Log token issuance': [70, false, 'Duplicate of the existing reviewer comment.', true], 'Rename make_token': [40, true, 'Naming nitpick.'] };

async function run(effort, label, bb = mkBb()) {
  const c = { ...cfg, effort }; const r = new Review({ cfg: c, bb, model: 'm', checks: ['bugs'], target: { workspace: 'AX', repository: 'demo', id: 7 } });
  const seen = { gatePrompt: '', analysisPrompt: '' };
  const calls = []; seen.calls = calls;
  r.llm.json = async (msgs, opts) => {
    const sys = msgs[0].content, user = msgs[1].content;
    calls.push({ kind: sys.includes('follow up on review threads') ? 'replies' : sys.includes('meticulous') ? 'analysis' : sys.includes('verify code-review') ? 'verify' : sys.includes('final gate') ? 'gate' : 'other', reasoning: opts?.reasoning, model: opts?.model });
    if (sys.includes('meticulous senior reviewer')) { seen.analysisPrompt = user; return { findings: cands }; }
    if (sys.includes('verify code-review findings')) {
      const items = JSON.parse(user.slice(user.indexOf('Findings:\n') + 10));
      return { results: items.map((i) => ({ id: i.id, verdict: 'confirmed', reason: 'Traced the scenario in the code.' })) };
    }
    if (sys.includes('follow up on review threads')) {
      const items = JSON.parse(user.slice(user.indexOf('Threads:\n') + 9)); seen.replyItems = items;
      return { results: items.map((i) => ({ id: i.id, verdict: 'not_addressed', reason: 'No such middleware guard appears in the code shown.', reply: '**Reply:** I could not find a guard for a missing id in the code at the PR head.\n\nbody.id is an Option read straight from the request, so a request without it still reaches unwrap() and panics the worker.' })) };
    }
    if (sys.includes('final gate')) {
      seen.gatePrompt = user;
      const items = JSON.parse(user.slice(user.indexOf('Findings:\n') + 10));
      return { results: items.map((i) => { const g = gateScores[i.title] || [50, true, 'ok']; return { id: i.id, score: g[0], appropriate: g[1], reason: g[2], duplicate_of: g[3] ? 'other' : null }; }) };
    }
    return { summary: 'Adds token issuing; one crash path.' };
  };
  await r.prepare();
  if (r.data.blocked) return { r, seen };
  await r.execute();
  console.log(`\n--- effort=${effort} ${label}`);
  for (const f of r.data.findings) console.log(`${f.verification.verdict === 'withdrawn' ? 'WITHDRAWN' : 'SHOWN    '} score=${String(f.score ?? '-').padEnd(4)} ${f.title.padEnd(40)} ${f.verification.verdict === 'withdrawn' ? '<- ' + f.verification.reason.slice(0, 70) : ''}`);
  return { r, seen };
}

const { r, seen } = await run('medium', '');
const shown = r.data.findings.filter((f) => f.verification.verdict !== 'withdrawn' && f.kind !== 'reply');
const ok = (c, m) => console.log(`${c ? 'PASS' : 'FAIL'}  ${m}`);
console.log('\n--- checks');
ok(r.data.pr.description.includes('token issuing'), 'PR description fetched and stored');
ok(seen.analysisPrompt.includes('Adds token issuing'), 'description is in the analysis prompt (intent)');
ok(seen.gatePrompt.includes('Adds token issuing') && seen.gatePrompt.includes('unwrap will panic when the id is missing'), 'gate sees the description and the existing discussion');
ok(shown.length === 3 && shown.every((f) => (f.score ?? 0) >= 65), `shown ${shown.length} (expect 3), all scored >= threshold`);
ok(!r.data.findings.some((f) => /no concrete failure/i.test(f.verification.reason) && f.verification.verdict !== 'withdrawn'), 'finding without failure scenario never shown');
ok(r.data.findings.find((f) => f.title === 'Pre-existing legacy call').verification.verdict === 'withdrawn', 'pre-existing line (not changed by PR) withdrawn');
ok(shown.every((f) => !/^(bug|blocker|suggestion|issue|major|minor)\b\s*[:\-]/i.test(f.body) && !f.body.includes('**')), 'no label / heading on any shown comment');
ok(r.data.findings.find((f) => f.title === 'Log token issuance').verification.reason.includes('Duplicate'), 'duplicate of an existing PR comment withdrawn');
ok(r.data.findings.find((f) => f.title === 'Rename make_token').verification.verdict === 'withdrawn', 'low-score nitpick withdrawn');
const bug = shown.find((f) => f.title.startsWith('unwrap'));
ok(bug && bug.asTask === true && bug.failureScenario.includes('panics'), 'blocker bug defaults to task and keeps its failure scenario');
ok(r.data.stages.some((s) => s.id === 'gate' && s.state === 'done'), 'gate stage ran');

const k = seen.calls.map((c) => c.kind).join(',');
ok(k === 'analysis,verify,gate,replies', `whole PR = 1 analysis, 1 batched verify, 1 gate, 1 batched reply check, 0 summary calls (got: ${k})`);
ok(r.data.estimate.chunks === 1, 'whole PR reviewed as a single chunk');
ok(seen.calls.find((c) => c.kind === 'analysis').reasoning === 'medium' && seen.calls.filter((c) => c.kind !== 'analysis').every((c) => c.reasoning === 'low'), 'reasoning: analysis follows effort, verify+gate use low');
ok(r.data.summary.text.includes('issue') && !/^(#|\*\*)/.test(r.data.summary.text), `summary built in code: "${r.data.summary.text.slice(0, 80)}..."`);
const rep = r.data.findings.filter((f) => f.kind === 'reply');
ok(r.data.discussion.total === 2 && r.data.discussion.needReply === 1, `discussion: 2 human threads (bot noise excluded), 1 awaiting your reply (got ${r.data.discussion.total}/${r.data.discussion.needReply})`);
ok(r.threads.find((t) => t.id === 101).messages.map((m) => m.role).join() === 'me,author', 'roles resolved: you + PR author');
ok(seen.analysisPrompt.includes('author: "this is guarded earlier'), 'the PR author\'s reply is in the analysis digest, labelled as author');
ok(!seen.analysisPrompt.includes('Curator'), 'bot metadata thread kept out of the digest');
ok(rep.length === 1 && rep[0].reply.parentId === 101 && !/^\*\*|^reply:/i.test(rep[0].body), 'reply drafted for the thread the author answered, label stripped');
ok(seen.calls.map((c) => c.kind).join() === 'analysis,verify,gate,replies', `reply check = 1 extra batched call (got ${seen.calls.map((c) => c.kind).join()})`);
ok(r.data.summary.text.includes('3 issues'), 'summary does not count replies as issues');
const posted = []; r.bb.addComment = async (ws, repo, id, a) => { posted.push(a); return { id: 9 }; };
r.data.findings.forEach((f) => { f.status = f.kind === 'reply' ? 'approved' : f.status; });
await r.post();
ok(posted.length === 1 && posted[0].parent_comment_id === 101 && !posted[0].file_path, 'reply posts inside the thread via parent_comment_id');
const d2 = await r.draftReply(201);
ok(d2.kind === 'reply' && d2.reply.parentId === 201 && r.data.findings.includes(d2), 'draftReply(r key) works on any thread, on demand');
const low = await run('low', '(needs 85)');
const lowShown = low.r.data.findings.filter((f) => f.verification.verdict !== 'withdrawn' && f.kind !== 'reply').map((f) => f.title);
ok(!lowShown.includes('len() - 1 underflows on empty items') && lowShown.length === 2, `low effort (needs 85) hides the 82-score finding, shows ${lowShown.length}`);

const merged = await run('medium', '(merged PR)', mkBb('MERGED'));
ok(merged.r.data.blocked && merged.r.data.notices.some((n) => /MERGED/.test(n.text)), 'merged PR is blocked with a notice');
const draft = new Review({ cfg, bb: mkBb('OPEN', 'WIP: auth changes'), model: 'm', checks: ['bugs'], target: { workspace: 'AX', repository: 'demo', id: 8 } });
await draft.prepare(); ok(draft.data.notices.some((n) => /draft/i.test(n.text)), 'draft PR gets a notice');
process.exit(0);
