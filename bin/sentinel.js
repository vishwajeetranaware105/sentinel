#!/usr/bin/env node
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const argv = process.argv.slice(2);
const looksLikePr = (a) => /pull-requests\/\d+|^[\w.-]+\/[\w.-]+#\d+$/.test(a || '');
const [cmd = 'tui', ...args] = looksLikePr(argv[0]) ? ['tui', argv[0]] : argv;
const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json'), 'utf8'));

const HELP = `sentinel ${pkg.version} — terminal PR reviewer for Bitbucket Server

  sentinel                 open the review UI (first run walks you through setup)
  sentinel <PR link>       open the UI straight on that PR  (https://…/pull-requests/123 or KEY/repo#123)
  sentinel doctor          check git, Bitbucket MCP and the model gateway (uses no model tokens)
  sentinel clone WS/repo   pre-clone a repo into the configured workspace directory
  sentinel config          print config path and masked settings
  sentinel --version
`;

if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
  if (process.stdout.isTTY) { const { logoText } = await import('../src/tui/logo.js'); console.log('\n' + logoText() + '\n'); }
  console.log(HELP); process.exit(0);
}
if (cmd === '--version' || cmd === '-v') { console.log(pkg.version); process.exit(0); }
if (cmd === 'update') {
  const { refreshLatest, isNewer, runUpdate } = await import('../src/update.js');
  const latest = await refreshLatest({ force: true });
  if (latest && !isNewer(latest, pkg.version)) { console.log(`Sentinel ${pkg.version} is up to date.`); process.exit(0); }
  console.log(latest ? `New version ${latest} available (you have ${pkg.version}).` : 'Could not check for the latest version; trying to update anyway.');
  process.exit(runUpdate() ? 0 : 1);
}

const { loadConfig, isConfigured, CONFIG_PATH } = await import('../src/config.js');
const { killAllMcp } = await import('../src/bitbucket.js');
// Never leave the Bitbucket MCP child behind, however we exit (quit, Ctrl+C, closed terminal, kill).
process.on('exit', killAllMcp);
for (const sig of ['SIGHUP', 'SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));

if (cmd === 'config') {
  const c = loadConfig();
  console.log(CONFIG_PATH);
  console.log(JSON.stringify({ ...c, bitbucket: { ...c.bitbucket, token: c.bitbucket.token ? '****' : '' }, llm: { ...c.llm, apiKey: c.llm.apiKey ? '****' : '' } }, null, 2));
} else if (cmd === 'clone') {
  const { cloneRepo } = await import('../src/repo.js');
  const [ws, repo] = (args[0] || '').split('/');
  if (!ws || !repo) { console.error('usage: sentinel clone WS/repo'); process.exit(2); }
  await cloneRepo(loadConfig(), ws, repo).catch((e) => { console.error(e.message); process.exit(1); });
} else if (cmd === 'doctor') {
  const { spawn } = await import('node:child_process');
  const { Bitbucket } = await import('../src/bitbucket.js');
  const cfg = loadConfig();
  const ok = (m) => console.log(`  ✓ ${m}`), bad = (m) => console.log(`  ✗ ${m}`);
  console.log(`\n  config: ${CONFIG_PATH}`);
  isConfigured(cfg) ? ok('configured') : bad('not configured — run `sentinel`');
  await new Promise((r) => spawn('git', ['--version']).on('error', () => { bad('git not found'); r(); }).on('exit', (c) => { if (c === 0) ok('git found'); r(); }));
  const bb = new Bitbucket(cfg);
  try { const r = await bb.reviewerPrs({ limit: 1 }); ok(`Bitbucket MCP connected (${r.prs.length ? 'reviewer PRs visible' : 'no reviewer PRs'})`); } catch (e) { bad(`Bitbucket MCP: ${e.message}`); }
  await bb.close();
  if (['claude', 'codex'].includes(cfg.llm.provider)) {
    try { const { execFileSync } = await import('node:child_process'); const v = execFileSync(cfg.llm.provider, ['--version'], { stdio: 'pipe', timeout: 15000 }).toString().trim(); ok(`${cfg.llm.provider} CLI found (${v}) — uses your existing login (${cfg.llm.model}, verifier ${cfg.llm.fastModel})`); }
    catch { bad(`'${cfg.llm.provider}' CLI not found on PATH`); }
  } else try {
    const r = await fetch(cfg.llm.baseURL.replace(/\/+$/, '') + '/models', { headers: { authorization: `Bearer ${cfg.llm.apiKey}` } });
    r.ok ? ok(`model gateway reachable (${cfg.llm.model}, verifier ${cfg.llm.fastModel})`) : bad(`model gateway answered ${r.status}`);
  } catch (e) { bad(`model gateway: ${e.message}`); }
  console.log(); process.exit(0);
} else if (cmd === 'tui' || cmd === 'start' || cmd === 'setup') {
  if (!process.stdin.isTTY || !process.stdout.isTTY) { console.error('sentinel needs an interactive terminal.'); process.exit(1); }
  const React = (await import('react')).default;
  const { render } = await import('ink');
  const { App } = await import('../src/tui/app.js');
  const out = process.stdout;
  // alternate screen like opencode/vim; black→indigo gradient painted per row; frames written atomically
  const { installPainter } = await import('../src/tui/paint.js');
  const { setTheme } = await import('../src/tui/kit.js');
  setTheme(loadConfig().theme || 'aurora');          // so the very first frame and the terminal background already match the theme
  const painter = installPainter(out);
  out.write(`\x1b[?1049h\x1b]11;${painter.bottomHex}\x07\x1b]10;#f2f2f4\x07`);
  painter.prime();
  const restore = () => { painter.restore(); out.write('\x1b[0m\x1b]111\x07\x1b]110\x07\x1b[?1049l'); };
  process.on('exit', restore);
  const { parsePrUrl } = await import('../src/bitbucket.js');
  const { term } = await import('../src/tui/term.js');
  const upd = await import('../src/update.js');
  term.update = upd.knownLatest(pkg.version);        // from the last check: instant
  upd.refreshLatest().catch(() => {});               // refresh in the background for next time
  const app = render(React.createElement(App, { initialCfg: loadConfig(), initialPr: parsePrUrl(args[0]) }), { exitOnCtrlC: true });
  Object.assign(term, { out, painter, app, setRaw: (on) => process.stdin.setRawMode?.(on) });
  await app.waitUntilExit();
  restore();
  if (term.updateRequested) { const { runUpdate } = await import('../src/update.js'); const ok = runUpdate(); console.log(ok ? '\nUpdated. Run `sentinel` again.' : '\nUpdate failed. Try `sentinel update`.'); process.exit(ok ? 0 : 1); }
  process.exit(0); // also reaps the Bitbucket MCP child
} else {
  console.log(HELP);
}
