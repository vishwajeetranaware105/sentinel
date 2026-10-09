import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { html, F, C, SEV, KIND_LABEL, Frame, Bar, Row, Badge, Grad, InputBox, trunc, wrap, ago, useReview } from './kit.js';
import { fmt, cleanComment } from '../review.js';
import { editExternally } from './term.js';
import { ModelPicker } from './models.js';

function RepoLine({ repo }) {
  if (!repo || repo.state === 'idle') return html`<${Text} color=${C.dim}>Code on disk      waiting…<//>`;
  if (repo.state === 'fetching') return html`<${Text}>Code on disk      <${Text} color=${C.brand}><${Spinner} type="dots" /> fetching the PR branch and the latest ${repo.base || 'target branch'}<//><//>`;
  if (repo.state === 'ready') return html`<${Text}>Code on disk      <${Text} color=${C.ok}>✓ ready<//> <${Text} color=${C.dim}>PR branch @${repo.headSha || '?'} · latest ${repo.base || 'main'} @${repo.baseSha || '?'}<//><//>`;
  return html`<${Text}>Code on disk      <${Text} color=${C.warn}>⚠ unavailable (${trunc(repo.reason || '', 70)}) — will use Bitbucket search, no caller scan<//><//>`;
}

// ---------------------------------------------------------------- estimate / confirm (zero tokens spent so far)
export function Confirm({ review, cfg, dims, onStart, onBack, onModels, onEffort }) {
  useReview(review);
  const [err, setErr] = useState(null);
  const [picking, setPicking] = useState(false);
  const d = review.data, e = d.estimate;
  useEffect(() => { if (d.status === 'preparing') review.prepare().catch((x) => setErr(x.message)); }, [review]);
  useInput((input, key) => {
    if (picking) return;
    if (key.escape || input === 'b') { review.cancel(); onBack(); }
    if (input === 'm' && e) setPicking(true);
    if (input === 'e' && e) { const o = ['low', 'medium', 'high']; const n = o[(o.indexOf(d.effort) + 1) % 3]; review.setEffort(n); onEffort?.(n); }
    if (key.return && e && !err && !d.blocked) onStart();
  });
  const over = e && cfg.tokenBudget > 0 && e.totalTokens > cfg.tokenBudget;
  return html`
    <${Frame} dims=${dims} title=${`#${d.pr.id} · ${trunc(d.pr.title || '', 50)}`} keys=${picking ? [['↵','use'],['tab','switch column'],['esc','done']] : e ? [d.blocked ? ['—','cannot review this PR'] : ['↵','start review'],['e','effort'],['m','models'],['esc','back']] : [['esc','cancel']]}>
      <${Box} flexDirection="column" paddingX=${2} paddingY=${1}>
        ${picking && html`<${ModelPicker} cfg=${cfg} width=${Math.min(dims.w - 8, 90)} rows=${dims.h - 4} onChange=${onModels} onClose=${() => setPicking(false)} />`}
        ${!picking && !e && !err && html`<${Text} color=${C.brand}><${Spinner} type="dots" /> Fetching the full diff (free — no model tokens)…<//>`}
        ${!picking && err && html`<${Text} color=${C.bad}>Could not prepare: ${err}<//>`}
        ${!picking && e && html`<${F}>
          <${Text} bold>Ready to review <${Text} color=${C.brand2}>${d.pr.workspace}/${d.pr.repository} #${d.pr.id}<//><//>
          <${Text} color=${C.dim}>${d.pr.src} → ${d.pr.dst} · by ${d.pr.author || '?'}<//>
          ${(d.notices || []).map((n, k) => html`<${Text} key=${k} color=${n.level === 'bad' ? C.bad : n.level === 'warn' ? C.warn : C.dim}>${n.level === 'info' ? '·' : '⚠'} ${n.text}<//>`)}
          <${Box} marginTop=${1} flexDirection="column">
            <${Text} bold color=${C.tx}>PR description<//>
            ${descLines(d.pr.description, dims.w - 8, Math.max(3, Math.min(8, dims.h - 26))).map((l, k) => html`<${Text} key=${k} color=${C.dim}>${l}<//>`)}
          <//>
          <${Box} marginTop=${1} flexDirection="column">
            <${Text}>Files changed     <${Text} bold>${e.files}<//><//>
            <${Text}>Will be reviewed  <${Text} bold>${e.reviewable}<//> ${e.skipped ? html`<${Text} color=${C.dim}>(${e.skipped} skipped: generated / docs / strings / binary)<//>` : ''}<//>
            ${e.truncated ? html`<${Text} color=${C.warn}>${e.truncated} very large file${e.truncated === 1 ? '' : 's'} trimmed to the first 500 diff lines<//>` : ''}
            <${Text}>Review chunks     <${Text} bold>${e.chunks}<//> ${e.cachedChunks ? html`<${Text} color=${C.ok}>(${e.cachedChunks} cached — free)<//>` : ''}<//>
            <${RepoLine} repo=${d.repo} />
            <${Text}>Guidelines       ${(d.guidelines || []).length ? html`<${Text} color=${C.ok}>${d.guidelines.join(', ')}<//>` : html`<${Text} color=${C.dim}>${d.repo?.state === 'ready' ? 'none found (CLAUDE.md / AGENTS.md / CONTRIBUTING.md)' : 'checking…'}<//>`}<//>
            <${Text}>Discussion       ${d.discussion ? html`<${Text}>${d.discussion.total} thread${d.discussion.total === 1 ? '' : 's'} · ${d.discussion.open} open · <${Text} color=${d.discussion.needReply ? C.warn : C.dim}>${d.discussion.needReply} awaiting your reply<//><//>` : html`<${Text} color=${C.dim}>not available<//>`}<//>
            <${Text}>Review depth     <${Text} bold color=${C.brand2}>${d.effort}<//> <${Text} color=${C.dim}>(show findings scoring ≥ ${review.effort.min}/100${review.effort.passes > 1 ? ', two independent readers' : ''})<//><//>
            <${Text}>Models           analysis <${Text} color=${C.brand2}>${d.model}<//> · verify/summary <${Text} color=${C.brand2}>${d.verifyModel}<//><//>
          <//>
          <${Box} marginTop=${1} flexDirection="column">
            <${Text} bold>Estimated tokens: ~${fmt(e.totalTokens)} <${Text} color=${C.dim} bold=${false}>(analysis ~${fmt(e.analyzeTokens)} + verification ≤${fmt(e.verifyTokens)})<//><//>
            <${Box}><${Bar} value=${e.totalTokens} max=${cfg.tokenBudget || e.totalTokens} width=${30} /><${Text} color=${C.dim}>  budget ${cfg.tokenBudget ? fmt(cfg.tokenBudget) : 'unlimited'}<//><//>
            ${over && html`<${Text} color=${C.warn}>Over budget: lowest-risk files will be skipped when the cap is reached. Raise it in settings (s on the PR list).<//>`}
            <${Text} color=${C.dim}>Every comment is verified against the code, scored 0-100 and vetted before you see it. Token savers on: cache, cheap verifier model, no model call for clean summaries.<//>
          <//>
          <${Box} marginTop=${1}><${Text} color=${C.ok} bold>Press ↵ to start. Nothing is posted until you approve it.<//><//>
        <//>`}
      <//>
    <//>`;
}

// ---------------------------------------------------------------- running + findings
const sevOrder = { blocker: 0, major: 1, minor: 2 };
const FILTERS = ['all', 'bug', 'breaking', 'suggestion', 'replies', 'threads', 'withdrawn'];
const ROLE_LABEL = { me: 'you', author: 'PR author', other: 'reviewer', bot: 'bot' };
const roleColor = (r) => (r === 'me' ? C.brand : r === 'author' ? C.warn : r === 'bot' ? C.mute : C.info);

function descLines(text, w, max) {
  const raw = String(text || '').replace(/\r/g, '').replace(/[*_`#>]/g, '').replace(/https?:\/\/\S+/g, (u) => (u.length > 40 ? u.slice(0, 37) + '…' : u));
  const lines = wrap(raw.trim() || '(no description provided)', w).filter((l, i, a) => l || (a[i - 1] && a[i + 1]));
  return lines.length > max ? [...lines.slice(0, max - 1), '…'] : lines;
}

function itemsFor(d, filter) {
  if (filter === 'threads') return (d.discussion?.threads || []).map((t) => ({ ...t, isThread: true }));
  const live = d.findings.filter((f) => f.verification.verdict !== 'withdrawn');
  const list = filter === 'replies' ? live.filter((f) => f.kind === 'reply') : filter === 'withdrawn' ? d.findings.filter((f) => f.verification.verdict === 'withdrawn')
    : live.filter((f) => filter === 'all' || f.kind === filter);
  list.sort((a, b) => (sevOrder[a.severity] ?? 3) - (sevOrder[b.severity] ?? 3) || String(a.file).localeCompare(String(b.file)) || (a.line || 0) - (b.line || 0));
  return d.summary && filter === 'all' ? [{ summary: true }, ...list] : list;
}

export function ReviewScreen({ review, cfg, dims, onBack, onUserCancel }) {
  useReview(review);
  const d = review.data;
  const [filter, setFilter] = useState('all');
  const [idx, setIdx] = useState(0);
  const [scroll, setScroll] = useState(0);
  const [mode, setMode] = useState('browse'); // browse | edit | confirm | posting | result
  const [draft, setDraft] = useState('');
  const [result, setResult] = useState(null);
  const [drafting, setDrafting] = useState(null);   // null | { id } | { error }

  const items = itemsFor(d, filter);
  const i = Math.min(idx, Math.max(0, items.length - 1));
  const cur = items[i];
  const running = d.status === 'running' || d.status === 'preparing';
  const approved = d.findings.filter((f) => f.status === 'approved');
  const sumPost = d.summary && d.summary.post && d.summary.text && !d.summary.posted;
  const nPost = approved.length + (sumPost ? 1 : 0);
  const save = () => review.persist();

  useInput((input, key) => {
    if (mode === 'edit') {
      if (key.escape) setMode('browse');
      return;
    }
    if (mode === 'confirm') {
      if (input === 'y' || key.return) {
        setMode('posting');
        review.post({ includeSummary: !!sumPost }).then((r) => { setResult(r); setMode('result'); }).catch((e) => { setResult([{ ok: false, error: e.message }]); setMode('result'); });
      } else if (input === 'n' || key.escape) setMode('browse');
      return;
    }
    if (mode === 'result') { setMode('browse'); return; }
    if (mode === 'posting') return;

    if (running) { if (key.escape) { review.cancel(); onUserCancel(); } return; }
    if (key.escape || input === 'q') return onBack();
    if (key.downArrow || input === 'j') { setIdx(Math.min(items.length - 1, i + 1)); setScroll(0); }
    else if (key.upArrow || input === 'k') { setIdx(Math.max(0, i - 1)); setScroll(0); }
    else if (input === 'd' || key.pageDown) setScroll(scroll + 5);
    else if (input === 'u' || key.pageUp) setScroll(Math.max(0, scroll - 5));
    else if (key.tab || input === 'f') { setFilter(FILTERS[(FILTERS.indexOf(filter) + 1) % FILTERS.length]); setIdx(0); setScroll(0); }
    else if (input === 'r' && cur?.isThread && !drafting?.id) {
      setDrafting({ id: cur.id });
      review.draftReply(cur.id).then(() => { setDrafting(null); setFilter('replies'); setIdx(9999); setScroll(0); })
        .catch((e) => setDrafting({ error: e.message }));
    }
    else if (input === 'a' && cur && !cur.isThread) {
      if (cur.summary) { d.summary.post = !d.summary.post; save(); }
      else if (cur.status !== 'posted') { cur.status = cur.status === 'approved' ? 'pending' : 'approved'; save(); }
    } else if (input === 'x' && cur && !cur.summary && !cur.isThread && cur.status !== 'posted') { cur.status = cur.status === 'rejected' ? 'pending' : 'rejected'; save(); }
    else if (input === 't' && cur && !cur.summary && !cur.isThread && cur.kind !== 'reply' && cur.status !== 'posted') { cur.asTask = !cur.asTask; save(); }
    else if (input === 'e' && cur && !cur.isThread && cur.status !== 'posted') {
      const start = cur.summary ? d.summary.text : cur.body;
      const out = editExternally(start);
      if (out === null) { setDraft(start); setMode('edit'); }          // no usable $EDITOR: fall back to the one-line editor
      else if (out.trim()) { const v = cleanComment(out); if (cur.summary) d.summary.text = v; else cur.body = v; save(); }
      setScroll(0);
    }
    else if (input === 'A') {
      for (const f of d.findings) if (f.status === 'pending' && f.kind !== 'reply' && f.verification.verdict === 'confirmed') f.status = 'approved';
      save();
    } else if (input === 'p' && nPost) setMode('confirm');
  });

  const leftW = Math.max(34, Math.floor(dims.w * 0.4));
  const rightW = dims.w - leftW - 4;
  const bodyH = dims.h - 6;
  const usage = d.usage || { total: 0, budget: cfg.tokenBudget };
  const tokens = `${fmt(usage.total || 0)}${cfg.tokenBudget ? ` / ${fmt(cfg.tokenBudget)}` : ''} tok`;

  if (running || d.status === 'error' || d.status === 'cancelled') {
    return html`
      <${Frame} dims=${dims} title=${`#${d.pr.id} · ${trunc(d.pr.title || '', 50)}`} right=${tokens} keys=${running ? [['esc','cancel review']] : [['esc','back']]}>
        <${Box} flexDirection="column" paddingX=${2} paddingY=${1}>
          ${d.stages.map((s) => html`<${Box} key=${s.id}>
            <${Text} color=${s.state === 'done' ? C.ok : s.state === 'active' ? C.brand : 'gray'}>
              ${s.state === 'done' ? '✓' : s.state === 'active' ? html`<${Spinner} type="dots" />` : '·'} ${s.label}<//>
            <${Text} color=${C.dim}>  ${s.detail || ''}<//><//>`)}
          <${Box} marginTop=${1}><${Bar} value=${usage.total || 0} max=${cfg.tokenBudget || usage.total || 1} width=${30} /><${Text} color=${C.dim}>  ${tokens}${usage.estimated ? ' (est.)' : ''}<//><//>
          ${(d.live || []).length > 0 && html`<${Box} marginTop=${1} flexDirection="column">
            <${Text} color=${C.dim}>Model activity<//>
            ${d.live.map((c) => html`<${Text} key=${c.id}><${Text} color=${C.brand}><${Spinner} type="dots" /><//><${Text} color=${C.tx}> ${trunc(c.label || 'call', 28)}<//> <${Text} color=${C.dim}>${c.model} · <//><${Text} color=${c.phase === 'writing' ? C.ok : c.phase === 'thinking' ? C.warn : C.dim}>${c.phase}<//><${Text} color=${C.dim}> · ${c.tokens > 0 ? c.tokens + ' tok · ' : ''}${Math.round((Date.now() - c.t0) / 1000)}s<//><//>`)}
          <//>`}
          <${Box} marginTop=${1} flexDirection="column">
            ${d.log.slice(-Math.max(3, bodyH - 12 - (d.live || []).length)).map((l, k) => html`<${Text} key=${k} color=${C.dim}>${trunc(l.msg, dims.w - 6)}<//>`)}
          <//>
          ${d.status === 'error' && html`<${Text} color=${C.bad} bold>Failed: ${d.error}<//>`}
          ${d.status === 'cancelled' && html`<${Text} color=${C.warn}>Cancelled.<//>`}
        <//>
      <//>`;
  }

  // ---- findings view
  const lines = drafting ? [drafting.error ? { t: `Could not draft a reply: ${drafting.error}`, color: C.bad } : { t: 'Drafting a reply with the cheap model (reads the thread and the current code)…', color: C.warn }]
    : cur ? detailLines(cur, d, rightW - 5) : [];
  const maxScroll = Math.max(0, lines.length - (bodyH - 2));
  const sc = Math.min(scroll, maxScroll);
  const cap = Math.max(3, Math.floor((bodyH - 3) / 2));
  const top = Math.min(Math.max(0, i - Math.floor(cap / 2)), Math.max(0, items.length - cap));
  const count = (k) => (k === 'threads' ? (d.discussion?.threads || []).length : k === 'withdrawn' ? d.findings.filter((f) => f.verification.verdict === 'withdrawn').length
    : d.findings.filter((f) => f.verification.verdict !== 'withdrawn' && (k === 'all' || f.kind === k)).length);
  const rec = d.summary?.recommendation;

  return html`
    <${Frame} dims=${dims} title=${`#${d.pr.id} · ${trunc(d.pr.title || '', 46)}`} right=${tokens}
      keys=${mode === 'edit' ? [['↵','save'],['esc','cancel']] : mode === 'confirm' ? [['y','post'],['n','back']] : [['↑↓','move'],['a','approve'],['x','reject'],['e','edit'],['t','comment/task'],['r','reply to thread'],['f','tab'],['d/u','scroll'],['p','post'],['esc','back']]}>
      <${Box} paddingX=${1}>
        ${FILTERS.map((f) => html`<${Text} key=${f} color=${f === filter ? C.brand : 'gray'} bold=${f === filter}>${f === filter ? '[' : ' '}${f} ${count(f)}${f === filter ? ']' : ' '} <//>`)}
        <${Text} color=${C.dim}> │ <${Text} color=${C.ok}>${approved.length} approved<//> · ${d.findings.filter((f) => f.status === 'posted').length} posted<//>
      <//>
      <${Box} flexGrow=${1}>
        <${Box} flexDirection="column" width=${leftW} paddingX=${1}>
          ${!items.length && html`<${Text} color=${C.dim}>${filter === 'all' ? 'No issues found. 🎉' : filter === 'threads' ? 'No comments on this PR yet.' : filter === 'replies' ? 'No replies drafted. Open a thread and press r.' : 'Nothing here.'}<//>`}
          ${items.slice(top, top + cap).map((f, k) => {
            const sel = top + k === i;
            const bg = sel ? C.sel : undefined, w = leftW - 2;
            if (f.summary) return html`<${Box} key="sum" flexDirection="column">
              <${Row} width=${w} bg=${bg} segs=${[[sel ? '▌' : ' ', C.brand2], [' Review summary', C.tx, true]]} />
              <${Row} width=${w} bg=${bg} segs=${[[sel ? '▌' : ' ', C.brand2], ['   ' + (rec === 'blocked' ? 'Blocked' : rec === 'approve' ? 'Looks good' : 'Needs work') + (d.summary.post ? '' : ' (not posting)'), rec === 'blocked' ? C.bad : rec === 'approve' ? C.ok : C.warn]]} />
            <//>`;
            if (f.isThread) {
              const col = f.resolved ? C.ok : C.warn;
              return html`<${Box} key=${'t' + f.id} flexDirection="column">
                <${Row} width=${w} bg=${bg} segs=${[[sel ? '▌' : ' ', C.brand2], [` ${f.resolved ? '✓' : '○'} `, col, true], [f.task && !f.resolved ? 'TASK ' : '', C.bad, true], [trunc(f.path ? `${f.path.split('/').pop()}${f.line ? ':' + f.line : ''}` : 'general comment', w - 12), sel ? C.tx : undefined, sel]]} />
                <${Row} width=${w} bg=${bg} segs=${[[sel ? '▌' : ' ', C.brand2], ['     ', C.dim], [`${f.messages.length} msg · ${ROLE_LABEL[f.last.role]} ${ago(new Date(f.last.at).toISOString())}`, C.dim], [f.needsReply ? '  reply?' : '', C.warn, true]]} />
              <//>`;
            }
            const mark = f.status === 'posted' ? '✔' : f.status === 'approved' ? '✓' : f.status === 'rejected' ? '✕' : '○';
            const mcol = f.status === 'approved' || f.status === 'posted' ? C.ok : f.status === 'rejected' ? C.bad : C.mute;
            return html`<${Box} key=${f.id} flexDirection="column">
              <${Row} width=${w} bg=${bg} segs=${[[sel ? '▌' : ' ', C.brand2], [` ${mark} `, mcol, true], [f.severity.slice(0, 5).toUpperCase().padEnd(5) + ' ', SEV[f.severity], true], [trunc(f.title, w - 12), sel ? C.tx : undefined, sel]]} />
              <${Row} width=${w} bg=${bg} segs=${[[sel ? '▌' : ' ', C.brand2], ['       ' + trunc(`${(f.file || '').split('/').pop()}${f.line ? ':' + f.line : ''} · ${KIND_LABEL[f.kind]}${f.verification.verdict === 'confirmed' ? ' · verified' : ''}${f.score != null ? ` · ${f.score}` : ''}`, w - 9), C.dim]]} />
            <//>`;
          })}
        <//>
        <${Box} flexDirection="column" width=${rightW} paddingX=${1} borderStyle="single" borderColor="gray" borderTop=${false} borderBottom=${false} borderRight=${false}>
          ${mode === 'edit' ? html`<${F}>
            <${Text} bold color=${C.brand}>Edit comment<//>
            <${InputBox} label="Comment" width=${rightW - 2}><${TextInput} value=${draft} onChange=${setDraft} onSubmit=${(v) => {
              if (!v.trim()) return setMode('browse');
              if (cur.summary) d.summary.text = v.trim(); else cur.body = v.trim();
              save(); setMode('browse');
            }} /><//>
          <//>` : mode === 'confirm' || mode === 'posting' || mode === 'result' ? html`<${F}>
            <${Text} bold color=${C.brand}>${mode === 'result' ? 'Posted' : `Post ${nPost} item${nPost === 1 ? '' : 's'} to PR #${d.pr.id}?`}<//>
            ${mode === 'confirm' && html`<${Box} flexDirection="column" marginTop=${1}>
              <${Text} color=${C.dim}>They will appear as you. Tasks block merge until resolved.<//>
              ${approved.slice(0, bodyH - 8).map((f) => html`<${Text} key=${f.id}>${f.kind === 'reply' ? html`<${Text} color=${C.brand2}>reply<//>` : f.asTask ? html`<${Text} color=${C.bad}>TASK<//>` : html`<${Text} color=${C.info}>note<//>`} ${trunc(`${(f.file || '').split('/').pop()}${f.line ? ':' + f.line : ''} ${f.body}`, rightW - 10)}<//>`)}
              ${sumPost && html`<${Text}><${Text} color=${C.info}>note<//> summary: ${trunc(d.summary.text, rightW - 18)}<//>`}
              <${Box} marginTop=${1}><${Text} color=${C.ok} bold>y post · n back<//><//>
            <//>`}
            ${mode === 'posting' && html`<${Text} color=${C.brand}><${Spinner} type="dots" /> Posting…<//>`}
            ${mode === 'result' && html`<${Box} flexDirection="column" marginTop=${1}>
              <${Text} color=${C.ok}>${result.filter((r) => r.ok).length} posted<//>
              ${result.filter((r) => !r.ok).map((r, k) => html`<${Text} key=${k} color=${C.bad}>✕ ${trunc(r.error || 'failed', rightW - 4)}<//>`)}
              <${Text} color=${C.dim}>any key to continue<//>
            <//>`}
          <//>` : lines.slice(sc, sc + bodyH - 2).map((l, k) => html`<${Box} key=${k} flexShrink=${0}><${Text} color=${l.color} bold=${l.bold} backgroundColor=${l.bg} dimColor=${l.dim}>${l.t || ' '}<//><//>`)}
          ${mode === 'browse' && maxScroll > 0 && html`<${Text} color=${C.dim}>  ↓ d/u to scroll (${sc + 1}-${Math.min(lines.length, sc + bodyH - 2)}/${lines.length})<//>`}
        <//>
      <//>
    <//>`;
}

function conversation(msgs, w, add) {
  for (const m of msgs) {
    add(`${m.who}  ·  ${ROLE_LABEL[m.role] || m.role}${m.severity === 'BLOCKER' ? '  ·  task' : ''}${m.at ? `  ·  ${ago(new Date(m.at).toISOString())}` : ''}`, { color: roleColor(m.role), bold: true });
    String(m.text || '').split('\n').forEach((para) => wrap(para, w - 2).forEach((t) => add('  ' + t, { color: m.role === 'bot' ? C.mute : undefined })));
    add('');
  }
}

function detailLines(f, d, w) {
  const L = [];
  const add = (t, o = {}) => L.push({ t, ...o });
  if (f.isThread) {
    add(f.path ? `${f.path}${f.line ? ':' + f.line : ''}` : 'General comment', { color: C.brand2, bold: true });
    add(`${f.resolved ? 'Resolved' : 'Open'}${f.task ? ' · task' : ''} · ${f.messages.length} message${f.messages.length === 1 ? '' : 's'}${f.needsReply ? ' · you took part and got a reply' : ''}`, { color: f.resolved ? C.ok : C.warn });
    add('');
    conversation(f.messages, w, add);
    const reply = d.findings.find((x) => x.kind === 'reply' && x.thread === f.id);
    add(reply ? `A reply draft exists (Replies tab): ${reply.status}.` : 'Press r to draft a reply to this thread.', { color: C.brand2 });
    return L;
  }
  if (f.kind === 'reply') {
    add(`Reply to ${f.reply.to}`, { color: C.brand, bold: true });
    add(f.file ? `${f.file}${f.line ? ':' + f.line : ''}` : 'general thread', { color: C.brand2 });
    add(''); add('Conversation', { bold: true });
    conversation(f.reply.conversation, w, add);
    add('Draft reply  (posts inside this thread; e to edit in your editor)', { bold: true });
    f.body.split('\n').forEach((para) => wrap(para, w).forEach((t) => add(t)));
    add('');
    add(`  status: ${f.status}`, { dim: true });
    add(`Why: ${f.verification.reason || 'follow-up on your thread'}`, { dim: true });
    (f.verification.evidence || []).forEach((e) => { add(`$ ${trunc(e.query, w - 2)}`, { color: C.brand2, dim: true }); String(e.result).split('\n').slice(0, 12).forEach((t) => add('  ' + trunc(t, w - 2), { dim: true })); });
    if (f.postError) add(`Post failed: ${f.postError}`, { color: C.bad });
    return L;
  }
  if (f.summary) {
    add('Review summary', { bold: true, color: C.brand }); add('');
    wrap(d.summary.text, w).forEach((t) => add(t));
    if (d.summary.gates) {
      add(''); add('Gates', { bold: true });
      for (const [k, v] of Object.entries(d.summary.gates)) { const pass = /^pass/i.test(v); wrap(`${pass ? '✓' : '✕'} ${k}: ${v}`, w).forEach((t) => add(t, { color: pass ? C.ok : C.bad })); }
    }
    add(''); add(d.summary.post ? 'Will be posted as a normal comment (a toggles).' : 'Not posting the summary (a toggles).', { dim: true });
    return L;
  }
  const v = f.verification;
  add(`${f.severity.toUpperCase()} · ${KIND_LABEL[f.kind]} · ${f.score != null ? `score ${f.score}/100` : `${Math.round(f.confidence * 100)}% model confidence`}`, { color: SEV[f.severity], bold: true });
  wrap(f.title, w).forEach((t) => add(t, { bold: true }));
  add(f.line ? `${f.file}:${f.line}` : `${f.file} (general comment — no diff line)`, { color: C.brand2 });
  if (f.excerpt?.length) {
    add('');
    f.excerpt.forEach((l, k) => add(trunc(`${String(l.no ?? '').padStart(5)} ${l.type === 'ADDED' ? '+' : ' '} ${l.text}`, w), { color: l.type === 'ADDED' ? C.ok : undefined, bg: k === f.focus ? '#3a3320' : undefined }));
  }
  if (f.failureScenario) { add(''); add('Fails when', { bold: true }); wrap(f.failureScenario, w).forEach((t) => add(t, { color: C.warn })); }
  add(''); add('Comment to post  (e to edit in your editor)', { bold: true });
  f.body.split('\n').forEach((para) => wrap(para, w).forEach((t) => add(t)));
  add('');
  add(`  ${f.asTask ? '○' : '●'} Comment      ${f.asTask ? '●' : '○'} Task (blocks merge until resolved)      t to switch`, { color: f.asTask ? C.bad : C.info, bold: true });
  add(`  status: ${f.status}`, { dim: true });
  add('');
  add(`Verification: ${v.verdict}`, { bold: true, color: v.verdict === 'confirmed' ? C.ok : v.verdict === 'withdrawn' ? C.bad : C.warn });
  wrap(v.reason || 'no notes', w).forEach((t) => add(t, { dim: true }));
  if (f.gate) { add(''); add(`Vetting: ${f.gate.appropriate === false ? 'rejected' : f.gate.appropriate ? 'appropriate to post' : 'not vetted'}`, { bold: true, color: f.gate.appropriate === false ? C.bad : f.gate.appropriate ? C.ok : C.warn }); wrap(f.gate.reason || '', w).forEach((t) => add(t, { dim: true })); }
  (v.evidence || []).forEach((e) => { add(`$ ${e.op} ${trunc(e.query, w - 4)}`, { color: C.brand2, dim: true }); e.result.split('\n').slice(0, 6).forEach((t) => add('  ' + trunc(t, w - 2), { dim: true })); });
  if (f.postError) add(`Post failed: ${f.postError}`, { color: C.bad });
  return L;
}
