import React, { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { html, C, Row, InputBox, trunc } from './kit.js';

const NOT_CHAT = /embed|whisper|tts|rerank|moderation|dall|image-gen/i;

/**
 * In-pane picker for the two models: strong (analysis) and cheap (verification + summary).
 * Every selection is saved immediately via onChange({ model | fastModel | models }).
 */
export function ModelPicker({ cfg, width, rows, onChange, onClose }) {
  const [models, setModels] = useState(() => [...new Set([cfg.llm.model, cfg.llm.fastModel, ...cfg.llm.models].filter(Boolean))]);
  const [focus, setFocus] = useState(0); // 0 = analysis, 1 = verification
  const [cursor, setCursor] = useState(() => [Math.max(0, models.indexOf(cfg.llm.model)), Math.max(0, models.indexOf(cfg.llm.fastModel))]);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [live, setLive] = useState('loading'); // loading | ok | fail

  // Free (no tokens): ask the gateway which models exist.
  useEffect(() => {
    let dead = false;
    if (cfg.llm.provider === 'claude' || cfg.llm.provider === 'codex') { setLive('ok'); return; }   // CLI providers: fixed list, nothing to fetch
    fetch(cfg.llm.baseURL.replace(/\/+$/, '') + '/models', { headers: { authorization: `Bearer ${cfg.llm.apiKey}` } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((j) => {
        if (dead) return;
        const ids = (j.data || []).map((m) => m.id).filter((id) => id && !NOT_CHAT.test(id));
        if (ids.length) { setModels((prev) => [...new Set([...prev, ...ids])]); onChange({ models: [...new Set([...cfg.llm.models, ...ids])] }); }
        setLive('ok');
      })
      .catch(() => !dead && setLive('fail'));
    return () => { dead = true; };
  }, []);

  const current = [cfg.llm.model, cfg.llm.fastModel];
  const choose = (m) => { if (m) onChange(focus === 0 ? { model: m } : { fastModel: m }); };

  useInput((input, key) => {
    if (adding) { if (key.escape) { setAdding(false); setName(''); } return; }
    if (key.tab || key.leftArrow || key.rightArrow) setFocus(1 - focus);
    else if (key.downArrow || input === 'j') setCursor((c) => c.map((v, i) => (i === focus ? Math.min(models.length - 1, v + 1) : v)));
    else if (key.upArrow || input === 'k') setCursor((c) => c.map((v, i) => (i === focus ? Math.max(0, v - 1) : v)));
    else if (key.return) choose(models[cursor[focus]]);
    else if (input === 'n') setAdding(true);
    else if (key.escape || input === 'm' || input === 'q') onClose();
  });

  const narrow = width < 58;               // not enough room for two columns: show the focused one full-width
  const colW = narrow ? width - 2 : Math.floor((width - 2) / 2);
  const cap = Math.max(4, rows - (narrow ? 13 : 9));
  const col = (i) => {
    const c = cursor[i];
    const top = Math.min(Math.max(0, c - Math.floor(cap / 2)), Math.max(0, models.length - cap));
    return models.slice(top, top + cap).map((m, k) => {
      const idx = top + k, isCur = idx === c && focus === i, saved = m === current[i];
      return html`<${Row} key=${m} width=${colW} bg=${isCur ? C.sel : undefined}
        segs=${[[isCur ? '›' : ' ', C.brand2], [saved ? ' ● ' : '   ', C.ok], [trunc(m, colW - 5), isCur ? C.tx : saved ? C.tx : C.dim, saved]]} />`;
    });
  };

  return html`
    <${Box} flexDirection="column">
      <${Text} bold color=${C.tx}>Models <${Text} color=${C.mute} bold=${false}>${live === 'loading' ? '· loading gateway list…' : live === 'ok' ? '· live list from gateway' : '· gateway list unavailable, showing saved'}<//><//>
      ${narrow && html`<${Box} flexDirection="column" marginTop=${1}>
        <${Text} color=${C.dim}>Analysis: <${Text} color=${C.tx} bold>${cfg.llm.model}<//><//>
        <${Text} color=${C.dim}>Verify:   <${Text} color=${C.tx} bold>${cfg.llm.fastModel}<//><//>
      <//>`}
      <${Box} marginTop=${1}>
        ${(!narrow || focus === 0) && html`<${Box} flexDirection="column" width=${colW + 1}>
          <${Text} bold color=${focus === 0 ? C.brand : C.dim}>Analysis <${Text} color=${C.mute} bold=${false}>strong${narrow ? ' (tab: switch)' : ''}<//><//>
          ${col(0)}
        <//>`}
        ${(!narrow || focus === 1) && html`<${Box} flexDirection="column" width=${colW + 1}>
          <${Text} bold color=${focus === 1 ? C.brand : C.dim}>Verify + summary <${Text} color=${C.mute} bold=${false}>cheap${narrow ? ' (tab: switch)' : ''}<//><//>
          ${col(1)}
        <//>`}
      <//>
      ${adding
        ? html`<${Box} marginTop=${1}><${InputBox} label="Model name" width=${Math.max(20, width)}><${TextInput} value=${name} onChange=${setName} onSubmit=${(v) => {
            const m = v.trim();
            if (m) { setModels((p) => [...new Set([...p, m])]); onChange({ models: [...new Set([...models, m])], ...(focus === 0 ? { model: m } : { fastModel: m }) }); setCursor((c) => c.map((x, i) => (i === focus ? models.length : x))); }
            setAdding(false); setName('');
          }} /><//><//>`
        : html`<${Box} marginTop=${1} flexDirection="column">
            <${Text} color=${C.dim}><${Text} color=${C.brand2} bold>↵<//> use  <${Text} color=${C.brand2} bold>tab<//> switch column  <${Text} color=${C.brand2} bold>n<//> type a name  <${Text} color=${C.brand2} bold>esc<//> done<//>
            <${Text} color=${C.mute}>Saved as you pick. Keep the cheap column on a small model: it makes the most calls.<//>
          <//>`}
    <//>`;
}
