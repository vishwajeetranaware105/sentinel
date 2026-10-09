import React, { useEffect, useMemo, useState, useReducer } from 'react';
import { Box, Text, useStdout } from 'ink';
import htm from 'htm';
import { setBackgroundBottom } from './paint.js';

export const html = htm.bind(React.createElement);
export const F = React.Fragment;

// ---- theme: black background with a soft tint of the accent at the bottom, and a 3-stop accent gradient (no indigo)
export const THEMES = {
  aurora: { label: 'Aurora', stops: ['#22d3ee', '#2dd4bf', '#4ade80'], bottom: [3, 28, 30] },     // cyan -> teal -> green (default)
  ocean:  { label: 'Ocean',  stops: ['#7dd3fc', '#38bdf8', '#22d3ee'], bottom: [4, 20, 34] },     // sky blues
  ember:  { label: 'Ember',  stops: ['#ff5a1f', '#ff8a1f', '#ffc23d'], bottom: [38, 18, 4] },     // red-orange -> amber
  mono:   { label: 'Mono',   stops: ['#ffffff', '#d4d4d8', '#9a9aa6'], bottom: [22, 22, 26] },    // white -> grey
};
const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
export const mix = (a, b, t) => '#' + hex(a).map((v, i) => Math.round(v + (hex(b)[i] - v) * t).toString(16).padStart(2, '0')).join('');
export function gradientAt(stops, t) {
  const n = stops.length - 1;
  const x = Math.min(0.999999, Math.max(0, t)) * n, i = Math.floor(x), f = x - i;
  return mix(stops[i], stops[i + 1], f);
}

export const C = {
  bg: '#000000', panel: '#141414', sel: '#1d2a2c', line: '#2c3436',
  tx: '#f2f2f4', dim: '#9a9fa6', mute: '#565c63',
  brand: '#2dd4bf', brand2: '#22d3ee', stops: THEMES.aurora.stops,
  ok: '#3ddc97', warn: '#ffd23f', bad: '#ff5d73', info: '#6aa9ff',
};
export function setTheme(name) {
  const key = THEMES[name] ? name : 'aurora', t = THEMES[key];
  C.stops = t.stops; C.brand = t.stops[1]; C.brand2 = t.stops[0];
  C.sel = mix('#0c0c0e', t.stops[1], 0.2);                 // selected-row bar: dark, tinted by the accent
  C.line = mix('#1c1c20', t.stops[1], 0.22);
  setBackgroundBottom(t.bottom);
  return key;
}
export const nextTheme = (name) => { const k = Object.keys(THEMES); return k[(k.indexOf(name) + 1) % k.length]; };
export const SEV = { blocker: C.bad, major: C.warn, minor: C.info };
export const KIND_LABEL = { bug: 'Bug', breaking: 'Breaking', suggestion: 'Suggestion', reply: 'Reply' };

/** Gradient text across the theme's stops; `step` chars share a colour so wide rules stay cheap. */
export function Grad({ text, bold = false, step = 1, stops }) {
  const st = stops || C.stops;
  const parts = useMemo(() => {
    const out = [], chars = [...text];
    for (let i = 0; i < chars.length; i += step) out.push([chars.slice(i, i + step).join(''), gradientAt(st, chars.length > 1 ? i / (chars.length - 1) : 0)]);
    return out;
  }, [text, step, st.join()]);
  return html`<${Text}>${parts.map(([t, c], i) => html`<${Text} key=${i} color=${c} bold=${bold}>${t}<//>`)}<//>`;
}

export const trunc = (s, n) => { s = String(s ?? '').replace(/\s+/g, ' '); return s.length > n ? s.slice(0, Math.max(0, n - 1)) + '…' : s; };
export const pad = (s, n) => String(s).padEnd(n).slice(0, n);

export function wrap(str, w) {
  w = Math.max(10, w);
  const out = [];
  for (const para of String(str ?? '').split('\n')) {
    if (!para.trim()) { out.push(''); continue; }
    let line = '';
    for (const word of para.split(/\s+/)) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= w) line += ' ' + word;
      else { out.push(line); line = word; }
      while (line.length > w) { out.push(line.slice(0, w)); line = line.slice(w); }
    }
    out.push(line);
  }
  return out;
}

export const ago = (iso) => {
  const s = (Date.now() - new Date(iso)) / 1000;
  return s < 3600 ? `${Math.max(1, Math.round(s / 60))}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};

export function useDims() {
  const { stdout } = useStdout();
  const read = () => ({ w: stdout.columns || 100, h: stdout.rows || 30 });
  const [d, setD] = useState(read);
  useEffect(() => { const f = () => setD(read()); stdout.on('resize', f); return () => stdout.off('resize', f); }, [stdout]);
  return d;
}

export function useReview(review) {
  const [, bump] = useReducer((x) => x + 1, 0);
  useEffect(() => {
    if (!review) return;
    let t = null;
    const on = () => { if (!t) t = setTimeout(() => { t = null; bump(); }, 120); };
    review.on('event', on);
    return () => { review.off('event', on); clearTimeout(t); };
  }, [review]);
}

/** One screen line made of coloured segments, optionally padded to `width` with a highlight background. */
export function Row({ segs, width, bg }) {
  const len = segs.reduce((n, s) => n + [...s[0]].length, 0);
  return html`<${Text} backgroundColor=${bg}>${segs.map(([t, color, bold], i) => html`<${Text} key=${i} color=${color} bold=${bold}>${t}<//>`)}${width && bg ? ' '.repeat(Math.max(0, width - len)) : ''}<//>`;
}

export function Badge({ text, color = C.brand, solid = true }) {
  return solid ? html`<${Text} backgroundColor=${color} color=${C.bg} bold> ${text} <//>` : html`<${Text} color=${color} bold>${text}<//>`;
}

export function Bar({ value, max, width = 20 }) {
  const frac = max > 0 ? Math.min(1, value / max) : 0;
  const filled = Math.round(frac * width);
  const cells = [];
  for (let i = 0; i < width; i++) cells.push(html`<${Text} key=${i} color=${i < filled ? (frac > 0.85 ? gradientAt(['#ffd23f', '#ff5d73'], i / Math.max(1, width - 1)) : gradientAt(C.stops, i / Math.max(1, width - 1))) : C.mute}>${i < filled ? '█' : '░'}<//>`);
  return html`<${Text}>${cells}<//>`;
}

/** Key hint pills: [['↵','review'],['q','quit']] */
export function Keys({ keys }) {
  return html`<${Text}>${keys.map(([k, label], i) => html`<${Text} key=${i}><${Text} color=${C.brand2} bold>${k}<//><${Text} color=${C.dim}> ${label}   <//><//>`)}<//>`;
}

export function Frame({ title, children, keys, footer, dims, right }) {
  return html`
    <${Box} flexDirection="column" width=${dims.w} height=${dims.h - 1}>
      <${Box} paddingX=${1} justifyContent="space-between">
        <${Box}><${Grad} text="▟█▙ SENTINEL" bold /><${Text} color=${C.dim}>  PR reviewer<//><${Text} color=${C.mute}>  ›  <//><${Text} color=${C.tx} bold>${title}<//><//>
        <${Text} color=${C.dim}>${right || ''}<//>
      <//>
      <${Box} paddingX=${1}><${Grad} text=${'━'.repeat(Math.max(10, dims.w - 2))} step=${3} /><//>
      <${Box} flexGrow=${1} flexDirection="column">${children}<//>
      <${Box} paddingX=${1}>${keys ? html`<${Keys} keys=${keys} />` : html`<${Text} color=${C.dim}>${footer}<//>`}<//>
    <//>`;
}

/** Text-entry field with a gradient border. `label` sits in the top edge; children is the <TextInput/>. */
export function InputBox({ label, width, children }) {
  const inner = Math.max(12, width - 2);
  const head = `╭─ ${label} `;
  const top = head + '─'.repeat(Math.max(1, inner - head.length + 1)) + '╮';
  return html`<${Box} flexDirection="column" width=${inner + 2}>
    <${Grad} text=${top} step=2 />
    <${Box}><${Text} color=${C.stops[0]}>│<//><${Box} width=${inner} paddingX=${1}><${Text} color=${C.stops[1]} bold>❯ <//>${children}<//><${Text} color=${C.stops[2]}>│<//><//>
    <${Grad} text=${'╰' + '─'.repeat(inner) + '╯'} step=2 />
  <//>`;
}
