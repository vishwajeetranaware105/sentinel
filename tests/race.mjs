// Regression: a review that finishes before the screen subscribed (all cached) must not leave the UI on the running view.
import React from 'react';
import { render } from 'ink-testing-library';
import { loadConfig } from '../src/config.js';
import { Review } from '../src/review.js';
import { ReviewScreen } from '../src/tui/review.js';
import { CHECKS } from '../src/checks.js';
const cfg = loadConfig();
const rev = new Review({ cfg, bb: {}, model: 'm', checks: CHECKS.map((c) => c.id), target: { workspace: 'AX', repository: 'demo', id: 1 } });
Object.assign(rev.data, { status: 'running', pr: { ...rev.data.pr, title: 't' }, summary: { text: 'ok', post: true, recommendation: 'approve', gates: {} }, discussion: { total: 0, open: 0, withReplies: 0, needReply: 0, threads: [] } });
rev.data.stages.forEach((s, i) => (s.state = i ? 'pending' : 'done'));
const r = render(React.createElement(ReviewScreen, { review: rev, cfg, dims: { w: 100, h: 24 }, onBack() {}, onUserCancel() {} }));
rev.data.status = 'review'; rev.data.stages.forEach((s) => (s.state = 'done'));      // finishes with no event reaching the screen
await new Promise((x) => setTimeout(x, 400));
const ok = /Review summary/.test(r.lastFrame().replace(/\x1b\[[0-9;]*m/g, ''));
console.log(ok ? 'PASS screen catches up after a missed event' : 'FAIL screen stuck on the running view');
process.exit(ok ? 0 : 1);
