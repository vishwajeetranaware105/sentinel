// Fix mode against a local bare repo: edits, all-or-nothing failures, commit (new and amend), push, protections.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
process.env.SENTINEL_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'sent-fix-'));
const { FixSession } = await import('../src/fix.js');
const sh = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
let fails = 0; const ok = (c, m) => { console.log(c ? 'PASS' : 'FAIL', m); if (!c) fails++; };

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sent-remote-'));
const seed = path.join(root, 'seed'); fs.mkdirSync(seed); sh(seed, 'init', '-q', '-b', 'master');
sh(seed, 'config', 'user.email', 'a@b.c'); sh(seed, 'config', 'user.name', 'a');
fs.writeFileSync(path.join(seed, 'app.js'), 'function total(a, b) {\n  return a + b;\n}\nfunction dup() { return 1; }\nfunction dup2() { return 1; }\n');
sh(seed, 'add', '-A'); sh(seed, 'commit', '-qm', 'init');
sh(seed, 'checkout', '-qb', 'feature'); fs.appendFileSync(path.join(seed, 'app.js'), '// feature\n'); sh(seed, 'commit', '-qam', 'feature work');
// (the company's global pre-push hook blocks pushes to unapproved remotes, even temp ones: build the remote by cloning, and never push in tests)
fs.mkdirSync(path.join(root, 'AX'), { recursive: true });
sh(root, 'clone', '-q', '--bare', seed, path.join(root, 'AX', 'demo.git'));
const bare = path.join(root, 'AX', 'demo.git');

const cfg = { bitbucket: { username: 'me', token: '' }, llm: { model: 'm' }, cloneUrlTemplate: path.join(root, '{ws}', '{repo}.git') };
const msg = (who, slug, text) => ({ id: Math.random(), who, slug, email: `${slug}@x.com`, text, at: Date.now() });
const threads = [
  { id: 1, path: 'app.js', line: 2, resolved: false, messages: [msg('Rev', 'rev', 'Guard against non-numbers here')] },
  { id: 2, path: 'app.js', line: 4, resolved: false, messages: [msg('Rev', 'rev', 'dup is duplicated')] },
  { id: 3, path: 'app.js', line: 1, resolved: false, messages: [msg('Rev', 'rev', 'why this name?')] },
  { id: 4, path: 'app.js', line: 1, resolved: true, messages: [msg('Rev', 'rev', 'already resolved')] },
  { id: 5, path: 'app.js', line: 1, resolved: false, messages: [msg('Rev', 'rev', 'q'), msg('Me', 'me', 'done')] },
  { id: 6, path: null, line: null, resolved: false, messages: [msg('Bot', 'euler.bot', 'summary')] },
  { id: 7, path: 'app.js', line: 3, resolved: false, messages: [msg('Me', 'me', 'my own review note on my PR')] },
];
const answers = {
  1: { action: 'edit', edits: [{ file: 'app.js', find: '  return a + b;', replace: '  return Number(a) + Number(b);' }], summary: 'Coerce both operands to numbers in total()', reply: 'Added coercion.' },
  2: { action: 'edit', edits: [{ file: 'app.js', find: 'return 1; }', replace: 'return 2; }' }], summary: 'x', reply: '' },       // matches 2 places -> must fail and leave the file alone
  3: { action: 'no_change', summary: '', reply: 'It mirrors the API name.' },
};
let call = 0;
const llm = { async json(messages) { const id = +/Comment on app\.js:(\d)/.exec(messages[1].content)?.[1]; call++; return answers[{ 2: 1, 4: 2, 1: 3 }[id]]; } };
const bb = { async discussion() { return threads; } };
const FINDING = { id: 'abc', file: 'app.js', line: 2, kind: 'bug', severity: 'major', title: 'Adds strings', body: 'total() concatenates strings', failureScenario: 'total("1","2") returns 12', verification: { verdict: 'confirmed' }, status: 'pending' };
const s = new FixSession({ findings: [FINDING, { ...FINDING, id: 'w', verification: { verdict: 'withdrawn' } }], cfg, bb, llm, pr: { workspace: 'AX', repository: 'demo', id: 7, title: 't', source_branch: 'feature', destination_branch: 'master' } });

const open = await s.load();
ok(open.filter((t) => t.source === 'thread').map((t) => t.id).sort().join() === '1,2,3,5,7', 'open human threads are listed, including your own review comments (resolved and bot threads left out)');
ok(open.find((t) => t.id === 7) && !open.find((t) => t.id === 7).answered, 'your own comment with nobody else in the thread still needs fixing');
ok(open.find((t) => t.id === 5).answered && !open.find((t) => t.id === 1).answered, 'a thread you already answered is flagged');
await s.prepareTree();
ok(fs.readFileSync(path.join(s.dir, 'app.js'), 'utf8').includes('// feature'), 'checkout is the PR branch head');
ok(open[0].source === 'finding' && open.filter((t) => t.source === 'finding').length === 1 && /Fails when/.test(open[0].messages[0].text), 'Sentinel findings come first (withdrawn ones are not offered) with their failing scenario');
await s.proposeFor([1, 2, 3]);
ok(s.results.get(1).status === 'applied', 'unique edit applied');
ok(s.results.get(2).status === 'failed' && /2 places/.test(s.results.get(2).failed[0]), 'ambiguous edit is refused, not guessed');
ok(s.results.get(3).status === 'no_change' && s.results.get(3).reply, 'no_change keeps a reply draft');
ok((await s.changedFiles()).join() === 'app.js' && /Number\(a\)/.test(await s.diff()) && !/return 2/.test(await s.diff()), 'diff holds only the applied edit');
ok(s.applyEdit({ file: '../etc/passwd', find: 'x', replace: 'y' }) !== null && s.applyEdit({ file: '.git/config', find: 'x', replace: 'y' }) !== null, 'paths outside the tree are refused');

await s.commit({ mode: 'new' });
ok(sh(bare, 'rev-parse', 'feature') === sh(bare, 'rev-parse', 'feature') && sh(s.dir, 'rev-list', '--count', 'HEAD') === '3' && /Address review comments/.test(sh(s.dir, 'log', '-1', '--format=%s')), 'new commit made on top of the branch, history kept');
ok(sh(bare, 'rev-list', '--count', 'feature') === '2', 'commit alone does not touch the remote');
ok(s.pushArgs().join(' ') === 'push origin HEAD:refs/heads/feature', 'new commit is pushed as a plain fast-forward push (no force)');

const s2 = new FixSession({ cfg, bb, llm, pr: { workspace: 'AX', repository: 'demo', id: 10, title: 't', source_branch: 'feature', destination_branch: 'master' } });
await s2.load(); await s2.prepareTree();
const tip = sh(bare, 'rev-parse', 'feature');
fs.appendFileSync(path.join(s2.dir, 'app.js'), '// amended\n');
await s2.commit({ mode: 'amend' });
ok(sh(s2.dir, 'rev-list', '--count', 'HEAD') === '2' && sh(s2.dir, 'rev-parse', 'HEAD') !== tip, 'amend rewrites the last commit instead of adding one');
ok(s2.pushArgs().join(' ') === `push --force-with-lease=refs/heads/feature:${tip} origin HEAD:refs/heads/feature`, 'amend uses a lease pinned to the fetched remote commit, never a bare --force');

await s2.discard(); ok(!(await s2.changedFiles()).length && sh(s2.dir, 'rev-parse', 'HEAD') === tip, 'discard restores the branch');
const bad = new FixSession({ cfg, bb, llm, pr: { workspace: 'AX', repository: 'demo', id: 8, title: 't', source_branch: 'master', destination_branch: 'master' } });
let refused = false; try { await bad.prepareTree(); } catch { refused = true; }
ok(refused, 'never works on a shared branch');
const s4 = new FixSession({ cfg, bb, llm, pr: { workspace: 'AX', repository: 'demo', id: 9, title: 't', source_branch: 'main', destination_branch: 'develop' } });
let r4 = false; try { s4.pushArgs(); } catch { r4 = true; }
ok(r4, 'push is refused for protected branch names');
// a commit left unpushed by an earlier session is kept, not wiped, when the tree is prepared again
const s5 = new FixSession({ cfg, bb, llm, pr: { workspace: 'AX', repository: 'demo', id: 7, title: 't', source_branch: 'feature', destination_branch: 'master' } });
await s.load(); const keep = await s5.prepareTree();
ok(keep.resumed && keep.ahead === 1 && s5.committed?.pending, 'an unpushed commit from an earlier session is kept');
process.exit(fails ? 1 : 0);
