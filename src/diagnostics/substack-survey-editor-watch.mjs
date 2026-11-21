// Diagnostic script for re-observation (read-only). Shows the shape (keys and types only) of the list API responses, and observes the Create > Article steps a human performs by hand (URLs, APIs, save indicators).
// Use it when you suspect the Substack UI or API changed. Procedure and observations: docs/ui-observations.md
// Usage: node src/diagnostics/substack-survey-editor-watch.mjs
// Prerequisite: a profile already signed in with `node src/cli.mjs --login`. This script does not log in. No clicks, no typing, no write-type HTTP.
// Test AC-30 statically checks that it is read-only.
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { browserLaunchOptions, resolveProfileDir, resolvePublication } from '../modules/substack-contract.mjs';

const resolvedProfile = resolveProfileDir();
const profile = resolvedProfile.dir;
const draftOrigin = process.env.DRAFT_URL ? resolvePublication({ flag: new URL(process.env.DRAFT_URL).origin }) : undefined;
const origin = resolvePublication({ flag: process.env.SUBSTACK_PUBLICATION_URL ?? draftOrigin });
if (draftOrigin && draftOrigin !== origin) throw new Error('DRAFT_URL and SUBSTACK_PUBLICATION_URL must match');
const WATCH_SECONDS = Number(process.env.WATCH_SECONDS || 240);
const norm = (p) => p.replace(/\d+/g, 'N');
const brief = (x) => (x === null ? 'null' : Array.isArray(x) ? `array(${x.length})` : typeof x === 'object' ? 'object' : typeof x === 'string' ? `string(${x.length})` : typeof x);
const itemShape = (o) => `{ ${Object.entries(o).map(([k, v]) => `${k}: ${brief(v)}`).join(', ')} }`;
function describe(json) {
  if (Array.isArray(json)) return `array(${json.length})` + (json[0] && typeof json[0] === 'object' ? ` of ${itemShape(json[0])}` : '');
  const out = {};
  for (const [k, v] of Object.entries(json)) {
    out[k] = Array.isArray(v) && v[0] && typeof v[0] === 'object' ? `array(${v.length}) of ${itemShape(v[0])}` : brief(v);
  }
  return out;
}
const SAFE_PARAMS = new Set(['offset', 'limit', 'order_by', 'order_direction']);
const showUrl = (raw) => {
  const u = new URL(raw);
  const params = [...u.searchParams.entries()].map(([k, v]) => (SAFE_PARAMS.has(k) ? `${k}=${v}` : k));
  return `${norm(u.pathname)}${params.length ? `?${params.join('&')}` : ''}`;
};

const context = await chromium.launchPersistentContext(profile, browserLaunchOptions());
const t0 = Date.now();
const stamp = () => `[+${String(Math.round((Date.now() - t0) / 1000)).padStart(3)}s]`;
try {
  // Install the observer on every page (it only records short save-status-like strings that appear)
  await context.addInitScript(() => {
    window.__seen = new Set();
    const note = (t) => { const s = String(t || '').trim().replace(/\s+/g, ' '); if (s && s.length <= 30 && /sav|sync|draft|unsaved|edit|publish|schedul/i.test(s)) window.__seen.add(s); };
    new MutationObserver((muts) => { for (const m of muts) { m.addedNodes.forEach((n) => note(n.textContent)); if (m.type === 'characterData') note(m.target.textContent); } })
      .observe(document, { childList: true, subtree: true, characterData: true });
  });

  const page = context.pages()[0] ?? await context.newPage();

  // ---- A: shape of the list API responses ----
  console.log('=== A: Shape of the list API responses (keys and types only) ===');
  const listUrls = {};
  page.on('request', (req) => {
    try {
      const m = new URL(req.url()).pathname.match(/\/api\/v\d+\/post_management\/(drafts|published)$/);
      if (m && req.method() === 'GET') listUrls[m[1]] ??= req.url();
    } catch { /* ignore */ }
  });
  for (const kind of ['drafts', 'published']) {
    await page.goto(`${origin}/publish/posts/${kind}`, { waitUntil: 'domcontentloaded' });
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(4000);
    const url = listUrls[kind];
    console.log(`\n--- ${kind} ---`);
    if (!url) { console.log('Could not capture the dashboard list request'); continue; }
    console.log('Dashboard request:', showUrl(url));
    const res = await page.request.get(url);
    console.log('Replayed the same request -> status:', res.status());
    if (res.ok()) {
      const json = await res.json().catch(() => null);
      if (json === null) { console.log('Not JSON'); continue; }
      console.log('Response shape:', JSON.stringify(describe(json), null, 2));
      const items = Array.isArray(json) ? json : Object.values(json).find((v) => Array.isArray(v) && v[0] && typeof v[0] === 'object');
      if (items?.[0]) console.log('Fields that look like title/slug/id/status/date:', Object.keys(items[0]).filter((k) => /title|slug|^id$|status|date|draft|publish/i.test(k)));
    }
  }

  // ---- B: observing the human's manual steps ----
  await page.goto(`${origin}/publish/posts/drafts`, { waitUntil: 'domcontentloaded' });
  console.log(`\n=== B: Observation started (${WATCH_SECONDS} seconds, or until the browser is closed) ===`);
  console.log('Now do the following by hand in the open browser (this script does not operate anything):');
  console.log('  1) Choose Create > Article at the top right');
  console.log('  2) Type "PROBE (deletable)" as the title and any one line as the body');
  console.log('  3) Wait about 10 seconds (autosave is observed)');
  console.log('  4) Close the browser window (this script ends too)');
  console.log('  Note: this creates one new draft. Delete it on Substack afterwards.\n');

  const seenApi = new Set();
  const attach = (p) => {
    p.on('framenavigated', (f) => { if (f === p.mainFrame()) { try { const u = new URL(f.url()); console.log(stamp(), 'URL →', norm(u.pathname) + (u.search ? `?${[...u.searchParams.keys()].join('&')}` : '')); } catch { /* ignore */ } } });
    p.on('response', (r) => {
      try {
        const u = new URL(r.url());
        if (!u.pathname.startsWith('/api/') || u.pathname.includes('/envelope') || u.pathname.includes('firehose')) return;
        const method = r.request().method();
        const key = `${method} ${norm(u.pathname)} -> ${r.status()}`;
        if (method !== 'GET' || !seenApi.has(key)) { if (method === 'GET') seenApi.add(key); console.log(stamp(), 'API', key); }
      } catch { /* ignore */ }
    });
  };
  context.pages().forEach(attach);
  context.on('page', attach);

  const printed = new Set();
  const poll = setInterval(async () => {
    for (const p of context.pages()) {
      try {
        const seen = await p.evaluate(() => [...(window.__seen ?? [])]);
        for (const s of seen) if (!printed.has(s)) { printed.add(s); console.log(stamp(), 'Short text appeared:', JSON.stringify(s)); }
      } catch { /* ignore, e.g. while the page is navigating */ }
    }
  }, 1500);
  await new Promise((resolve) => { context.on('close', resolve); setTimeout(resolve, WATCH_SECONDS * 1000); });
  clearInterval(poll);
  console.log('\nObservation finished');
} finally {
  await context.close().catch(() => {});
}
