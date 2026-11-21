import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { ALLOWED_TAGS, sanitizeHtml, extractTitleAndBody, buildInjectionPlan } from "../src/modules/substack-tiptap.mjs";
import { emptyState, loadState, saveState, hashSource, normalizeTitle, nextStatus, shouldSkip, recordDraftCreated, recordSkipped } from "../src/modules/substack-post-state.mjs";
import { markdownToBlocks, renderTableAsNestedList } from "../src/modules/markdown-to-html-blocks.mjs";

const root = new URL("../", import.meta.url);
const canonical = '<p><em>This is a reprint from the Example blog. <a href="https://example.com/blog/test?utm_source=substack">Original article</a></em></p>';
const markdown = [
  '## Section', '', '### Detail', '',
  'A **strong** and *emphasized* paragraph with `inline code`.', '',
  '- First', '  - Nested', '', '1. Ordered', '2. Second', '',
  '| Role | Skill |', '| --- | --- |', '| Engineer | Communication |', '',
  '> Quoted text', '', '```js', 'const answer = 42;', '```', '', '---',
].join('\n');
const blocks = markdownToBlocks(markdown);
const content = blocks.map((block) => block.type === 'table'
  ? renderTableAsNestedList(block.headerCells, block.separatorCells, block.bodyRowsCells)
  : block.html).join('');
const freePreviewHtml = `<h1>Fixture title</h1>${canonical}${content}<p>A link <a href="https://example.com">here</a><br>next line.</p>`;
const paidBodyHtml = '<h2>Paid section</h2><p>Paid text with <strong>detail</strong>.</p>';
const supported = ['h2', 'h3', 'p', 'strong', 'em', 'code', 'a', 'br', 'ul', 'ol', 'li', 'blockquote', 'pre', 'hr'];

function allowedOnly(html, label) {
  assert.equal(typeof html, 'string', `${label}: expected HTML string`);
  const unexpected = [...html.matchAll(/<\/?([a-z][\w:-]*)\b[^>]*>/gi)]
    .map((match) => match[1].toLowerCase()).filter((tag) => !ALLOWED_TAGS.includes(tag));
  assert.deepEqual(unexpected, [], `${label}: expected only ALLOWED_TAGS`);
}

let failures = 0;
function test(ac, run) {
  try {
    run();
    console.log(`PASS ${ac}`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${ac}: ${error.message}`);
    console.log('Expected:', error.expected ?? 'successful completion without error');
    console.log('Actual:', error.actual ?? `${error.name}: ${error.message}`);
  }
}

// Ignore explanatory comment lines, while retaining operational string arguments.
function operationalSource(source) {
  return source.split('\n').filter((line) => !/^\s*(?:\/\/|\*)/.test(line)).join('\n');
}
function forbiddenOperations(source) {
  const code = operationalSource(source);
  const patterns = [
    ['Publish button click', /(?:getByRole\s*\(\s*['"]button['"][\s\S]{0,250}?\bname\s*:\s*\/?['"]?\^?publish\b[\s\S]{0,250}?\.click\s*\(|(?:getByText|locator|\$|click)\s*\([^\n;]*['"/][^\n;]*\bpublish\b[^\n;]*\)[\s\S]{0,100}?\.click\s*\(|\.click\s*\([^\n;]*\bpublish\b)/i],
    ['Send to everyone', /(?:getByRole|getByText|locator|click)\s*\([^;]*?send\s+to\s+everyone/i],
    ['publishDraft', /\bpublishDraft\s*\(/i],
    ['POST /publish', /(?:\.post\s*\(\s*['"`][^'"`]*\/publish\b|(?:fetch|request)\s*\(\s*['"`][^'"`]*\/publish\b[^;]*?method\s*:\s*['"]post['"])/i],
  ];
  return patterns.filter(([, pattern]) => pattern.test(code)).map(([name]) => name);
}

test('AC-4', () => {
  assert.deepEqual([...ALLOWED_TAGS].sort(), [...supported].sort(), 'allowed tags match the documented subset');
  const extracted = extractTitleAndBody(freePreviewHtml);
  assert.equal(extracted.title, 'Fixture title', 'first h1 supplies the title');
  assert.doesNotMatch(extracted.bodyHtml, /<\/?h1\b/i, 'h1 must leave the body');
  assert.ok(extracted.bodyHtml.trimStart().startsWith(canonical), 'canonical note stays first');
  const clean = sanitizeHtml(`${extracted.bodyHtml}<div>Unsupported wrapper</div><img src="x"><script>bad()</script>`);
  allowedOnly(clean, 'sanitizeHtml');
  for (const tag of supported) assert.match(clean, new RegExp(`<${tag}\\b`, 'i'), `must preserve ${tag}`);
  assert.match(clean, /<li>Engineer<ul><li>Skill: Communication<\/li><\/ul><\/li>/, 'table becomes nested list');
  assert.match(clean, /<pre><code>/, 'code block survives');
  const plan = buildInjectionPlan({ freePreviewHtml, paidBodyHtml, titleEn: 'Fixture title', excerptEn: 'Subtitle' });
  assert.equal(plan.title, 'Fixture title');
  assert.equal(plan.subtitle, 'Subtitle');
  allowedOnly(plan.freeHtml, 'freeHtml');
  allowedOnly(plan.paidHtml, 'paidHtml');
  assert.ok(plan.freeHtml.trimStart().startsWith(canonical), 'plan preserves canonical first');
  assert.doesNotMatch(plan.freeHtml, /<\/?h1\b/i);
  const withoutTitle = extractTitleAndBody(canonical);
  assert.equal(withoutTitle.title, null);
  assert.equal(withoutTitle.bodyHtml, canonical);
});

test('AC-5', () => {
  const input = { freePreviewHtml, titleEn: 'Fixture title', excerptEn: 'Subtitle' };
  const paid = buildInjectionPlan({ ...input, paidBodyHtml });
  assert.equal(paid.paywall, true);
  assert.equal(paid.paidHtml, sanitizeHtml(paidBodyHtml));
  assert.match(paid.freeHtml, /Section/);
  assert.doesNotMatch(paid.freeHtml, /Paid text/);
  for (const absent of [null, '']) {
    const free = buildInjectionPlan({ ...input, paidBodyHtml: absent });
    assert.equal(free.paywall, false, `paidBodyHtml=${JSON.stringify(absent)}`);
    assert.equal(free.paidHtml, null);
  }
});

test('AC-6', () => {
  // Exercise detection so an ineffective scanner cannot silently pass.
  for (const source of [
    `page.getByRole('button', { name: 'Publish' }).click();`,
    `page.getByText('Publish').click();`,
    `page.getByText('Send to everyone').click();`,
    `publishDraft(draft);`,
    `fetch('/publish', { method: 'POST' });`,
    `request.post('/api/posts/123/publish');`,
  ]) assert.notDeepEqual(forbiddenOperations(source), [], `must detect: ${source}`);
  assert.deepEqual(forbiddenOperations('// publishDraft(draft)\n * Send to everyone\nconsole.log("Never click Publish or call publishDraft");'), []);
  const source = fs.readFileSync(new URL('src/cli.mjs', root), 'utf8');
  assert.deepEqual(forbiddenOperations(source), [], 'CLI must contain no publishing operations');
});

test('AC-7 / AC-8', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || '/tmp', 'substack-test-'));
  try {
    const file = path.join(dir, 'state.json');
    assert.deepEqual(emptyState(), { posts: {} });
    assert.deepEqual(loadState(file), emptyState(), 'missing file yields empty state');
    const original = emptyState();
    const sourceHash = hashSource(freePreviewHtml, paidBodyHtml);
    assert.match(sourceHash, /^[a-f0-9]{64}$/);
    assert.equal(sourceHash, hashSource(freePreviewHtml, paidBodyHtml), 'hash is deterministic');
    assert.notEqual(sourceHash, hashSource(`${freePreviewHtml}changed`, paidBodyHtml));
    assert.notEqual(sourceHash, hashSource(freePreviewHtml, `${paidBodyHtml}changed`));
    assert.equal(createHash('sha256').update('').digest('hex').length, sourceHash.length);
    const details = { draftUrl: 'https://example.substack.com/publish/post/123', titleEn: 'Fixture title', sourceHash };
    const state = recordDraftCreated(original, 'fixture', details);
    assert.deepEqual(original, emptyState(), 'recording returns a new state');
    assert.equal(state.posts.fixture.status, 'draft_created');
    for (const [key, value] of Object.entries(details)) assert.equal(state.posts.fixture[key], value, key);
    assert.ok(Number.isFinite(Date.parse(state.posts.fixture.updatedAt)), 'updatedAt is a timestamp');
    saveState(file, state);
    assert.deepEqual(loadState(file), state);
    assert.deepEqual(fs.readdirSync(dir), ['state.json'], 'no temporary files remain after save');
    assert.equal(shouldSkip(state, 'fixture', {}), true);
    assert.equal(shouldSkip(state, 'fixture', { force: true }), false);
    assert.equal(shouldSkip(state, 'new', {}), false);
    assert.equal(nextStatus(null, 'start'), 'in_progress');
    assert.equal(nextStatus('in_progress', 'draft_ok'), 'draft_created');
    assert.equal(nextStatus('draft_created', 'mark_published'), 'published');
    assert.equal(nextStatus(null, 'skip'), 'skipped');
    for (const status of ['draft_created', 'published']) {
      assert.throws(() => nextStatus(status, 'start'), Error, `${status} must not regress`);
      assert.equal(shouldSkip({ posts: { fixture: { status } } }, 'fixture', {}), true);
    }
    const interrupted = { posts: { fixture: { status: 'in_progress', titleEn: details.titleEn } } };
    saveState(file, interrupted);
    const resumed = loadState(file);
    assert.equal(shouldSkip(resumed, 'fixture', {}), false, 'in_progress remains eligible for reconciliation/retry');
    const recovered = recordDraftCreated(resumed, 'fixture', details);
    saveState(file, recovered);
    assert.equal(loadState(file).posts.fixture.status, 'draft_created');
    const skipped = recordSkipped(emptyState(), 'duplicate', { titleEn: 'Fixture title', note: 'Existing remote draft' });
    assert.equal(skipped.posts.duplicate.status, 'skipped');
    assert.equal(skipped.posts.duplicate.note, 'Existing remote draft');
    assert.equal(skipped.posts.duplicate.titleEn, 'Fixture title');
    assert.equal(normalizeTitle('  Fixture   TITLE  '), normalizeTitle('fixture title'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-11', () => {
  const source = operationalSource(fs.readFileSync(new URL('src/cli.mjs', root), 'utf8'));
  assert.match(source, /isCiEnvironment/, 'CLI must have a CI environment guard');
  function scan(dir) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) scan(file);
      else if (/\.ya?ml$/i.test(entry.name)) {
        assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /substack-draft-poster|src\/cli/i, `${file} must not invoke the local CLI`);
      }
    }
  }
  scan(decodeURIComponent(new URL('.github/workflows/', root).pathname));
});

process.exitCode = failures ? 1 : 0;
