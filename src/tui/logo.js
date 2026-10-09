import React from 'react';
import { Box, Text } from 'ink';
import { html, C, mix, gradientAt } from './kit.js';

/**
 * Sentinel logo, drawn on a pixel grid and rendered with half-block characters (2 pixel rows per text row).
 * Pixels: 0 empty, 1 outline, 2 body. The check mark is cut out of the body.
 */
const W = 21, H = 22;

function shieldPixels() {
  const px = Array.from({ length: H }, () => Array(W).fill(0));
  const cx = (W - 1) / 2;
  for (let y = 0; y < H; y++) {
    const hw = y === 0 ? 7 : y === 1 ? 8.5 : y < 12 ? 9.5 : 9.5 * Math.pow(1 - (y - 12) / (H - 12 + 0.5), 0.85);
    for (let x = 0; x < W; x++) if (Math.abs(x - cx) <= hw) px[y][x] = 1;
  }
  const out = px.map((r) => r.slice());
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (!px[y][x]) continue;
    const edge = [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]].some(([dx, dy]) => !px[y + dy]?.[x + dx]);
    out[y][x] = edge ? 1 : 2;
  }
  const stroke = (x0, y0, x1, y1) => {
    const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)) * 3;
    for (let i = 0; i <= n; i++) {
      const x = Math.round(x0 + ((x1 - x0) * i) / n), y = Math.round(y0 + ((y1 - y0) * i) / n);
      for (let a = 0; a < 2; a++) for (let b = 0; b < 2; b++) if (out[y + b]?.[x + a] !== undefined) out[y + b][x + a] = 0;
    }
  };
  stroke(5, 10, 9, 14); stroke(9, 14, 16, 6);
  return out;
}

const FONT = {
  S: ['.###', '#...', '.##.', '...#', '###.'], E: ['####', '#...', '###.', '#...', '####'], N: ['#..#', '##.#', '#.##', '#..#', '#..#'],
  T: ['####', '.##.', '.##.', '.##.', '.##.'], I: ['###', '.#.', '.#.', '.#.', '###'], L: ['#...', '#...', '#...', '#...', '####'],
};
function wordPixels(word) {
  const rows = Array.from({ length: 6 }, () => []);
  [...word].forEach((ch, i) => {
    const g = FONT[ch];
    for (let r = 0; r < 6; r++) { if (i) rows[r].push(0); for (const c of g[r] || '....') rows[r].push(c === '#' ? 1 : 0); if (!g[r]) rows[r].length -= 4; if (!g[r]) for (let k = 0; k < g[0].length; k++) rows[r].push(0); }
  });
  return rows;
}

/** Pixel grid -> text rows of runs [{t, fg, bg}] using ▀ ▄ █ and fg/bg for two-tone cells. */
function toRuns(grid, color) {
  const rows = [];
  for (let r = 0; r < grid.length; r += 2) {
    const runs = [];
    const push = (t, fg, bg) => { const l = runs[runs.length - 1]; if (l && l.fg === fg && l.bg === bg) l.t += t; else runs.push({ t, fg, bg }); };
    for (let x = 0; x < grid[0].length; x++) {
      const a = grid[r][x], b = grid[r + 1]?.[x] ?? 0;
      const ca = a && color(a, x, r), cb = b && color(b, x, r + 1);
      if (!a && !b) push(' ');
      else if (a && b && ca === cb) push('█', ca);
      else if (a && b) push('▀', ca, cb);
      else if (a) push('▀', ca);
      else push('▄', cb);
    }
    rows.push(runs);
  }
  return rows;
}

const Line = ({ runs }) => html`<${Text}>${runs.map((r, i) => html`<${Text} key=${i} color=${r.fg} backgroundColor=${r.bg}>${r.t}<//>`)}<//>`;

const shieldColor = (stops) => (v, x, y) => { const c = gradientAt(stops, y / (H - 1)); return v === 1 ? c : mix('#000000', c, 0.42); };
const wordColor = (stops) => (v, x) => gradientAt(stops, x / 33);

/** Big logo: shield on the left, wordmark + tagline on the right. */
export function Logo({ tagline = true }) {
  const shield = toRuns(shieldPixels(), shieldColor(C.stops));
  const word = toRuns(wordPixels('SENTINEL'), wordColor(C.stops));
  const padRows = 4;      // vertically centre the wordmark beside the shield
  return html`<${Box}>
    <${Box} flexDirection="column">${shield.map((r, i) => html`<${Line} key=${i} runs=${r} />`)}<//>
    <${Box} flexDirection="column" marginLeft=${3}>
      ${Array.from({ length: padRows }, (_, i) => html`<${Text} key=${'p' + i}> <//>`)}
      ${word.map((r, i) => html`<${Line} key=${i} runs=${r} />`)}
      ${tagline && html`<${Box} flexDirection="column" marginTop=${1}>
        <${Text} color=${C.tx} bold>terminal PR reviewer<//>
        <${Text} color=${C.dim}>verified · scored · you approve<//>
      <//>`}
    <//>
  <//>`;
}

/** Plain-ANSI version for non-interactive output (--help). */
export function logoText(stops = C.stops) {
  const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)).join(';');
  const fg = (h) => `\x1b[38;2;${rgb(h)}m`, reset = '\x1b[0m';
  const color = stops[1];
  const shield = toRuns(shieldPixels(), shieldColor(stops));
  const word = toRuns(wordPixels('SENTINEL'), wordColor(stops));
  return shield.map((runs, i) => {
    const left = runs.map((r) => (r.fg ? fg(r.fg) + (r.bg ? `\x1b[48;2;${rgb(r.bg)}m` : '') : '') + r.t + reset).join('');
    const wi = i - 4;
    const right = wi >= 0 && wi < word.length ? word[wi].map((r) => fg(r.fg || color) + r.t + reset).join('') : '';
    return left + '   ' + right;
  }).join('\n');
}
