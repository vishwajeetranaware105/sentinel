import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import { html, C, Frame, InputBox, trunc } from './kit.js';
import { Logo } from './logo.js';
import { importFromOpencode, saveConfig, CONFIG_PATH } from '../config.js';
import { Bitbucket } from '../bitbucket.js';
import { CLI_PROVIDERS, isCli } from '../cli-llm.js';
import { execFileSync } from 'node:child_process';

const FIELDS = [
  { key: 'bbUrl', label: 'Bitbucket Server URL', get: (c) => c.bitbucket.baseUrl, set: (c, v) => (c.bitbucket.baseUrl = v), hint: 'e.g. https://bitbucket.juspay.net' },
  { key: 'bbUser', label: 'Bitbucket username / email', get: (c) => c.bitbucket.username, set: (c, v) => (c.bitbucket.username = v) },
  { key: 'bbTok', label: 'Bitbucket HTTP access token', get: (c) => c.bitbucket.token, set: (c, v) => (c.bitbucket.token = v), secret: true, hint: 'Bitbucket → Profile → Manage account → HTTP access tokens (PR read + write)' },
  { key: 'provider', label: 'Model provider (gateway / claude / codex)', get: (c) => c.llm.provider || 'gateway', set: (c, v) => (c.llm.provider = v), hint: 'gateway = Juspay models · claude = your Claude Code login · codex = your Codex login (no API key needed)' },
  { key: 'llmUrl', label: 'Juspay model gateway URL', get: (c) => c.llm.baseURL, set: (c, v) => (c.llm.baseURL = v), gateway: true },
  { key: 'llmKey', label: 'Juspay model API key', get: (c) => c.llm.apiKey, set: (c, v) => (c.llm.apiKey = v), secret: true, gateway: true },
  { key: 'model', label: 'Review model (strong, used for analysis)', get: (c) => c.llm.model, set: (c, v) => (c.llm.model = v), hint: 'e.g. glm-latest, claude-sonnet-4-6, gemini-3-pro-preview' },
  { key: 'fast', label: 'Cheap model (verification + summary)', get: (c) => c.llm.fastModel, set: (c, v) => (c.llm.fastModel = v), hint: 'e.g. glm-flash-experimental, open-fast — saves tokens' },
  { key: 'root', label: 'Clone repos into', get: (c) => c.workspaceRoot, set: (c, v) => (c.workspaceRoot = v), hint: 'Repos are cloned here on first review for fast local code search' },
  { key: 'budget', label: 'Max tokens per review (0 = unlimited)', get: (c) => String(c.tokenBudget), set: (c, v) => (c.tokenBudget = Math.max(0, parseInt(v, 10) || 0)) },
];

export function Setup({ cfg, onDone, onCancel, dims, first }) {
  const [draft] = useState(() => JSON.parse(JSON.stringify(cfg)));
  const canImport = !!importFromOpencode();
  const [step, setStep] = useState(first && canImport ? -1 : 0);
  const [vals, setVals] = useState(() => Object.fromEntries(FIELDS.map((f) => [f.key, f.get(draft) || ''])));
  const [state, setState] = useState({ phase: 'edit' });
  const cliMode = isCli(vals.provider.trim());
  const skipped = (f) => f.gateway && cliMode;
  const nextStep = (i) => { let n = i + 1; while (n < FIELDS.length && skipped(FIELDS[n])) n++; return n; };

  useInput((input, key) => {
    if (step === -1) {
      if (/^y/i.test(input) || key.return) {
        const imp = importFromOpencode();
        for (const f of FIELDS) {
          const merged = { bitbucket: { ...draft.bitbucket, ...clean(imp.bitbucket) }, llm: { ...draft.llm, ...clean(imp.llm) }, workspaceRoot: draft.workspaceRoot, tokenBudget: draft.tokenBudget };
          vals[f.key] = f.get(merged) || vals[f.key];
        }
        if (imp.llm.models?.length) draft.llm.models = imp.llm.models;
        setVals({ ...vals }); setStep(0);
      } else if (/^n/i.test(input)) setStep(0);
    }
    if (key.escape && !first && state.phase === 'edit') onCancel();
    if (state.phase === 'error' && (key.return || input === 'e')) setState({ phase: 'edit' });
    if (state.phase === 'error' && input === 's') finish(true);
    if (key.upArrow && step > 0 && state.phase === 'edit') { let n = step - 1; while (n > 0 && skipped(FIELDS[n])) n--; setStep(n); }
  });

  async function finish(skipTest = false) {
    const next = JSON.parse(JSON.stringify(draft));
    for (const f of FIELDS) f.set(next, vals[f.key].trim());
    if (!['gateway', 'claude', 'codex'].includes(next.llm.provider)) next.llm.provider = 'gateway';
    const spec = CLI_PROVIDERS[next.llm.provider];
    if (spec && (!spec.models.length ? false : !spec.models.includes(next.llm.model))) { next.llm.model = spec.strong; next.llm.fastModel = spec.fast; next.llm.models = [...spec.models]; }
    if (spec && !spec.models.length) { if (next.llm.model === 'glm-latest') next.llm.model = 'default'; if (next.llm.fastModel === 'glm-flash-experimental') next.llm.fastModel = 'default'; }
    next.bitbucket.baseUrl = next.bitbucket.baseUrl.replace(/\/+$/, '');
    if (!next.llm.models.includes(next.llm.model)) next.llm.models = [next.llm.model, ...next.llm.models];
    if (next.llm.fastModel && !next.llm.models.includes(next.llm.fastModel)) next.llm.models.push(next.llm.fastModel);
    if (!skipTest) {
      setState({ phase: 'testing' });
      const problems = [];
      const bb = new Bitbucket(next);
      try { await bb.reviewerPrs({ limit: 1 }); } catch (e) { problems.push(`Bitbucket: ${trunc(e.message, 160)}`); }
      await bb.close();
      if (isCli(next.llm.provider)) {
        try { execFileSync(CLI_PROVIDERS[next.llm.provider].bin, ['--version'], { stdio: 'pipe', timeout: 15000 }); }
        catch { problems.push(`${CLI_PROVIDERS[next.llm.provider].label}: '${CLI_PROVIDERS[next.llm.provider].bin}' not found or not runnable on PATH`); }
      } else try {
        const r = await fetch(next.llm.baseURL.replace(/\/+$/, '') + '/models', { headers: { authorization: `Bearer ${next.llm.apiKey}` } });
        if (!r.ok) problems.push(`Model gateway answered ${r.status} (check URL / key)`);
      } catch (e) { problems.push(`Model gateway: ${trunc(e.message, 120)}`); }
      if (problems.length) return setState({ phase: 'error', problems });
    }
    saveConfig(next);
    onDone(next);
  }

  const cur = FIELDS[step];
  return html`
    <${Frame} dims=${dims} title=${first ? 'welcome' : 'settings'} keys=${state.phase === 'edit' ? [['↵','next'],['↑','previous'],['esc','cancel']] : [['…','']]}>
      <${Box} flexDirection="column" paddingX=${2} paddingY=${1}>
        ${first && html`<${Box} flexDirection="column" marginBottom=${1}><${Logo} tagline=${false} /><${Box} marginTop=${1}><${Text}>Let's connect Sentinel to Bitbucket and the Juspay models. Nothing is sent anywhere else.<//><//><//>`}
        <${Text} color=${C.dim}>Saved to ${CONFIG_PATH} (mode 600)<//>
        <${Box} marginTop=${1} flexDirection="column">
          ${step === -1 && html`<${Text} color=${C.warn}>Found ~/.config/opencode config. Import Bitbucket + Juspay model settings from it? (Y/n)<//>`}
          ${step >= 0 && FIELDS.map((f, i) => {
            if (skipped(f)) return null;
            const v = vals[f.key];
            const shown = f.secret ? (v ? '•'.repeat(Math.min(v.length, 24)) : '') : v;
            if (i === step && state.phase === 'edit') {
              return html`<${Box} key=${f.key} flexDirection="column" marginY=${0}>
                                <${InputBox} label=${f.label} width=${Math.min(80, dims.w - 8)}><${TextInput} value=${v} mask=${f.secret ? '•' : undefined}
                  onChange=${(nv) => setVals({ ...vals, [f.key]: nv })}
                  onSubmit=${() => { const n = nextStep(i); n >= FIELDS.length ? finish() : setStep(n); }} /><//>
                ${f.hint && html`<${Text} color=${C.dim}>  ${f.hint}<//>`}
              <//>`;
            }
            return html`<${Text} key=${f.key} color=${i < step ? undefined : 'gray'}>${i < step ? '✓' : '·'} ${f.label}: <${Text} color=${C.brand2}>${trunc(shown, dims.w - 50)}<//><//>`;
          })}
        <//>
        ${state.phase === 'testing' && html`<${Box} marginTop=${1}><${Text} color=${C.brand}><${Spinner} type="dots" /><//><${Text}> Testing Bitbucket connection and model gateway (no tokens used)…<//><//>`}
        ${state.phase === 'error' && html`<${Box} marginTop=${1} flexDirection="column">
          <${Text} color=${C.bad} bold>Connection problems:<//>
          ${state.problems.map((p, i) => html`<${Text} key=${i} color=${C.bad}>  • ${p}<//>`)}
          <${Text} color=${C.dim}>↵ edit settings · s save anyway<//>
        <//>`}
      <//>
    <//>`;
}

const clean = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v));
