import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const HOME_DIR = process.env.SENTINEL_HOME || path.join(os.homedir(), '.pr-sentinel');
export const CONFIG_PATH = path.join(HOME_DIR, 'config.json');
export const RUNS_DIR = path.join(HOME_DIR, 'runs');
export const CACHE_DIR = path.join(HOME_DIR, 'cache');

export const DEFAULTS = {
  bitbucket: {
    username: '',
    token: '',
    baseUrl: '',
    toolGroups: 'pr_core,pr_comments,pr_review,commits,files,search,discovery',
    // Project key used for the "PRs where I am a reviewer" dashboard call.
    dashboardWorkspace: '',
  },
  llm: {
    // gateway = Juspay LiteLLM (needs apiKey) | claude = local Claude Code CLI | codex = local Codex CLI (both use your existing login)
    provider: 'gateway',
    baseURL: 'https://grid.ai.juspay.net',
    apiKey: '',
    model: 'glm-latest',
    // Cheaper model for verification + summary (the strong model is used only for analysis).
    fastModel: 'glm-flash-experimental',
    models: ['glm-latest', 'claude-sonnet-4-6', 'claude-opus-4-6', 'gemini-3-pro-preview', 'kimi-latest'],
  },
  // Where repos are cloned for local grep during verification.
  workspaceRoot: path.join(HOME_DIR, 'repos'),
  // {ws} / {repo} are substituted. Empty = derive from bitbucket baseUrl (https /scm/ form).
  cloneUrlTemplate: '',
  // Hard cap on tokens one review may spend (prompt + completion). 0 = unlimited.
  tokenBudget: 400000,
  // Characters of diff per analysis call. Large = most PRs are reviewed in ONE call (instructions sent once).
  chunkChars: 150000,
  // Accent gradient: aurora | ocean | ember | mono (switch with T in the UI).
  theme: 'aurora',
  // Review depth, like Claude Code's effort levels: low | medium | high (see EFFORT in review.js).
  effort: 'medium',
};

export function loadConfig() {
  let file = {};
  try { file = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  const cfg = {
    ...DEFAULTS,
    ...file,
    bitbucket: { ...DEFAULTS.bitbucket, ...file.bitbucket },
    llm: { ...DEFAULTS.llm, ...file.llm },
  };
  // Environment overrides (handy for CI / one-off runs).
  const e = process.env;
  if (e.BITBUCKET_USERNAME) cfg.bitbucket.username = e.BITBUCKET_USERNAME;
  if (e.BITBUCKET_TOKEN) cfg.bitbucket.token = e.BITBUCKET_TOKEN;
  if (e.BITBUCKET_BASE_URL) cfg.bitbucket.baseUrl = e.BITBUCKET_BASE_URL;
  if (e.SENTINEL_PROVIDER) cfg.llm.provider = e.SENTINEL_PROVIDER;
  if (e.SENTINEL_LLM_BASE_URL) cfg.llm.baseURL = e.SENTINEL_LLM_BASE_URL;
  if (e.SENTINEL_LLM_API_KEY) cfg.llm.apiKey = e.SENTINEL_LLM_API_KEY;
  return cfg;
}

export function saveConfig(cfg) {
  fs.mkdirSync(HOME_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

export function isConfigured(cfg) {
  return Boolean(cfg.bitbucket.baseUrl && cfg.bitbucket.token && (cfg.llm.apiKey || ['claude', 'codex'].includes(cfg.llm.provider)));
}

/** Pull Juspay LLM + Bitbucket settings out of an existing opencode config. */
export function importFromOpencode() {
  const p = path.join(os.homedir(), '.config', 'opencode', 'opencode.json');
  let d;
  try { d = JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
  const out = { bitbucket: {}, llm: {} };
  const env = d.mcp?.bitbucket?.env || {};
  const resolve = (v) => {
    if (typeof v !== 'string') return '';
    const m = v.match(/^\{env:(\w+)\}$/);
    return m ? process.env[m[1]] || '' : v;
  };
  out.bitbucket.username = resolve(env.BITBUCKET_USERNAME);
  out.bitbucket.token = resolve(env.BITBUCKET_TOKEN);
  out.bitbucket.baseUrl = resolve(env.BITBUCKET_BASE_URL);
  if (env.BITBUCKET_TOOL_GROUPS) out.bitbucket.toolGroups = env.BITBUCKET_TOOL_GROUPS;
  const prov = d.provider?.litellm;
  if (prov) {
    out.llm.baseURL = prov.options?.baseURL;
    out.llm.apiKey = resolve(prov.options?.apiKey);
    out.llm.models = Object.keys(prov.models || {}).filter((m) => !/vision/.test(m));
  }
  return out;
}
