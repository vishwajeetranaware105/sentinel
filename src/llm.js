import { runCli, isCli } from './cli-llm.js';

/** OpenAI-compatible streaming client for the Juspay LiteLLM gateway, with token metering and live progress. */
export const estimateTokens = (text) => Math.ceil(String(text).length / 3.6);

const IDLE_MS = 120000;     // no bytes at all for this long => abort and retry
const TOTAL_MS = 600000;    // hard ceiling per call

export class LLM {
  constructor(cfg) {
    this.cfg = cfg.llm;
    this.usage = { prompt: 0, completion: 0, calls: 0, estimated: false };
    this.budget = 0;
    this.seq = 0;
    this.noReasoning = new Set();   // models whose gateway rejected reasoning_effort
  }

  get total() { return this.usage.prompt + this.usage.completion; }
  overBudget() { return this.budget > 0 && this.total >= this.budget; }
  resetUsage(budget = 0) { this.usage = { prompt: 0, completion: 0, calls: 0, estimated: false }; this.budget = budget; }

  /** One streamed completion. Returns { text, finish }. Emits onProgress({id, model, phase, tokens, t0, done}). */
  async _chat(messages, { model, temperature = 0.1, maxTokens = 4000, signal, label = '', reasoning } = {}) {
    if (this.overBudget()) throw Object.assign(new Error('token budget reached'), { budget: true });
    const useModel = model || this.cfg.model;
    const url = (this.cfg.baseURL || '').replace(/\/+$/, '') + '/chat/completions';
    const cli = isCli(this.cfg.provider);
    const id = ++this.seq;
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      const ctrl = new AbortController();
      const onAbort = () => ctrl.abort();
      signal?.addEventListener('abort', onAbort);
      let idle = setTimeout(() => ctrl.abort(new Error('idle')), IDLE_MS);
      const total = setTimeout(() => ctrl.abort(new Error('timeout')), TOTAL_MS);
      const t0 = Date.now();
      let reasoning = 0, content = '', finish = null, usage = null, lastEmit = 0;
      const emit = (done = false, phase) => {
        const now = Date.now();
        if (!done && now - lastEmit < 250) return;
        lastEmit = now;
        this.onProgress?.({ id, model: useModel, label, phase: phase || (content ? 'writing' : reasoning ? 'thinking' : 'waiting'),
          tokens: Math.round(reasoning / 3.6 + content.length / 3.6), t0, done });
      };
      try {
        emit(false, 'waiting');
        if (cli) {
          const r = await runCli(this.cfg.provider, messages, { model: useModel === 'default' ? '' : useModel, signal: ctrl.signal, onChunk: () => { clearTimeout(idle); idle = setTimeout(() => ctrl.abort(new Error('idle')), IDLE_MS); } });
          content = r.text; finish = 'stop'; usage = r.usage;
          this.usage.calls++;
          if (usage) { this.usage.prompt += usage.prompt_tokens || 0; this.usage.completion += usage.completion_tokens || 0; }
          else { this.usage.estimated = true; this.usage.prompt += estimateTokens(messages.map((m) => m.content).join('')); this.usage.completion += estimateTokens(content); }
          this.onUsage?.(this.usage); emit(true);
          return { text: content, finish };
        }
        const res = await fetch(url, {
          method: 'POST', signal: ctrl.signal,
          headers: { 'content-type': 'application/json', authorization: `Bearer ${this.cfg.apiKey}` },
          body: JSON.stringify({ model: useModel, messages, temperature, max_tokens: maxTokens, stream: true, stream_options: { include_usage: true },
            ...(reasoning && !this.noReasoning.has(useModel) ? { reasoning_effort: reasoning } : {}) }),
        });
        if (res.status === 429 || res.status >= 500) throw new Error(`LLM ${res.status}`);
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          if (reasoning && !this.noReasoning.has(useModel) && (res.status === 400 || res.status === 422) && /reason|unsupported|unknown|extra/i.test(body)) {
            this.noReasoning.add(useModel); attempt--; continue;      // this model can't take reasoning_effort: retry without it
          }
          throw Object.assign(new Error(`LLM ${res.status}: ${body.slice(0, 300)}`), { fatal: true });
        }
        if (/json/.test(res.headers.get('content-type') || '')) {      // gateway ignored stream:true
          const j = await res.json();
          content = j.choices?.[0]?.message?.content ?? ''; finish = j.choices?.[0]?.finish_reason; usage = j.usage;
        } else {
          const dec = new TextDecoder(); let buf = '';
          for await (const chunk of res.body) {
            clearTimeout(idle); idle = setTimeout(() => ctrl.abort(new Error('idle')), IDLE_MS);
            buf += dec.decode(chunk, { stream: true });
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
              const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
              if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
              let j; try { j = JSON.parse(line.slice(5)); } catch { continue; }
              const ch = j.choices?.[0];
              if (ch?.delta?.content) content += ch.delta.content;
              if (ch?.delta?.reasoning_content) reasoning += ch.delta.reasoning_content.length;
              if (ch?.finish_reason) finish = ch.finish_reason;
              if (j.usage) usage = j.usage;
              emit();
            }
          }
        }
        this.usage.calls++;
        if (usage) { this.usage.prompt += usage.prompt_tokens || 0; this.usage.completion += usage.completion_tokens || 0; }
        else {
          this.usage.estimated = true;
          this.usage.prompt += estimateTokens(messages.map((m) => m.content).join(''));
          this.usage.completion += estimateTokens(content) + Math.round(reasoning / 3.6);
        }
        this.onUsage?.(this.usage);
        emit(true);
        return { text: content, finish };
      } catch (e) {
        lastErr = signal?.aborted ? e : /idle|timeout/.test(String(ctrl.signal.reason?.message)) ? new Error(`model gave no output for ${ctrl.signal.reason.message === 'idle' ? IDLE_MS / 1000 + 's' : 'too long'}`) : e;
        emit(true, 'failed');
        if (e.fatal || signal?.aborted) break;
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
      } finally {
        clearTimeout(idle); clearTimeout(total); signal?.removeEventListener('abort', onAbort);
      }
    }
    throw lastErr;
  }

  async chat(messages, opts) { return (await this._chat(messages, opts)).text; }

  /** Chat and parse JSON. Distinguishes "ran out of tokens while thinking" from "answered with junk". */
  async json(messages, opts) {
    const { text, finish } = await this._chat(messages, opts);
    const parsed = extractJson(text);
    if (parsed !== undefined) return parsed;
    if (!text.trim() && finish === 'length') {
      throw new Error(`${opts?.model || this.cfg.model} used all ${opts?.maxTokens} tokens thinking and wrote no answer (try a non-reasoning model for this step)`);
    }
    const fixed = await this._chat([...messages.slice(-2), { role: 'assistant', content: text.slice(0, 1500) },
      { role: 'user', content: 'Not valid JSON. Reply with ONLY the JSON.' }], opts);
    const again = extractJson(fixed.text);
    if (again === undefined) throw new Error('Model did not return valid JSON');
    return again;
  }
}

export function extractJson(text) {
  const t = String(text).replace(/<think>[\s\S]*?<\/think>/g, '');
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  for (const c of [fence?.[1], t]) {
    if (!c) continue;
    const s = c.trim();
    try { return JSON.parse(s); } catch {}
    const start = s.search(/[[{]/);
    if (start < 0) continue;
    const close = s[start] === '[' ? ']' : '}';
    const end = s.lastIndexOf(close);
    if (end > start) { try { return JSON.parse(s.slice(start, end + 1)); } catch {} }
  }
  return undefined;
}
