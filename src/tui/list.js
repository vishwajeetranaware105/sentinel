import { term } from './term.js';
import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { html, F, C, Grad, Row, Badge, Frame, InputBox, trunc, wrap, ago } from './kit.js';
import { CHECKS, profileFor } from '../checks.js';
import { parsePrUrl } from '../bitbucket.js';
import { ModelPicker } from './models.js';
import { Logo } from './logo.js';

const TABS = [['review', 'Review requested'], ['mine', 'My PRs']];

export function PrList({ bb, cfg, dims, model, checks, setChecks, onReview, onOpenUrl, onSettings, onHistory, onQuit, onModels, onEffort, onTheme }) {
  const [data, setData] = useState({ review: null, mine: null });
  const [err, setErr] = useState({});
  const [tab, setTab] = useState('review');
  const [idx, setIdx] = useState(0);
  const [filter, setFilter] = useState('');
  const [mode, setMode] = useState('browse'); // browse | filter | checks | url
  const [ci, setCi] = useState(0);
  const [url, setUrl] = useState('');
  const [urlState, setUrlState] = useState({ busy: false, error: null });

  const load = (which = ['review', 'mine']) => {
    for (const t of which) {
      setData((d) => ({ ...d, [t]: null })); setErr((e) => ({ ...e, [t]: null }));
      bb.listPrs(t === 'review' ? 'REVIEWER' : 'AUTHOR')
        .then((prs) => setData((d) => ({ ...d, [t]: prs })))
        .catch((e) => { setErr((x) => ({ ...x, [t]: e.message })); setData((d) => ({ ...d, [t]: [] })); });
    }
  };
  useEffect(() => { load(); }, [bb]);

  const prs = data[tab];
  const matches = (prs || []).filter((p) => !filter || `${p.title} ${p.workspace}/${p.repository} ${p.author}`.toLowerCase().includes(filter.toLowerCase()));
  // group by repo, newest-activity group first, newest PR first inside
  const groups = useMemo(() => {
    const m = new Map();
    for (const p of matches) { const k = `${p.workspace}/${p.repository}`; (m.get(k) || m.set(k, []).get(k)).push(p); }
    return [...m].map(([name, list]) => ({ name, list: list.sort((a, b) => b.updated_on.localeCompare(a.updated_on)) }))
      .sort((a, b) => b.list[0].updated_on.localeCompare(a.list[0].updated_on));
  }, [prs, filter]);
  const flat = groups.flatMap((g) => g.list);
  const i = Math.min(idx, Math.max(0, flat.length - 1));
  const pr = flat[i];

  useInput((input, key) => {
    if (mode === 'models') return; // the picker handles its own keys
    if (mode === 'url') {
      if (key.escape) { setMode('browse'); setUrl(''); setUrlState({ busy: false, error: null }); }
      return;
    }
    if (mode === 'filter') { if (key.return || key.escape) setMode('browse'); return; }
    if (mode === 'checks') {
      if (key.escape || input === 'c' || key.return) setMode('browse');
      else if (key.downArrow || input === 'j') setCi(Math.min(CHECKS.length - 1, ci + 1));
      else if (key.upArrow || input === 'k') setCi(Math.max(0, ci - 1));
      else if (input === ' ') { const n = new Set(checks); const id = CHECKS[ci].id; n.has(id) ? n.delete(id) : n.add(id); setChecks(n); }
      return;
    }
    if (key.downArrow || input === 'j') setIdx(Math.min(flat.length - 1, i + 1));
    else if (key.upArrow || input === 'k') setIdx(Math.max(0, i - 1));
    else if (key.tab || input === '1' || input === '2') { setTab(input === '1' ? 'review' : input === '2' ? 'mine' : tab === 'review' ? 'mine' : 'review'); setIdx(0); }
    else if (input === '/') setMode('filter');
    else if (input === 'u' || input === 'o') setMode('url');
    else if (input === 'c') setMode('checks');
    else if (input === 'r') load([tab]);
    else if (input === 'm') setMode('models');
    else if (input === 'T') onTheme();
    else if (input === 'U' && term.update) { term.updateRequested = true; onQuit(); }
    else if (input === 'e') { const o = ['low', 'medium', 'high']; onEffort(o[(o.indexOf(cfg.effort || 'medium') + 1) % 3]); }
    else if (input === 's') onSettings();
    else if (input === 'h') onHistory();
    else if (input === 'q') onQuit();
    else if (key.return && pr) onReview(pr);
  });

  async function submitUrl(v) {
    const parsed = parsePrUrl(v);
    if (!parsed) return setUrlState({ busy: false, error: 'Not a Bitbucket PR link. Try …/projects/KEY/repos/repo/pull-requests/123 or KEY/repo#123' });
    setUrlState({ busy: true, error: null });
    const e = await onOpenUrl(parsed);
    if (e) setUrlState({ busy: false, error: e });
  }

  // ---- layout
  const listW = Math.max(40, Math.floor(dims.w * 0.48));
  const detW = dims.w - listW - 3;
  const cap = Math.max(4, dims.h - 9 - (mode === 'url' || mode === 'filter' ? 3 : 0));
  // build entries with line heights, then window around the selection
  const entries = []; let top = 0, selTop = 0;
  for (const g of groups) {
    entries.push({ t: 'g', g, top, h: 1 }); top += 1;
    for (const p of g.list) { if (p === pr) selTop = top; entries.push({ t: 'p', p, top, h: 2 }); top += 2; }
  }
  const start = Math.min(Math.max(0, selTop - Math.floor(cap / 3) - 1), Math.max(0, top - cap));
  const visible = entries.filter((e) => e.top >= start && e.top + e.h <= start + cap);
  const prof = pr && profileFor(pr.repository);
  const counts = { review: data.review?.length, mine: data.mine?.length };

  const keys = mode === 'filter' ? [['type', 'filter'], ['↵', 'done']]
    : mode === 'url' ? [['↵', 'open PR'], ['esc', 'cancel']]
    : mode === 'models' ? [['↵', 'use'], ['tab', 'switch column'], ['n', 'type name'], ['esc', 'done']]
    : mode === 'checks' ? [['↑↓', 'move'], ['space', 'toggle'], ['esc', 'done']]
    : [['↵', 'review'], ['u', 'link'], ['tab', 'lists'], ['/', 'filter'], ['c', 'checks'], ['m', 'models'], ['e', 'effort'], ['T', 'theme'], ['r', 'refresh'], ['h', 'history'], ['s', 'settings'], ['q', 'quit']];

  return html`
    <${Frame} dims=${dims} title=${TABS.find((t) => t[0] === tab)[1]} right=${`${term.update ? `⬆ ${term.update} available · U to update   ` : ''}${model} · verify ${cfg.llm.fastModel} · effort ${cfg.effort || 'medium'}`} keys=${keys}>
      <${Box} paddingX=${1} gap=${2}>
        ${TABS.map(([id, label]) => html`<${Text} key=${id} color=${id === tab ? C.tx : C.dim} bold=${id === tab} underline=${id === tab}>${label} <${Text} color=${id === tab ? C.brand2 : C.mute}>${counts[id] ?? '…'}<//><//>`)}
        ${filter && mode !== 'filter' ? html`<${Text} color=${C.warn}>filter: ${filter}<//>` : ''}
      <//>
      ${mode === 'filter' && html`<${Box} paddingX=${1}><${InputBox} label="Filter" width=${Math.min(70, dims.w - 4)}><${TextInput} value=${filter} onChange=${(v) => { setFilter(v); setIdx(0); }} placeholder="title, repo or author" /><//><//>`}
      ${mode === 'url' && html`<${Box} paddingX=${1} flexDirection="column">
        <${InputBox} label="PR link" width=${Math.min(90, dims.w - 4)}><${TextInput} value=${url} onChange=${setUrl} onSubmit=${submitUrl} placeholder="paste https://…/pull-requests/123 or KEY/repo#123" /><//>
        ${urlState.busy && html`<${Text} color=${C.brand}><${Spinner} type="dots" /> Opening PR…<//>`}
        ${urlState.error && html`<${Text} color=${C.bad}>${trunc(urlState.error, dims.w - 4)}<//>`}
      <//>`}
      <${Box} flexGrow=${1}>
        <${Box} flexDirection="column" width=${listW} paddingX=${1}>
          ${prs === null && html`<${Text} color=${C.brand}><${Spinner} type="dots" /> Loading…<//>`}
          ${err[tab] && html`<${Text} color=${C.bad}>Could not load: ${trunc(err[tab], listW - 4)}<//>`}
          ${prs && !err[tab] && !flat.length && html`<${Text} color=${C.dim}>${prs.length ? 'No matches.' : tab === 'review' ? 'Nothing is waiting on your review. 🎉' : 'You have no open PRs.'}<//>`}
          ${visible.map((e) => {
            if (e.t === 'g') return html`<${Box} key=${e.g.name}><${Grad} text=${`▾ ${trunc(e.g.name, listW - 12)}`} bold /><${Text} color=${C.mute}>  ${e.g.list.length}<//><//>`;
            const p = e.p, sel = p === pr, bg = sel ? C.sel : undefined, w = listW - 2;
            const meta = tab === 'review' ? p.author : `${(p.reviewers || []).length} reviewers`;
            return html`<${Box} key=${p.workspace + p.repository + p.id} flexDirection="column">
              <${Row} width=${w} bg=${bg} segs=${[[sel ? '▌' : ' ', C.brand2], [` #${p.id} `, sel ? C.brand2 : C.dim], [trunc(p.title, w - String(p.id).length - 5), sel ? C.tx : undefined, sel]]} />
              <${Row} width=${w} bg=${bg} segs=${[[sel ? '▌' : ' ', C.brand2], ['     ' + trunc(`${meta} · ${ago(p.updated_on)}`, w - 8), C.dim]]} />
            <//>`;
          })}
        <//>
        <${Box} flexDirection="column" width=${detW} paddingX=${2} borderStyle="single" borderColor=${C.line} borderTop=${false} borderBottom=${false} borderRight=${false}>
          ${mode === 'models' ? html`<${ModelPicker} cfg=${cfg} width=${detW - 4} rows=${dims.h - 6} onChange=${onModels} onClose=${() => setMode('browse')} />`
          : pr ? html`<${F}>
            <${Text} color=${C.brand2}>${pr.workspace} / ${pr.repository}<//>
            ${wrap(pr.title, detW - 2).slice(0, 3).map((l, k) => html`<${Text} key=${k} bold color=${C.tx}>${l}<//>`)}
            <${Text} color=${C.dim}>#${pr.id} · ${pr.author} · ${ago(pr.updated_on)}<//>
            <${Text} color=${C.dim}>${pr.source_branch} <${Text} color=${C.mute}>→<//> ${pr.destination_branch}<//>
            <${Text} color=${C.dim}>Reviewers: ${trunc((pr.reviewers || []).join(', ') || 'none', detW - 14)}<//>
            ${prof && html`<${Box} marginTop=${1}><${Badge} text="GATED" color=${C.warn} /><${Text} color=${C.warn}> ${prof.label}<//><//>`}
            <${Box} marginTop=${1} flexDirection="column">
              <${Text} bold color=${mode === 'checks' ? C.brand : C.tx}>Checks <${Text} color=${C.mute} bold=${false}>c to edit<//><//>
              ${CHECKS.map((c, k) => html`<${Text} key=${c.id} color=${mode === 'checks' && k === ci ? C.brand : checks.has(c.id) ? C.tx : C.mute}>${mode === 'checks' && k === ci ? '›' : ' '} ${checks.has(c.id) ? '◉' : '○'} ${c.label}<//>`)}
            <//>
            <${Box} marginTop=${1}><${Grad} text="↵  Review this PR  →" bold /><//>
          <//>` : html`<${Box} flexDirection="column" marginTop=${1}><${Logo} /><${Box} marginTop=${2}><${Text} color=${C.dim}>Pick a PR on the left, or press <${Text} color=${C.brand2} bold>u<//> to paste a PR link.<//><//><//>`}
        <//>
      <//>
    <//>`;
}
