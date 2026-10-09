/**
 * Paints a black → dark graphite vertical gradient behind the whole UI and makes frame writes flicker-free.
 *
 * Ink can't set a background for empty cells, so we post-process each frame it writes: every line gets a
 * per-row background colour, re-applied after any colour reset Ink emits, and `ESC[K` (erase-to-EOL, which
 * fills with the current background) pads the rest of the row. Each frame is wrapped in synchronized-output
 * markers (DEC 2026) so supporting terminals apply it atomically instead of showing the erase/redraw.
 */
export const GRADIENT_TOP = [0, 0, 0];
export let GRADIENT_BOTTOM = [22, 22, 26];
/** Theme switch: change the colour the background fades to (applies from the next frame). */
export const setBackgroundBottom = (rgb) => { GRADIENT_BOTTOM = rgb; };

const lerp = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

export function bgCode(rgb, truecolor) {
  if (truecolor) return `\x1b[48;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
  const avg = (rgb[0] + rgb[1] + rgb[2]) / 3 + 6;             // 256-colour terminals: nearest grey-ramp step
  return `\x1b[48;5;${Math.min(255, Math.max(232, 232 + Math.round((avg - 8) / 10)))}m`;
}

export function installPainter(out, { truecolor = /truecolor|24bit/i.test(process.env.COLORTERM || '') } = {}) {
  const orig = out.write.bind(out);
  const rowBg = (i, n) => bgCode(lerp(GRADIENT_TOP, GRADIENT_BOTTOM, n > 1 ? i / (n - 1) : 0), truecolor);
  out.write = (data, ...rest) => {
    if (typeof data !== 'string' || !data.includes('\n')) return orig(data, ...rest);
    // Ink prefixes a frame with erase/cursor sequences; keep those untouched.
    const m = data.match(/^((?:\x1b\[(?:2K|1A|G|[23]J|H)|\x1b\[\?25[lh])*)([\s\S]*)$/);
    const lines = m[2].split('\n');
    const n = out.rows || lines.length;
    const painted = lines.map((ln, i) => {
      if (i === lines.length - 1 && ln === '') return ln;
      const bg = rowBg(i, n);
      return bg + ln.replace(/\x1b\[(?:0|49)?m/g, (x) => x + bg) + '\x1b[K';
    }).join('\n');
    return orig(`\x1b[?2026h${m[1]}${painted}\x1b[?2026l`, ...rest);
  };
  const hexOf = () => '#' + GRADIENT_BOTTOM.map((v) => v.toString(16).padStart(2, '0')).join('');
  return {
    /** Fill the freshly-entered alternate screen so rows outside the frame match. */
    prime: () => orig(`${bgCode(GRADIENT_BOTTOM, truecolor)}\x1b[2J\x1b[H`),
    /** Re-set the terminal's default background after a theme change (OSC 11). */
    retint: () => orig(`\x1b]11;${hexOf()}\x07`),
    restore: () => { out.write = orig; },
    get bottomHex() { return hexOf(); },
  };
}
