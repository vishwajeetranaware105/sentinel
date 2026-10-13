import React, { useEffect, useRef, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import Spinner from 'ink-spinner';
import { html, F, C, Grad, Frame, trunc, wrap } from './kit.js';

const STATE_MARK = { working: '…', applied: '✓', no_change: '○', failed: '✕' };
const stateColor = (s) => (s === 'applied' ? C.ok : s === 'failed' ? C.bad : s === 'working' ? C.brand : C.dim);

/** Fix mode for your own PR: open comments -> code changes -> commit -> push. Nothing is committed or pushed without a key press. */
export function FixScreen({ session, dims, onBack, onReview }) {
  const [phase, setPhase] = useState('loading');   // loading | pick | working | review | committed | pushing | pushed
  const [err, setErr] = useState(null);
  const [threads, setThreads] = useState([]);
  const [sel, setSel] = useState(new Set());
  const [idx, setIdx] = useState(0);
  const [states, setStates] = useState({});
  const [diff, setDiff] = useState('');
  const [scroll, setScroll] = useState(0);
  const [note, setNote] = useState('');
  const [confirm, setConfirm] = useState(null);     // 'amend' | 'push' | 'discard'
  const [, tick] = useState(0);
  const tree = useRef(null);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const [list] = await Promise.all([session.load(), (tree.current = session.prepareTree().catch((e) => { throw e; }))]);
        if (!live) return;
        const info = await tree.current;
        setThreads(list); setSel(new Set(list.filter((t) => !t.answered).map((t) => t.id)));
        if (info?.resumed) { setNote(`An earlier commit (${session.committed.sha}) was never pushed. Press p to push it, or d to discard it.`); setPhase('committed'); }
        else setPhase('pick');
      } catch (e) { if (live) { setErr(e.message); setPhase('pick'); } }
    })();
    return () => { live = false; };
  }, []);

  async function run() {
    const ids = threads.filter((t) => sel.has(t.id)).map((t) => t.id);
    if (!ids.length) return setNote('Select at least one comment (space).');
    setErr(null); setNote(''); setPhase('working'); setStates({});
    try {
      await session.proposeFor(ids, ({ id, state }) => setStates((s) => ({ ...s, [id]: state })));
      setDiff(await session.diff()); setScroll(0); setPhase('review');
    } catch (e) { setErr(e.message); setPhase('pick'); }
  }
  async function doCommit(mode) {
    setErr(null);
    try { const c = await session.commit({ mode }); setNote(`${mode === 'amend' ? 'Amended' : 'Committed'} as ${c.sha}. Nothing is pushed yet.`); setPhase('committed'); }
    catch (e) { setErr(e.message); }
  }
  async function doPush() {
    setErr(null); setPhase('pushing');
    try { await session.push(); setPhase('pushed'); }
    catch (e) { setErr(e.message.slice(0, 400)); setPhase('committed'); }
  }
  async function doDiscard() {
    try { await session.discard(); setNote('Changes discarded.'); setStates({}); setPhase('pick'); } catch (e) { setErr(e.message); }
  }

  const diffLines = diff.split('\n');
  const cap = Math.max(5, dims.h - 9);
  useInput((input, key) => {
    if (confirm) {
      if (input === 'y') { const c = confirm; setConfirm(null); if (c === 'amend') doCommit('amend'); else if (c === 'push') doPush(); else if (c === 'discard') doDiscard(); }
      else setConfirm(null);
      return;
    }
    if (phase === 'working' || phase === 'pushing' || phase === 'loading') { if (key.escape && phase === 'loading') onBack(); return; }
    if (phase === 'pick') {
      if (key.escape || input === 'q') onBack();
      else if (key.downArrow || input === 'j') setIdx(Math.min(threads.length - 1, idx + 1));
      else if (key.upArrow || input === 'k') setIdx(Math.max(0, idx - 1));
      else if (input === ' ' && threads[idx]) setSel((s) => { const n = new Set(s); n.has(threads[idx].id) ? n.delete(threads[idx].id) : n.add(threads[idx].id); return n; });
      else if (input === 'a') setSel((s) => (s.size === threads.length ? new Set() : new Set(threads.map((t) => t.id))));
      else if (input === 'v' && onReview) onReview(session.pr);
      else if (key.return && threads.length) run();
    } else if (phase === 'review') {
      if (key.escape) { setPhase('pick'); setNote('Edits are still in the checkout; run again to add more, or press d on the review screen to discard.'); }
      else if (key.downArrow || input === 'j') setScroll(Math.min(Math.max(0, diffLines.length - cap), scroll + 1));
      else if (key.upArrow || input === 'k') setScroll(Math.max(0, scroll - 1));
      else if (key.pageDown) setScroll(Math.min(Math.max(0, diffLines.length - cap), scroll + cap));
      else if (key.pageUp) setScroll(Math.max(0, scroll - cap));
      else if (input === 'c' && diff.trim()) doCommit('new');
      else if (input === 'm' && diff.trim()) setConfirm('amend');
      else if (input === 'd') setConfirm('discard');
    } else if (phase === 'committed') {
      if (input === 'p') setConfirm('push');
      else if (input === 'd') setConfirm('discard');
      else if (key.escape || input === 'q') onBack();
    } else if (phase === 'pushed') { if (key.escape || key.return || input === 'q') onBack(); }
  });

  const pr = session.pr, listW = Math.max(36, Math.floor(dims.w * 0.42)), detW = dims.w - listW - 3;
  const keys = confirm ? [['y', 'yes, do it'], ['any other key', 'cancel']]
    : phase === 'pick' ? [['↑↓', 'move'], ['space', 'select'], ['a', 'all/none'], ['↵', 'fix selected'], ...(onReview ? [['v', 'run Sentinel review']] : []), ['esc', 'back']]
    : phase === 'review' ? [['↑↓', 'scroll diff'], ['c', 'commit'], ['m', 'amend last commit'], ['d', 'discard'], ['esc', 'back']]
    : phase === 'committed' ? [['p', 'push'], ['d', 'discard'], ['esc', 'back']]
    : [['esc', 'back']];
  const cur = threads[Math.min(idx, Math.max(0, threads.length - 1))];
  const results = [...session.results.values()];

  return html`<${Frame} dims=${dims} title=${`fix #${pr.id} · ${trunc(pr.title || '', 40)}`} right=${`${session.src}`} keys=${keys}>
    <${Box} flexDirection="column" paddingX=${1} flexGrow=${1}>
      ${phase === 'loading' && html`<${Text} color=${C.brand}><${Spinner} type="dots" /> Reading comments and checking out ${session.src}…<//>`}
      ${err && html`<${Text} color=${C.bad}>${trunc(err, dims.w - 4)}<//>`}
      ${note && html`<${Text} color=${C.warn}>${trunc(note, dims.w - 4)}<//>`}
      ${confirm && html`<${Text} color=${C.warn} bold>${confirm === 'push' ? `Push ${session.committed?.mode === 'amend' ? '(force-with-lease, rewrites your last commit) ' : ''}to ${session.src} on Bitbucket?` : confirm === 'amend' ? 'Amend your last commit? This rewrites history and needs a force push; reviewers may see their comments move to an older version.' : 'Discard the changes?'} y/N<//>`}
      ${phase === 'pick' && html`<${Box} gap=${2}>
        <${Box} flexDirection="column" width=${listW}>
          ${!threads.length && !err && html`<${Text} color=${C.dim}>Nothing to fix yet: no Sentinel findings and no open comments.\nPress v to run a Sentinel review of this PR (bugs, breaking changes).<//>`}
          ${threads.slice(Math.max(0, Math.min(idx - 4, threads.length - cap)), Math.max(0, Math.min(idx - 4, threads.length - cap)) + cap).map((t, k0) => {
            const k = Math.max(0, Math.min(idx - 4, threads.length - cap)) + k0, on = k === idx;
            return html`<${Text} key=${t.id} color=${on ? C.tx : C.dim} bold=${on}>${on ? '▌' : ' '} ${sel.has(t.id) ? '◉' : '○'} ${trunc(t.source === 'finding' ? `${t.label}` : (t.path ? `${t.path.split('/').pop()}:${t.line || ''}` : 'general') + `  ${t.messages[0]?.who || ''}`, listW - 16)}${t.answered ? '  (you replied)' : ''}${t.source === 'thread' && t.task ? '  [task]' : ''}<//>`;
          })}
        <//>
        <${Box} flexDirection="column" width=${detW}>
          ${cur && html`<${F}><${Text} color=${C.brand2}>${cur.source === 'finding' ? 'Sentinel finding · ' : 'Comment · '}${cur.path || 'general'}${cur.line ? `:${cur.line}` : ''}<//>
            ${cur.messages.slice(-4).flatMap((m) => [html`<${Text} key=${'w' + m.id} color=${C.dim} bold>${session.isMine(m) ? 'you' : m.who}<//>`, ...wrap(m.text, detW - 2).slice(0, 8).map((l, i) => html`<${Text} key=${m.id + ':' + i} color=${C.tx}>${l}<//>`)])}<//>`}
        <//>
      <//>`}
      ${phase === 'working' && html`<${Box} flexDirection="column">
        <${Text} color=${C.brand}><${Spinner} type="dots" /> Fixing the selected comments, one at a time…<//>
        ${threads.filter((t) => sel.has(t.id)).map((t) => html`<${Text} key=${t.id} color=${stateColor(states[t.id])}>${STATE_MARK[states[t.id]] || '·'} ${trunc(`${t.path || 'general'}:${t.line || ''}`, dims.w - 8)}<//>`)}
      <//>`}
      ${(phase === 'review' || phase === 'committed' || phase === 'pushing' || phase === 'pushed') && html`<${Box} flexDirection="column">
        ${results.map((r) => html`<${Box} key=${r.thread} flexDirection="column">
          <${Text} color=${stateColor(r.status)}>${STATE_MARK[r.status]} ${trunc(r.where, 40)}  <${Text} color=${C.tx}>${trunc(r.status === 'applied' ? r.summary : r.status === 'failed' ? `could not apply: ${(r.failed || []).join('; ')}` : `no code change. Suggested reply: ${r.reply}`, dims.w - 52)}<//><//>
        <//>`)}
        ${phase === 'review' && html`<${Box} flexDirection="column" marginTop=${1}>
          ${!diff.trim() ? html`<${Text} color=${C.dim}>No file changes were produced.<//>` : diffLines.slice(scroll, scroll + cap).map((l, i) => html`<${Text} key=${i} color=${l.startsWith('+') && !l.startsWith('+++') ? C.ok : l.startsWith('-') && !l.startsWith('---') ? C.bad : l.startsWith('@@') ? C.info : C.dim}>${trunc(l, dims.w - 4)}<//>`)}
        <//>`}
        ${phase === 'committed' && html`<${Box} marginTop=${1} flexDirection="column"><${Text} color=${C.tx}>Commit ${session.committed?.sha} is ready${session.committed?.mode === 'amend' ? ' (amended)' : ''}. Press p to push it to ${session.src}.<//><${Text} color=${C.dim}>Message: ${trunc(session.defaultMessage().split('\n')[0], 60)}<//><//>`}
        ${phase === 'pushing' && html`<${Text} color=${C.brand}><${Spinner} type="dots" /> Pushing…<//>`}
        ${phase === 'pushed' && html`<${Box} marginTop=${1} flexDirection="column"><${Grad} text=${`Pushed to ${session.src}. The PR now shows the new code.`} bold /><${Text} color=${C.dim}>Reply to each reviewer on the PR (Sentinel does not post for you here). Suggested replies are above.<//><//>`}
      <//>`}
    <//>
  <//>`;
}
