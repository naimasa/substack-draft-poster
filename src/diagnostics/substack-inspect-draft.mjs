// Diagnostic script for re-observation (read-only). Reads only the structure of a saved draft's body.
// Shows, with paths, whether the Paywall is at the top level, nested inside another node, or missing. Body text is never read or printed (only a ja/en flag and a character count).
// Usage: DRAFT_URL="https://<publication>.substack.com/publish/post/<number>" node src/diagnostics/substack-inspect-draft.mjs
// Prerequisite: a profile already signed in with `node src/cli.mjs --login`. This script does not log in.
// No clicks, no typing, no write-type HTTP, no writes to the editor (read-only). Checked statically by tests AC-30 and AC-47.
// Procedure and observations: docs/ui-observations.md
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { browserLaunchOptions, resolveProfileDir, resolvePublication } from '../modules/substack-contract.mjs';

const resolvedProfile = resolveProfileDir();
const profile = resolvedProfile.dir;
const draftOrigin = process.env.DRAFT_URL ? resolvePublication({ flag: new URL(process.env.DRAFT_URL).origin }) : undefined;
const origin = resolvePublication({ flag: process.env.SUBSTACK_PUBLICATION_URL ?? draftOrigin });
if (draftOrigin && draftOrigin !== origin) throw new Error('DRAFT_URL and SUBSTACK_PUBLICATION_URL must match');
const draftUrl = process.env.DRAFT_URL;
const id = Number((draftUrl || '').match(/\/publish\/post\/(\d+)$/)?.[1]);
if (!id || !draftUrl.startsWith(`${origin}/publish/post/`)) {
  console.log('Pass DRAFT_URL=https://example.substack.com/publish/post/<number>');
  process.exit(2);
}

const hasJa = (s) => /[ぁ-んァ-ヶ一-龠]/.test(s);
const textOf = (node) => (node?.text ?? '') + (node?.content ?? []).map(textOf).join('');

// Sequence of top-level node types (no text is printed)
const summarize = (json) => (json?.content ?? []).map((node, index) => {
  const text = textOf(node);
  const level = node.attrs?.level ?? '';
  return `${String(index).padStart(2)} ${node.type}${level}${text ? ` [${hasJa(text) ? 'ja' : 'en'} ${text.length} chars]` : ''}`;
});

// Find Paywalls recursively, including inside nested nodes. Returns paths such as content[12] or content[33].content[3].
const findPaywalls = (node, where = 'doc') => {
  const found = [];
  (node?.content ?? []).forEach((child, index) => {
    const here = `${where === 'doc' ? '' : `${where}.`}content[${index}]`;
    if (/paywall/i.test(child?.type ?? '')) found.push({ path: here, topLevel: where === 'doc', type: child.type });
    found.push(...findPaywalls(child, here));
  });
  return found;
};

const context = await chromium.launchPersistentContext(profile, browserLaunchOptions());
try {
  const res = await context.request.get(`${origin}/api/v1/post_management/drafts?offset=0&limit=25&order_by=draft_updated_at&order_direction=desc`);
  const found = res.ok() ? (await res.json()).posts?.find((post) => post.id === id) : null;
  console.log('List API response:', res.status(), '/ this draft:', found ? 'found' : 'not found');
  if (found) {
    for (const key of ['type', 'audience', 'is_published', 'should_send_email', 'should_send_free_preview', 'meter_type', 'subscriber_set_audience']) {
      console.log(`  ${key.padEnd(26)}`, JSON.stringify(found[key]));
    }
  }

  const page = await context.newPage();
  try {
    await page.goto(draftUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('.ProseMirror').waitFor({ timeout: 20000 });
    let json = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      json = await page.evaluate(() => document.querySelector('.ProseMirror')?.editor?.getJSON() ?? null);
      if ((json?.content ?? []).some((node) => (node.content ?? []).length)) break;
      await page.waitForTimeout(500);
    }
    const lines = summarize(json);
    console.log(`\n--- Saved body: ${lines.length} top-level nodes ---`);
    lines.forEach((line) => console.log('  ', line));
    const paywalls = findPaywalls(json);
    console.log('\nPaywall nodes (including nested):', paywalls.length ? '' : 'none');
    paywalls.forEach((p) => console.log(`  - ${p.path}  type=${p.type}  ${p.topLevel ? 'top level' : '* nested inside another node (not treated as a Paywall)'}`));
    const top = paywalls.filter((p) => p.topLevel).length;
    console.log(`Top-level Paywalls: ${top} (expected: exactly 1)`);
  } finally {
    await page.close().catch(() => {});
  }
  console.log('\nDone (nothing was changed)');
} finally {
  await context.close();
}
