import React, { useEffect, useMemo, useState } from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { Box, Text, useApp, useInput } from 'ink';
import { html, C, Frame, useDims, ago, trunc, setTheme, nextTheme } from './kit.js';
import { Setup } from './setup.js';
import { PrList } from './list.js';
import { Confirm, ReviewScreen } from './review.js';
import { Bitbucket } from '../bitbucket.js';
import { term } from './term.js';
import { Review, runs } from '../review.js';
import { CHECKS } from '../checks.js';
import { isConfigured, saveConfig, RUNS_DIR } from '../config.js';

export function App({ initialCfg, initialPr }) {
  const { exit } = useApp();
  const dims = useDims();
  const [cfg, setCfg] = useState(initialCfg);
  const [screen, setScreen] = useState(isConfigured(initialCfg) ? 'list' : 'setup');
  const [review, setReview] = useState(null);
  const [checks, setChecks] = useState(() => new Set(CHECKS.filter((c) => c.default).map((c) => c.id)));
  const [model, setModel] = useState(initialCfg.llm.model);
  const [theme, setThemeName] = useState(() => setTheme(initialCfg.theme || 'aurora'));
  const bb = useMemo(() => new Bitbucket(cfg), [cfg.bitbucket.baseUrl, cfg.bitbucket.token, cfg.bitbucket.username]);

  const quit = async () => { await bb.close(); exit(); };
  const applyTheme = () => { const n = nextTheme(theme); setTheme(n); term.painter?.retint(); setThemeName(n); const next = JSON.parse(JSON.stringify(cfg)); next.theme = n; saveConfig(next); setCfg(next); };
  const applyEffort = (name) => { const next = JSON.parse(JSON.stringify(cfg)); next.effort = name; saveConfig(next); setCfg(next); };
  /** Persist a model change made in the TUI. Accepts {model, fastModel, models}. */
  const applyModels = (ch) => {
    const next = JSON.parse(JSON.stringify(cfg));
    if (ch.model) { next.llm.model = ch.model; setModel(ch.model); }
    if (ch.fastModel) next.llm.fastModel = ch.fastModel;
    if (ch.models) next.llm.models = ch.models;
    for (const m of [next.llm.model, next.llm.fastModel]) if (m && !next.llm.models.includes(m)) next.llm.models.push(m);
    saveConfig(next); setCfg(next);
    return next;
  };
  const startReview = (pr) => {
    const r = new Review({ cfg, bb, model, checks: [...checks],
      target: { workspace: pr.workspace, repository: pr.repository, id: pr.id, title: pr.title, author: pr.author, src: pr.source_branch, dst: pr.destination_branch } });
    setReview(r); setScreen('confirm');
  };

  const openUrl = async (ref) => {
    try {
      const p = await bb.getPr(ref.workspace, ref.repository, ref.id);
      if (!p || !p.title) return 'Could not read that PR (check the link and your access).';
      startReview({ ...ref, title: p.title, author: p.author, source_branch: p.source_branch, destination_branch: p.destination_branch });
      return null;
    } catch (e) { return e.message.slice(0, 200); }
  };
  useEffect(() => { if (initialPr && isConfigured(cfg)) openUrl(initialPr); }, []);

  if (screen === 'setup') return html`<${Setup} first=${!isConfigured(cfg)} cfg=${cfg} dims=${dims} onCancel=${() => setScreen('list')} onDone=${(c) => { setCfg(c); setModel(c.llm.model); setScreen('list'); }} />`;
  if (screen === 'confirm') return html`<${Confirm} review=${review} cfg=${cfg} dims=${dims} onModels=${(ch) => { applyModels(ch); review.setModels(ch); }} onEffort=${applyEffort} onBack=${() => setScreen('list')} onStart=${() => { review.execute(); setScreen('review'); }} />`;
  if (screen === 'review') return html`<${ReviewScreen} review=${review} cfg=${cfg} dims=${dims} onBack=${() => setScreen(review.fromHistory ? 'history' : 'list')} onUserCancel=${() => setScreen('list')} />`;
  if (screen === 'history') return html`<${History} dims=${dims} bb=${bb} cfg=${cfg} onBack=${() => setScreen('list')} onOpen=${(r) => { setReview(r); setScreen('review'); }} />`;
  return html`<${PrList} bb=${bb} cfg=${cfg} dims=${dims} model=${model} checks=${checks} setChecks=${setChecks}
    onReview=${startReview} onOpenUrl=${openUrl} onSettings=${() => setScreen('setup')} onHistory=${() => setScreen('history')} onQuit=${quit} onModels=${applyModels} onEffort=${applyEffort} onTheme=${applyTheme} />`;
}

function History({ dims, bb, cfg, onBack, onOpen }) {
  const [idx, setIdx] = useState(0);
  const rows = useMemo(() => {
    const out = [];
    try {
      for (const f of fs.readdirSync(RUNS_DIR)) {
        try { const d = JSON.parse(fs.readFileSync(path.join(RUNS_DIR, f), 'utf8')); if (d.findings) out.push(d); } catch {}
      }
    } catch {}
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 50);
  }, []);
  useInput((input, key) => {
    if (key.escape || input === 'q') onBack();
    else if (key.downArrow || input === 'j') setIdx(Math.min(rows.length - 1, idx + 1));
    else if (key.upArrow || input === 'k') setIdx(Math.max(0, idx - 1));
    else if (key.return && rows[idx]) {
      const r = runs.get(rows[idx].id) || Review.rehydrate(rows[idx].id, { cfg, bb });
      if (r) { r.fromHistory = true; if (r.data.status === 'running' || r.data.status === 'ready') r.data.status = 'review'; onOpen(r); }
    }
  });
  const cap = Math.max(3, dims.h - 8);
  const top = Math.min(Math.max(0, idx - Math.floor(cap / 2)), Math.max(0, rows.length - cap));
  return html`<${Frame} dims=${dims} title="past reviews" keys=${[["↑↓","select"],["↵","open"],["esc","back"]]}>
    <${Box} flexDirection="column" paddingX=${2} paddingY=${1}>
      ${!rows.length && html`<${Text} color="gray">No reviews yet.<//>`}
      ${rows.slice(top, top + cap).map((d, k) => {
        const sel = top + k === idx;
        const kept = d.findings.filter((f) => f.verification.verdict !== 'withdrawn').length;
        return html`<${Text} key=${d.id} color=${sel ? C.brand : undefined} bold=${sel}>${sel ? '▌' : ' '} ${trunc(`${d.pr.workspace}/${d.pr.repository}#${d.pr.id}`, 34).padEnd(34)} ${String(kept).padStart(2)} findings · ${String(d.findings.filter((f) => f.status === 'posted').length).padStart(2)} posted · ${ago(d.createdAt).padEnd(8)} ${trunc(d.pr.title || '', Math.max(10, dims.w - 80))}<//>`;
      })}
    <//>
  <//>`;
}
