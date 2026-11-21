// Diagnostic script for re-observation (read-only). Reads reachability, row structure and called API paths of the three list pages and, optionally, the editor structure of one draft.
// Use it when you suspect the Substack UI or API changed. Procedure and observations: docs/ui-observations.md
// Usage: DRAFT_URL="https://<publication>.substack.com/publish/post/<number>" node src/diagnostics/substack-survey-lists.mjs
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
const norm = (href) => { try { return new URL(href, origin).pathname.replace(/\d+/g, 'N').replace(/^\/p\/[^/]+/, '/p/S'); } catch { return String(href); } };
const settle = async (page, ms = 6000) => {
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(ms);
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight)).catch(() => {});
  await page.waitForTimeout(1500);
};

const context = await chromium.launchPersistentContext(profile, browserLaunchOptions());
try {
  const page = context.pages()[0] ?? await context.newPage();
  const api = new Set();
  page.on('response', (r) => {
    try {
      const u = new URL(r.url());
      if (!u.pathname.startsWith('/api/')) return;
      const keys = [...u.searchParams.keys()].join('&');
      api.add(`${r.request().method()} ${u.pathname.replace(/\d+/g, 'N')}${keys ? `?${keys}` : ''} -> ${r.status()}`);
    } catch { /* ignore */ }
  });

  for (const route of ['/publish/posts/drafts', '/publish/posts/published', '/publish/posts']) {
    api.clear();
    console.log(`\n=== 1: ${route} ===`);
    await page.goto(`${origin}${route}`, { waitUntil: 'domcontentloaded' });
    await settle(page);
    console.log('Final URL:', page.url().replace(origin, ''));
    console.log('Title:', await page.title());
    if (/\/sign-in|\/login/.test(new URL(page.url()).pathname)) { console.log('This is the sign-in page. Aborting.'); process.exitCode = 2; break; }
    const info = await page.evaluate(() => {
      const norm = (h) => { try { return new URL(h, location.origin).pathname.replace(/\d+/g, 'N').replace(/^\/p\/[^/]+/, '/p/S'); } catch { return String(h); } };
      const count = (sel) => document.querySelectorAll(sel).length;
      const tabs = [...document.querySelectorAll('[role="tab"]')].map((e) => ({ name: (e.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 20), selected: e.getAttribute('aria-selected') }));
      const testids = [...new Set([...document.querySelectorAll('[data-testid]')].map((e) => e.getAttribute('data-testid')))].slice(0, 20);
      const skel = (el, depth) => {
        if (depth > 4) return '…';
        const bits = [el.tagName.toLowerCase()];
        const role = el.getAttribute('role'); if (role) bits.push(`role=${role}`);
        const tid = el.getAttribute('data-testid'); if (tid) bits.push(`testid=${tid}`);
        if (el.tagName === 'A') bits.push(`href=${norm(el.getAttribute('href') || '')}`);
        if (el.tagName === 'IMG') bits.push('img');
        const kids = [...el.children].slice(0, 6).map((k) => skel(k, depth + 1));
        return `${bits.join(' ')}${kids.length ? ` { ${kids.join(' | ')} }` : ''}`;
      };
      const ell = [...document.querySelectorAll('button')].find((b) => /ellipsis|more/i.test(`${b.getAttribute('aria-label') || ''} ${b.textContent || ''}`));
      let chain = [], rowSkel = null;
      if (ell) {
        let el = ell;
        for (let i = 0; i < 8 && el.parentElement; i++, el = el.parentElement) {
          const r = el.getBoundingClientRect();
          chain.push(`${el.tagName.toLowerCase()}${el.getAttribute('role') ? `[role=${el.getAttribute('role')}]` : ''} ${Math.round(r.width)}x${Math.round(r.height)} children=${el.children.length} a[href]=${el.querySelectorAll('a[href]').length}`);
          if (!rowSkel && r.width >= 500 && r.height >= 40 && r.height <= 220) rowSkel = skel(el, 0);
        }
      }
      return { tr: count('tr'), li: count('li'), roleRow: count('[role="row"]'), roleListitem: count('[role="listitem"]'), tabs, testids,
        hrefs: Object.entries([...document.querySelectorAll('a[href]')].reduce((m, a) => { const k = norm(a.getAttribute('href')); m[k] = (m[k] || 0) + 1; return m; }, {})).map(([k, v]) => `${v}x ${k}`),
        ellipsisFound: Boolean(ell), chain, rowSkel };
    });
    console.log('tr/li/[role=row]/[role=listitem]:', info.tr, info.li, info.roleRow, info.roleListitem);
    console.log('Tabs:', info.tabs);
    console.log('data-testid (first 20):', info.testids);
    console.log('Link target patterns:', info.hrefs);
    console.log('Ellipsis button:', info.ellipsisFound ? 'present' : 'not found');
    console.log('Structure from the ellipsis button up to its ancestors:'); info.chain.forEach((x) => console.log('  -', x));
    console.log('Skeleton of the row-like element (no text):', info.rowSkel ?? '(not identified)');
    console.log('API calls seen:'); [...api].sort().forEach((x) => console.log('  -', x));
  }

  console.log('\n=== 2: Draft editor ===');
  const draftUrl = process.env.DRAFT_URL;
  if (!draftUrl) console.log('Skipped: DRAFT_URL is not set');
  else if (!draftUrl.startsWith(`${origin}/publish/post/`) || !/\/publish\/post\/\d+/.test(draftUrl)) console.log('Skipped: DRAFT_URL has an unexpected form (pass https://example.substack.com/publish/post/<number>)');
  else {
    await page.goto(draftUrl, { waitUntil: 'domcontentloaded' });
    await settle(page, 4000);
    console.log('URL shape:', norm(page.url()), '/ matches the /publish/post/N the tool expects:', /\/publish\/post\/\d+/.test(page.url()));
    const info = await page.evaluate(() => {
      const el = document.querySelector('.ProseMirror');
      const keys = { 'element.editor': el?.editor, 'element.__tiptapEditor': el?.__tiptapEditor, 'window.editor': window.editor, 'window.tiptapEditor': window.tiptapEditor };
      const reach = Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, v ? `setContent:${typeof v.commands?.setContent} getJSON:${typeof v.getJSON}` : 'none']));
      const attr = (e, n) => e.getAttribute(n) || '';
      return {
        prosemirror: document.querySelectorAll('.ProseMirror').length, reach,
        elementKeysLike: el ? Object.keys(el).filter((k) => /editor|tiptap|view|pm/i.test(k)) : [],
        windowKeysLike: Object.keys(window).filter((k) => /editor|tiptap/i.test(k)),
        fields: [...document.querySelectorAll('input, textarea')].map((e) => `${e.tagName.toLowerCase()} placeholder="${attr(e, 'placeholder')}" aria-label="${attr(e, 'aria-label')}" name="${attr(e, 'name')}"`),
        editable: [...document.querySelectorAll('[contenteditable="true"]')].map((e) => `${e.tagName.toLowerCase()} data-placeholder="${attr(e, 'data-placeholder')}" aria-label="${attr(e, 'aria-label')}" class="${String(e.className).slice(0, 40)}"`),
        status: [...new Set([...document.querySelectorAll('body *')].filter((e) => e.children.length === 0 && /^(saved|saving|all changes saved|draft saved|saved to drafts)/i.test((e.textContent || '').trim())).map((e) => (e.textContent || '').trim().slice(0, 40)))],
      };
    });
    console.log('.ProseMirror count:', info.prosemirror);
    console.log('Tiptap reachability (the 4 paths the tool tries):', info.reach);
    console.log('Element keys (containing editor/tiptap/view/pm):', info.elementKeysLike);
    console.log('window keys (containing editor/tiptap):', info.windowKeysLike);
    console.log('input/textarea:'); info.fields.forEach((x) => console.log('  -', x));
    console.log('contenteditable:'); info.editable.forEach((x) => console.log('  -', x));
    console.log('Save-status-like text:', info.status);
    console.log('Count for the tool lookup getByPlaceholder(/^title$/i):', await page.getByPlaceholder(/^title$/i).count());
    console.log('Count for the tool lookup getByPlaceholder(/^(subtitle|add a subtitle)/i):', await page.getByPlaceholder(/^(subtitle|add a subtitle)/i).count());
  }
  console.log('\nDone (nothing was typed, saved, created or clicked)');
} finally {
  await context.close();
}
