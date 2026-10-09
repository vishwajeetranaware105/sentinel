import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createRequire } from 'node:module';
import path from 'node:path';

/** Prefer the bundled MCP server (works offline, no npx cold start); fall back to npx. */
function mcpCommand() {
  try {
    const pkg = createRequire(import.meta.url).resolve('@nexus2520/bitbucket-mcp-server/package.json');
    return { command: process.execPath, args: [path.join(path.dirname(pkg), 'build', 'index.js')] };
  } catch { return { command: 'npx', args: ['-y', '@nexus2520/bitbucket-mcp-server'] }; }
}

const live = new Set();
/** Synchronously kill every MCP child we spawned (used from exit/signal handlers). */
export function killAllMcp() {
  for (const t of live) { try { t._process?.kill('SIGKILL'); } catch {} }
  live.clear();
}

/** Thin wrapper over the same Bitbucket MCP server opencode / Claude Code use. */
export class Bitbucket {
  constructor(cfg) {
    this.cfg = cfg.bitbucket;
    this.client = null;
    this.connecting = null;
  }

  async connect() {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const transport = new StdioClientTransport({
        ...mcpCommand(),
        env: {
          ...process.env,
          BITBUCKET_USERNAME: this.cfg.username,
          BITBUCKET_TOKEN: this.cfg.token,
          BITBUCKET_BASE_URL: this.cfg.baseUrl,
          BITBUCKET_TOOL_GROUPS: this.cfg.toolGroups,
        },
        stderr: 'ignore',
      });
      live.add(transport);
      this.transport = transport;
      const client = new Client({ name: 'pr-sentinel', version: '0.1.0' });
      await client.connect(transport);
      this.client = client;
      return client;
    })();
    try { return await this.connecting; } finally { this.connecting = null; }
  }

  async call(name, args) {
    const client = await this.connect();
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content || []).map((c) => c.text ?? '').join('\n');
    if (res.isError) throw new Error(`${name}: ${text.slice(0, 400)}`);
    try { return JSON.parse(text); } catch { return text; }
  }

  async close() {
    try { await this.client?.close(); } catch {}
    live.delete(this.transport); this.client = null; this.transport = null;
  }

  // --- typed helpers -------------------------------------------------------
  /** role: REVIEWER = PRs waiting on me, AUTHOR = PRs I opened. Paginates up to `max`. */
  async listPrs(role, { max = 100 } = {}) {
    const all = []; let start = 0;
    while (all.length < max) {
      const r = await this.call('list_pull_requests', {
        workspace: this.cfg.dashboardWorkspace || 'ALL', role, state: 'OPEN', start, limit: 50,
      });
      for (const p of r.pull_requests || []) {
        const [workspace, repository] = String(p.repository).split('/');
        all.push({ ...p, workspace, repository });
      }
      if (!r.has_more || r.next_start == null) break;
      start = r.next_start;
    }
    return all;
  }
  reviewerPrs({ limit = 50 } = {}) {
    return this.call('list_pull_requests', { workspace: this.cfg.dashboardWorkspace || 'ALL', role: 'REVIEWER', state: 'OPEN', start: 0, limit })
      .then((r) => ({ prs: (r.pull_requests || []).map((p) => { const [workspace, repository] = String(p.repository).split('/'); return { ...p, workspace, repository }; }) }));
  }

  /** Read-only GET against the Bitbucket Server REST API, with the same Bearer token the MCP server uses. */
  async rest(pathAndQuery) {
    const res = await fetch(`${this.cfg.baseUrl.replace(/\/+$/, '')}/rest/api/1.0/${pathAndQuery}`, { headers: { authorization: `Bearer ${this.cfg.token}`, accept: 'application/json' } });
    if (!res.ok) throw new Error(`Bitbucket ${res.status} on ${pathAndQuery.split('?')[0]}`);   // no retry, no other auth scheme
    return res.json();
  }

  /**
   * Every comment thread on a PR with its replies, anchors and states. The MCP's embedded comments only return
   * a handful of general comments, so the full discussion comes from the activities feed.
   * Returns [{id, path, line, lineType, orphaned, resolved, task, messages:[{id, parentId, who, email, slug, text, at, state, severity}]}].
   */
  async discussion(ws, repo, id) {
    const acts = [];
    for (let start = 0; acts.length < 3000;) {
      const j = await this.rest(`projects/${ws}/repos/${repo}/pull-requests/${id}/activities?limit=250&start=${start}`);
      acts.push(...(j.values || []));
      if (j.isLastPage || j.nextPageStart == null) break;
      start = j.nextPageStart;
    }
    return acts.filter((a) => a.action === 'COMMENTED' && a.comment).map((a) => {
      const root = a.comment, messages = [];
      const walk = (c, parentId) => {
        messages.push({ id: c.id, parentId, who: c.author?.displayName || c.author?.name || '?', email: String(c.author?.emailAddress || '').toLowerCase(), slug: c.author?.name || '',
          text: String(c.text || ''), at: c.createdDate, state: c.state, severity: c.severity });
        (c.comments || []).forEach((r) => walk(r, c.id));
      };
      walk(root, null);
      messages.sort((x, y) => x.at - y.at);
      return { id: root.id, path: a.commentAnchor?.path || null, line: a.commentAnchor?.line || null, lineType: a.commentAnchor?.lineType || null,
        orphaned: !!a.commentAnchor?.orphaned, resolved: root.state === 'RESOLVED', task: root.severity === 'BLOCKER', messages };
    });
  }

  getPr(ws, repo, id) {
    return this.call('get_pull_request', {
      workspace: ws, repository: repo, pull_request_id: id,
      include_comments: true, comment_limit: 40, include_file_changes: true, include_tasks: true,
    });
  }
  getDiff(ws, repo, id, extra = {}) {
    return this.call('get_pull_request_diff', {
      workspace: ws, repository: repo, pull_request_id: id, context_lines: 2, ignore_whitespace: true, ...extra,
    });
  }
  listCommits(ws, repo, id) {
    return this.call('list_pr_commits', { workspace: ws, repository: repo, pull_request_id: id, limit: 50 });
  }
  grep(ws, repo, args) {
    return this.call('grep', { workspace: ws, repository: repo, ...args });
  }
  fileContent(ws, repo, file_path, args = {}) {
    return this.call('get_file_content', { workspace: ws, repository: repo, file_path, ...args });
  }
  addComment(ws, repo, id, args) {
    return this.call('add_comment', { workspace: ws, repository: repo, pull_request_id: id, ...args });
  }
}

/**
 * Accepts a Bitbucket Server PR URL (…/projects/KEY/repos/slug/pull-requests/123[/overview]),
 * or shorthand KEY/slug#123 / KEY/slug/123. Returns {workspace, repository, id} or null.
 */
export function parsePrUrl(input) {
  const t = String(input || '').trim();
  let m = t.match(/\/projects\/([^/]+)\/repos\/([^/]+)\/pull-requests\/(\d+)/i);
  if (m) return { workspace: decodeURIComponent(m[1]), repository: decodeURIComponent(m[2]), id: +m[3] };
  m = t.match(/^([\w.-]+)\/([\w.-]+)(?:#|\/)(\d+)$/);
  if (m) return { workspace: m[1], repository: m[2], id: +m[3] };
  return null;
}
