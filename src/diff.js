/** Unified-diff parsing, noise filtering, chunking and line lookup. */

const NOISE = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|Podfile\.lock|poetry\.lock|go\.sum|packages\.dhall)$/,
  /(^|\/)docs\/memory-bank\//,
  /\.(min\.js|map|snap|png|jpg|jpeg|gif|webp|ico|svg|pdf|ttf|otf|woff2?|so|a|jar|aar|zip)$/i,
  /(^|\/)(dist|build|node_modules|\.gradle|generated)\//,
];
export const isNoise = (p) => NOISE.some((re) => re.test(p));

// Rarely hold bugs but cost tokens: docs, localisation strings, fixtures. Skipped unless nothing else is left.
const LOW_VALUE = [
  /\.(md|mdx|txt|rst|adoc)$/i,
  /(^|\/)(strings?|i18n|l10n|locales?|translations?)(\/|\.)/i,
  /(^|\/)(Strings|values-[a-z-]+)\/.+\.(js|xml|json|strings)$/,
  /(^|\/)(fixtures?|__snapshots__|testdata|mocks?)\//i,
  /(^|\/)(LICENSE|CHANGELOG|CODEOWNERS|\.gitignore)/,
];
export const isLowValue = (p) => LOW_VALUE.some((re) => re.test(p));

/** Higher = review first, so a budget cut-off drops the least important files. */
export function riskScore(f) {
  let s = Math.min(f.added + f.removed, 400) / 40;
  if (/\.(kt|java|swift|rs|cpp|cc|c|h|go|py|ts|tsx|js|jsx|purs|hs|rb)$/.test(f.path)) s += 5;
  if (/(auth|crypto|session|token|payment|attest|scan|envelope|native|jni|migration|sql|security|key)/i.test(f.path)) s += 6;
  if (/(^|\/)(test|tests|spec|__tests__)\//i.test(f.path)) s -= 3;
  return s;
}

const MAX_FILE_LINES = 500;
/** Cap a single huge file's diff; the rest is reported as truncated rather than silently paid for. */
export function capFile(f) {
  let n = 0; const hunks = [];
  for (const h of f.hunks) {
    if (n >= MAX_FILE_LINES) { f = { ...f, truncated: true }; break; }
    hunks.push(h); n += h.lines.length;
  }
  return hunks.length === f.hunks.length ? f : { ...f, hunks, truncated: true };
}

/** Diff text within `radius` destination lines of `line`, for the verifier (small, targeted context). */
export function windowFor(file, line, radius = 30, maxChars = 5000) {
  if (!file) return '';
  const hunks = file.hunks.filter((h) => h.lines.some((l) => l.new != null && Math.abs(l.new - line) <= radius));
  const sel = hunks.length ? hunks : file.hunks.slice(0, 1);
  const out = [];
  for (const h of sel) for (const l of h.lines) {
    if (l.new != null && Math.abs(l.new - line) > radius) continue;
    out.push(l.type === 'REMOVED' ? `     - ${l.text}` : `${String(l.new).padStart(5)} ${l.type === 'ADDED' ? '+' : ' '} ${l.text}`);
  }
  return out.join('\n').slice(0, maxChars);
}

export function parseDiff(text) {
  const files = [];
  if (typeof text !== 'string') return files;
  let file = null, hunk = null, oldNo = 0, newNo = 0;
  for (const raw of text.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const m = raw.match(/^diff --git (?:a\/|src:\/\/)(.+?) (?:b\/|dst:\/\/)(.+)$/);
      file = { path: m ? m[2] : raw.slice(11), oldPath: m?.[1], status: 'modified', hunks: [], added: 0, removed: 0 };
      files.push(file); hunk = null; continue;
    }
    if (!file) continue;
    if (raw.startsWith('new file mode')) { file.status = 'added'; continue; }
    if (raw.startsWith('deleted file mode')) { file.status = 'deleted'; continue; }
    if (raw.startsWith('rename from')) { file.status = 'renamed'; continue; }
    if (raw.startsWith('Binary files')) { file.binary = true; continue; }
    if (raw.startsWith('--- ') && !hunk) continue;
    if (raw.startsWith('+++ ') && !hunk) {
      if (raw.slice(4) !== '/dev/null') file.path = raw.slice(4).replace(/^(?:b\/|dst:\/\/)/, '');
      continue;
    }
    const h = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (h) { oldNo = +h[1]; newNo = +h[2]; hunk = { header: raw, lines: [] }; file.hunks.push(hunk); continue; }
    if (!hunk) continue;
    const c = raw[0];
    if (c === '+') { hunk.lines.push({ type: 'ADDED', new: newNo++, text: raw.slice(1) }); file.added++; }
    else if (c === '-') { hunk.lines.push({ type: 'REMOVED', old: oldNo++, text: raw.slice(1) }); file.removed++; }
    else if (c === ' ') { hunk.lines.push({ type: 'CONTEXT', old: oldNo++, new: newNo++, text: raw.slice(1) }); }
  }
  return files;
}

/** Render a file's diff with explicit destination line numbers so the model can cite them. */
export function renderFile(file) {
  const out = [`### FILE: ${file.path}  (${file.status}, +${file.added} -${file.removed})`];
  for (const h of file.hunks) {
    out.push(h.header);
    for (const l of h.lines) {
      const t = l.text.length > 240 ? l.text.slice(0, 240) + ' …' : l.text;        // minified / generated lines cost tokens for nothing
      if (l.type === 'REMOVED') out.push(`     - ${t}`);
      else out.push(`${String(l.new).padStart(5)} ${l.type === 'ADDED' ? '+' : ' '} ${t}`);
    }
  }
  return out.join('\n');
}

/** Split files into prompt-sized chunks (by characters); oversized single files get split by hunk. */
export function chunkFiles(files, maxChars = 45000) {
  const chunks = [];
  let cur = [], size = 0;
  const flush = () => { if (cur.length) { chunks.push(cur); cur = []; size = 0; } };
  for (const f of files) {
    const full = renderFile(f);
    if (full.length > maxChars) {
      flush();
      let part = { ...f, hunks: [] }, psz = 0;
      for (const h of f.hunks) {
        const hs = renderFile({ ...f, hunks: [h] }).length;
        if (psz + hs > maxChars && part.hunks.length) { chunks.push([part]); part = { ...f, hunks: [] }; psz = 0; }
        part.hunks.push(h); psz += hs;
      }
      if (part.hunks.length) chunks.push([part]);
      continue;
    }
    if (size + full.length > maxChars) flush();
    cur.push(f); size += full.length;
  }
  flush();
  return chunks;
}

/** Find how a destination line can be anchored in the diff (ADDED/CONTEXT) and grab surrounding lines. */
export function locate(files, filePath, line) {
  const f = files.find((x) => x.path === filePath) || files.find((x) => x.path.endsWith('/' + filePath) || filePath.endsWith('/' + x.path));
  if (!f) return null;
  for (const h of f.hunks) {
    const i = h.lines.findIndex((l) => l.new === line && l.type !== 'REMOVED');
    if (i >= 0) {
      const slice = h.lines.slice(Math.max(0, i - 3), i + 4);
      return { path: f.path, lineType: h.lines[i].type, text: h.lines[i].text, excerpt: slice.map((l) => ({ type: l.type, no: l.new ?? null, text: l.text })), focus: Math.min(3, i) };
    }
  }
  return { path: f.path, lineType: null, text: null, excerpt: [], focus: 0 };
}

/** Nearest commentable line in a file when the model's line number is off. */
export function nearestAnchor(files, filePath, line, snippet) {
  const f = files.find((x) => x.path === filePath);
  if (!f) return null;
  const all = f.hunks.flatMap((h) => h.lines).filter((l) => l.type !== 'REMOVED');
  if (snippet) {
    const s = snippet.trim();
    const hit = all.find((l) => l.text.trim() === s) || all.find((l) => s.length > 6 && l.text.includes(s));
    if (hit) return hit.new;
  }
  let best = null;
  for (const l of all) if (best === null || Math.abs(l.new - line) < Math.abs(best - line)) best = l.new;
  return best;
}
