import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EXIT, exitCodeFor, classifyOutcome, buildResult, resolveMeta, resolvePublication, isCiEnvironment, UsageError, parseArgs, LockHeldError, acquireLock, TimeoutError, withDeadline, planTarget } from '../src/modules/substack-contract.mjs';
import { emptyState, loadState, saveState, nextStatus, shouldSkip, recordDraftIncomplete, recordRepaired } from '../src/modules/substack-post-state.mjs';
import * as contract from '../src/modules/substack-contract.mjs';
import { main } from '../src/cli.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
let failures = 0;
async function test(ac, run) {
  try {
    await run();
    console.log(`PASS ${ac}`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${ac}: ${error.message}`);
    console.log('Expected:', error.expected ?? 'successful completion without error');
    console.log('Actual:', error.actual ?? `${error.name}: ${error.message}`);
  }
}
async function fixture(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'substack-contract-'));
  try {
    const input = path.join(dir, 'input');
    fs.mkdirSync(input);
    fs.writeFileSync(path.join(input, 'paid-free-preview.html'), '<h1>Paid title</h1><p>Free</p>');
    fs.writeFileSync(path.join(input, 'paid-paid-body.html'), '<p>Paid</p>');
    fs.writeFileSync(path.join(input, 'free-free-preview.html'), '<h1>Free title</h1><p>Free</p>');
    fs.writeFileSync(path.join(input, 'free.meta.json'), JSON.stringify({ title: 'Meta title', subtitle: 'Meta subtitle' }));
    const stateFile = path.join(dir, 'state.json');
    saveState(stateFile, { posts: { paid: { status: 'draft_incomplete', draftUrl: 'https://example.substack.com/publish/post/1' }, published: { status: 'draft_created', draftUrl: 'https://example.substack.com/publish/post/2' } } });
    const env = { ...process.env, CI: 'false', PLAYWRIGHT_BROWSERS_PATH: '/nonexistent', SUBSTACK_PROFILE_DIR: path.join(dir, 'profile'), SUBSTACK_STATE_FILE: stateFile, SUBSTACK_SCHEMA_FILE: path.join(dir, 'missing-schema.json'), SUBSTACK_PUBLICATION_URL: 'https://example.substack.com' };
    delete env.GITHUB_ACTIONS;
    const deps = { env, isTTY: false, stateFile, lockPath: path.join(dir, 'substack.lock'), schemaFile: env.SUBSTACK_SCHEMA_FILE, repoRoot: dir, launchBrowser: () => { throw new Error('launchBrowser must not be called'); } };
    await run({ dir, input, stateFile, env, deps });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
function subprocess(args, env) {
  const result = spawnSync(process.execPath, [path.join(root, 'src/cli.mjs'), ...args], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 4000 });
  assert.equal(result.error, undefined, `subprocess error: ${result.error}; stderr: ${result.stderr}`);
  assert.equal(result.signal, null, 'subprocess must terminate normally');
  return result;
}
function jsonOutput(calls) {
  assert.equal(calls.length, 1, 'out must be called exactly once');
  assert.match(calls[0], /\n$/, 'JSON must end with newline');
  const result = JSON.parse(calls[0]);
  assert.ok(result && typeof result === 'object' && !Array.isArray(result), 'expected one JSON object');
  return result;
}
async function invoke(args, deps) {
  const out = [], err = [];
  const code = await main(args, { ...deps, out: (text) => out.push(text), err: (text) => err.push(text) });
  return { code, out, err };
}

await test('AC-14', async () => {
  const result = buildResult({ mode: 'post', results: [{ outcome: 'draft_created' }] });
  assert.equal(result.schema, 'substack-post-result/1');
  for (const key of ['mode', 'ok', 'exitCode', 'nextAction', 'remoteCheck', 'results', 'errors']) assert.ok(Object.hasOwn(result, key), `missing ${key}`);
  assert.equal(result.mode, 'post');
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.remoteCheck, 'done');
  assert.deepEqual(result.errors, []);
  assert.equal(result.nextAction, 'human_review_draft');
  assert.equal(buildResult({ mode: 'post', results: [{ outcome: 'repaired' }] }).nextAction, 'human_review_draft');
  assert.equal(buildResult({ mode: 'status', results: [] }).nextAction, 'none');
  for (const [exitCode, action] of [[1, 'ask_user'], [2, 'run_login'], [3, 'ask_user'], [4, 'ask_user'], [5, 'ask_user'], [6, 'retry_later'], [7, 'retry_later'], [64, 'fix_input']]) {
    const value = buildResult({ mode: 'post', results: [], exitCode });
    assert.equal(value.exitCode, exitCode);
    assert.equal(value.ok, false);
    assert.equal(value.nextAction, action, `exit ${exitCode}`);
  }
  assert.equal(buildResult({ mode: 'post', results: [{ outcome: 'draft_incomplete', reason: 'paywall_fixture_missing' }] }).nextAction, 'run_probe');
  assert.equal(buildResult({ mode: 'post', results: [], nextAction: 'ask_user' }).nextAction, 'ask_user');
  await fixture(async ({ input, env }) => {
    const json = subprocess(['--status', '--json', `--in-dir=${input}`], env);
    assert.equal(json.status, 0, json.stderr);
    const parsed = jsonOutput([json.stdout]);
    assert.equal(parsed.schema, 'substack-post-result/1');
    assert.equal(parsed.mode, 'status');
    assert.equal(parsed.ok, true);
    assert.equal(parsed.exitCode, 0);
    assert.equal(parsed.nextAction, 'none');
    assert.equal(parsed.remoteCheck, 'skipped');
    assert.ok(Array.isArray(parsed.results));
    assert.ok(Array.isArray(parsed.errors));
    const human = subprocess(['--status', `--in-dir=${input}`], env);
    assert.equal(human.status, 0, human.stderr);
    assert.ok(human.stdout.trim(), 'human output must not be empty');
    assert.throws(() => JSON.parse(human.stdout), SyntaxError);
  });
});

await test('AC-15', () => {
  assert.deepEqual(EXIT, { OK: 0, ERROR: 1, NOT_LOGGED_IN: 2, CI_REFUSED: 3, PARTIAL: 4, INCOMPLETE: 5, LOCK_HELD: 6, TIMEOUT: 7, USAGE: 64 });
  assert.equal(Object.isFrozen(EXIT), true);
  for (const [outcomes, expected] of [[[], 0], [['planned', 'draft_created', 'repaired', 'skipped_state', 'skipped_remote'], 0], [['failed', 'draft_created'], 4], [['failed', 'failed'], 1], [['draft_incomplete'], 5], [['failed', 'draft_incomplete'], 4]]) {
    assert.equal(exitCodeFor(outcomes.map((outcome) => ({ outcome }))), expected, JSON.stringify(outcomes));
  }
  assert.equal(exitCodeFor([{ slug: 'status' }]), 0);

});

await test('AC-16', async () => {
  await fixture(async ({ env }) => {
    for (const args of [['--login'], ['--open'], ['--open', '--json']]) {
      const started = Date.now();
      const result = subprocess(args, env);
      assert.equal(result.status, 64, `${args}: ${result.stderr}`);
      assert.ok(Date.now() - started < 10000, `${args} must finish within 10 seconds`);
    }
  });
  assert.equal(isCiEnvironment({}), false);
  for (const CI of ['', '0', 'false', 'FALSE', 'False']) assert.equal(isCiEnvironment({ CI }), false, `CI=${CI}`);
  for (const CI of ['1', 'true', 'yes']) assert.equal(isCiEnvironment({ CI }), true, `CI=${CI}`);
  for (const GITHUB_ACTIONS of ['', 'false', 'true']) assert.equal(isCiEnvironment({ CI: 'false', GITHUB_ACTIONS }), true);
  await fixture(async ({ deps }) => {
    const ci = { ...deps, env: { ...deps.env, CI: 'true' } };
    assert.equal((await invoke(['--json'], ci)).code, 3);
    assert.equal((await invoke(['--help'], ci)).code, 0);
    assert.equal((await invoke(['--status', '--json'], ci)).code, 0);
  });
});

await test('AC-17', async () => {
  await fixture(async ({ dir, input, stateFile, deps }) => {
    const before = fs.readFileSync(stateFile);
    for (const flag of ['--help', '--status', '--dry-run']) {
      const result = await invoke([flag, '--json', `--in-dir=${input}`], deps);
      assert.equal(result.code, 0, `${flag}: ${result.err.join('')}`);
      if (flag !== '--help') {
        const parsed = jsonOutput(result.out);
        assert.equal(parsed.remoteCheck, 'skipped');
      }
      assert.deepEqual(fs.readFileSync(stateFile), before, `${flag} must not change state`);
    }
    const snapshot = (directory) => Object.fromEntries(fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const file = path.join(directory, entry.name);
      return entry.isDirectory() ? Object.entries(snapshot(file)) : [[file, fs.readFileSync(file).toString('base64')]];
    }));
    const files = snapshot(dir);
    const marked = await invoke(['--mark-published=published', '--json'], deps);
    assert.equal(marked.code, 0, marked.err.join(''));
    assert.equal(loadState(stateFile).posts.published.status, 'published');
    assert.deepEqual(loadState(stateFile).posts.paid, JSON.parse(before).posts.paid);
    delete files[stateFile];
    const after = snapshot(dir);
    delete after[stateFile];
    assert.deepEqual(after, files, 'mark-published may only change state; lock must be released');
  });
});

await test('AC-18', () => {
  const contentBlogJson = { title_en: 'Blog title', excerpt_en: 'Blog subtitle' };
  const freeHtml = '<h1>HTML <em>title</em></h1><p>Body</p>';
  assert.deepEqual(resolveMeta({ metaJson: { title: 'Meta', subtitle: 'Subtitle' }, contentBlogJson, freeHtml }), { title: 'Meta', subtitle: 'Subtitle', titleSource: 'meta_json', subtitleSource: 'meta_json' });
  assert.deepEqual(resolveMeta({ metaJson: null, contentBlogJson, freeHtml }), { title: 'HTML title', subtitle: '', titleSource: 'h1', subtitleSource: 'none' });
  assert.deepEqual(resolveMeta({ freeHtml }), { title: 'HTML title', subtitle: '', titleSource: 'h1', subtitleSource: 'none' });
  assert.deepEqual(resolveMeta({ metaJson: null, contentBlogJson: null, freeHtml: '<p>No heading</p>' }), { error: 'missing_title' });
  const defaultUrl = 'https://default.example/';
  const env = { SUBSTACK_PUBLICATION_URL: 'https://env.example/' };
  assert.equal(resolvePublication({ flag: 'https://flag.example/', env, defaultUrl }), 'https://flag.example');
  assert.equal(resolvePublication({ env, defaultUrl }), 'https://env.example');
  assert.throws(() => resolvePublication({ env: {}, defaultUrl }), e => e.code === 'invalid_publication');
  for (const flag of ['http://bad.example', 'https://bad.example/path', '', 'not a URL']) assert.throws(() => resolvePublication({ flag, env: {}, defaultUrl }), (error) => error instanceof Error && error.code === 'invalid_publication', `reject ${flag}`);
  assert.equal(parseArgs([]).limit, 1);
  const opts = parseArgs(['--dry-run', '--force', '--in-dir=/tmp/input', '--slug=one', '--limit=2', '--publication=https://example.com']);
  assert.equal(opts['dry-run'], true);
  assert.equal(opts['in-dir'], '/tmp/input');
  assert.equal(opts.slug, 'one');
  assert.equal(opts.limit, 2);
  for (const args of [['--unknown'], ['positional'], ['--slug'], ['--slug='], ['--json=true'], ['--open', '--json'], ['--login', '--status'], ['--login', '--dry-run'], ['--login', '--mark-published=x'], ['--limit=0'], ['--limit=1.5'], ['--limit=bad']]) assert.throws(() => parseArgs(args), (error) => error instanceof UsageError && error.exitCode === 64, args.join(' '));
});

await test('AC-19', () => {
  for (const [hasPaid, paywallInserted, paidBodyInserted, editorReachable, outcome, reason, paywall, paidBody] of [
    [true, true, true, false, 'draft_incomplete', 'editor_unreachable', false, false],
    [false, false, false, false, 'draft_incomplete', 'editor_unreachable', false, false],
    [true, false, true, true, 'draft_incomplete', 'paywall_fixture_missing', false, false],
    [true, true, false, true, 'draft_incomplete', 'paid_body_missing', true, false],
    [true, true, true, true, 'draft_created', null, true, true],
    [false, false, false, true, 'draft_created', null, null, null],
  ]) assert.deepEqual(classifyOutcome({ hasPaid, paywallInserted, paidBodyInserted, editorReachable }), { outcome, reason, completeness: { freePreview: true, paywall, paidBody } });
  const original = emptyState();
  const details = { draftUrl: 'https://example.substack.com/publish/post/1', titleEn: 'Title', sourceHash: 'hash', completeness: { freePreview: true, paywall: false, paidBody: false }, reason: 'paywall_fixture_missing' };
  const state = recordDraftIncomplete(original, 'one', details);
  assert.deepEqual(original, emptyState(), 'record must be immutable');
  assert.equal(state.posts.one.status, 'draft_incomplete');
  for (const [key, value] of Object.entries(details)) assert.deepEqual(state.posts.one[key], value, key);
  assert.equal(shouldSkip(state, 'one', {}), false);
  assert.equal(shouldSkip(state, 'one', { force: true }), false);
  for (const remoteMatch of [undefined, { url: details.draftUrl }]) assert.deepEqual(planTarget({ entry: state.posts.one, remoteMatch }), { action: 'repair', reuseDraftUrl: details.draftUrl });
  for (const status of ['draft_created', 'published']) {
    assert.deepEqual(planTarget({ entry: { status } }), { action: 'skip', reason: 'state_skip' });
    assert.deepEqual(planTarget({ entry: { status }, force: true }), { action: 'create' });
    assert.throws(() => nextStatus(status, 'draft_incomplete'), Error);
  }
  assert.deepEqual(planTarget({ remoteMatch: { url: 'https://example.com/draft' } }), { action: 'skip', reason: 'remote_duplicate' });
  assert.deepEqual(planTarget({ force: true, remoteMatch: { url: 'https://example.com/draft' } }), { action: 'skip', reason: 'remote_duplicate' });
  assert.deepEqual(planTarget({}), { action: 'create' });
  for (const status of [null, undefined, 'in_progress', 'draft_incomplete']) assert.equal(nextStatus(status, 'draft_incomplete'), 'draft_incomplete');
  assert.equal(nextStatus('draft_incomplete', 'repair_ok'), 'draft_created');
  assert.throws(() => nextStatus('draft_incomplete', 'start'), Error);
  const completeness = { freePreview: true, paywall: true, paidBody: true };
  const repaired = recordRepaired(state, 'one', { completeness });
  assert.equal(repaired.posts.one.status, 'draft_created');
  assert.equal(repaired.posts.one.reason, null);
  assert.deepEqual(repaired.posts.one.completeness, completeness);
  assert.equal(repaired.posts.one.draftUrl, details.draftUrl);
  assert.equal(state.posts.one.status, 'draft_incomplete');
});

await test('AC-20', async () => {
  await fixture(async ({ dir }) => {
    const lockPath = path.join(dir, 'test.lock');
    const first = acquireLock(lockPath, { pid: 123, isAlive: () => true, now: () => 123456 });
    assert.equal(first.stale, false);
    const stored = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    assert.equal(stored.pid, 123);
    assert.ok(Object.hasOwn(stored, 'startedAt'));
    assert.throws(() => acquireLock(lockPath, { isAlive: (pid) => { assert.equal(pid, 123); return true; } }), (error) => error instanceof LockHeldError && error.exitCode === 6);
    assert.deepEqual(JSON.parse(fs.readFileSync(lockPath, 'utf8')), stored, 'live lock must remain intact');
    first.release();
    assert.equal(fs.existsSync(lockPath), false);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 456, startedAt: 1 }));
    const stale = acquireLock(lockPath, { pid: 789, isAlive: (pid) => { assert.equal(pid, 456); return false; } });
    assert.equal(stale.stale, true);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).pid, 789);
    stale.release();
    const again = acquireLock(lockPath, { isAlive: () => true });
    assert.equal(again.stale, false);
    again.release();
    assert.equal(fs.existsSync(lockPath), false);
  });
});

await test('AC-21', async () => {
  const started = Date.now();
  await assert.rejects(withDeadline(() => new Promise(() => {}), 50), (error) => error instanceof TimeoutError && error.exitCode === 7);
  assert.ok(Date.now() - started < 1000, 'deadline must reject promptly');
  assert.equal(await withDeadline(async () => 'completed', 50), 'completed');
  assert.equal(parseArgs([]).timeout, 900);
  for (const timeout of ['1', '3600']) assert.equal(parseArgs([`--timeout=${timeout}`]).timeout, Number(timeout));
  for (const timeout of ['0', '-1', '3601', '1.5', 'abc', '']) assert.throws(() => parseArgs([`--timeout=${timeout}`]), (error) => error instanceof UsageError && error.exitCode === 64, `timeout=${timeout}`);
});

await test('AC-22', async () => {
  await fixture(async ({ input, stateFile, deps }) => {
    const before = fs.readFileSync(stateFile);
    const result = await invoke(['--status', '--json', `--in-dir=${input}`], deps);
    assert.equal(result.code, 0, result.err.join(''));
    const parsed = jsonOutput(result.out);
    assert.equal(parsed.mode, 'status');
    assert.equal(parsed.exitCode, 0);
    assert.equal(parsed.nextAction, 'none');
    assert.equal(parsed.remoteCheck, 'skipped');
    const rows = new Map(parsed.results.map((row) => [row.slug, row]));
    for (const slug of ['paid', 'free']) {
      assert.ok(rows.has(slug), `missing ${slug}`);
      for (const key of ['slug', 'hasFree', 'hasPaid', 'meta', 'stateStatus', 'draftUrl', 'eligible', 'blockedBy']) assert.ok(Object.hasOwn(rows.get(slug), key), `${slug}: missing ${key}`);
      assert.equal(rows.get(slug).hasFree, true);
    }
    assert.equal(rows.get('paid').hasPaid, true);
    assert.equal(rows.get('paid').eligible, false);
    assert.ok(rows.get('paid').blockedBy.includes('paywall_fixture_missing'));
    assert.equal(rows.get('paid').stateStatus, 'draft_incomplete');
    assert.equal(rows.get('paid').draftUrl, loadState(stateFile).posts.paid.draftUrl);
    assert.deepEqual(rows.get('paid').meta, { titleSource: 'h1', subtitleSource: 'none' });
    assert.equal(rows.get('free').hasPaid, false);
    assert.equal(rows.get('free').eligible, true);
    assert.deepEqual(rows.get('free').blockedBy, []);
    assert.deepEqual(rows.get('free').meta, { titleSource: 'meta_json', subtitleSource: 'meta_json' });
    assert.deepEqual(fs.readFileSync(stateFile), before, 'status must preserve state bytes');
  });
});



// ---------------------------------------------------------------------------
// QA regression tests (defects found by an earlier audit).
// 実ブラウザは使わず、Playwright の Page を最小限に模した偽物で main() のブラウザ経路を通す。
// ---------------------------------------------------------------------------
function fakeBrowser({ origin, failTitle, stateFile, newPostMissing = false, redirectToSignIn = false,
  apiStatus = 200, remote = {}, incompleteList = false, newPostTimeout = false,
  saveTimeout = false, titleMismatch = false, saveRateLimited = false, persistedJson, persistedUnreachable = false, injectInsertion,
  editorJson = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Free' }] }] } }) {
  const log = { titleFills: [], subtitleFills: [], injects: 0, closed: false, gotos: [], gets: [],
    stateAtTitle: [], urlWaits: [], responseWaits: [], events: [] };
  let current = `${origin}/publish/posts/drafts`;
  let draftId = 100;
  const saved = new Map();
  let notifyInjection;
  const locator = () => new Proxy({}, { get: (_, prop) => {
    if (prop === 'first') return () => locator();
    if (['waitFor', 'click', 'evaluate'].includes(prop)) return async () => {};
    if (['isVisible', 'isEnabled'].includes(prop)) return async () => false;
    if (prop === 'evaluateAll') return async () => [];
    return undefined;
  } });
  const response = (status, body) => ({ ok: () => status >= 200 && status < 300, status: () => status, json: async () => body });
  const request = { get: async (url) => {
    log.gets.push(url); log.events.push('get');
    const u = new URL(url);
    const kind = u.pathname.split('/').at(-1);
    assert.ok(['drafts', 'published'].includes(kind), `unexpected GET: ${url}`);
    const offset = Number(u.searchParams.get('offset'));
    const limit = Number(u.searchParams.get('limit'));
    if (apiStatus !== 200) return response(apiStatus, {});
    if (saveRateLimited && log.injects && kind === 'drafts') return response(429, {});
    const posts = [...(remote[kind] ?? []), ...(kind === 'drafts' ? [...saved].map(([id, title]) =>
      ({ id, title: null, draft_title: titleMismatch ? 'Wrong title' : title, slug: null, is_published: false })) : [])];
    return response(200, { posts: posts.slice(offset, offset + limit), offset, limit,
      total: posts.length + (incompleteList ? 1 : 0), isCapped: false });
  } };
  const page = {
    goto: async (url) => {
      log.gotos.push(url); log.events.push('goto');
      current = redirectToSignIn && url.includes('/publish/posts/drafts') ? `${origin}/sign-in` : url;
      if (new URL(url).pathname === '/publish/post') draftId++;
    },
    url: () => current,
    waitForURL: async (pattern, opts) => {
      log.urlWaits.push(opts);
      if (newPostTimeout) throw new Error('URL timeout');
      current = `${origin}/publish/post/${draftId}`;
      assert.ok(pattern instanceof RegExp ? pattern.test(current) : current === pattern);
    },
    waitForResponse: async (predicate, opts) => {
      log.responseWaits.push(opts);
      if (saveTimeout) throw new Error('save timeout');
      if (!log.injects) await new Promise(resolve => { notifyInjection = resolve; });
      const id = new URL(current).pathname.split('/').at(-1);
      const make = (method, suffix = '', status = 200) => ({ url: () => `${origin}/api/v1/drafts/${id}${suffix}`,
        request: () => ({ method: () => method }), status: () => status });
      for (const decoy of [make('GET'), make('PUT', '/theme'), make('PUT', '', 500)])
        assert.equal(Boolean(predicate(decoy)), false, 'save predicate must reject unrelated or failed responses');
      const event = make('PUT');
      assert.equal(Boolean(predicate(event)), true, 'save predicate must accept successful PUT of this draft');
      log.events.push('save-response');
      return event;
    },
    getByRole: (_role, opts) => (newPostMissing && opts?.name?.source?.includes('new post') ? new Proxy({}, { get: (_, prop) => (prop === 'first' ? () => ({ waitFor: async () => { throw new Error('locator timeout'); } }) : undefined) }) : locator()),
    getByText: () => locator(),
    locator: () => locator(),
    waitForFunction: async () => {},
    close: async () => {},
    getByPlaceholder: (re) => ({ fill: async (value) => {
      if (re.source.includes('subtitle')) { log.subtitleFills.push(value); return; }
      log.titleFills.push(value); log.events.push('title');
      log.stateAtTitle.push(loadState(stateFile));
      if (value === failTitle) throw new Error('simulated editor failure');
      saved.set(Number(new URL(current).pathname.split('/').at(-1)) || draftId, value);
    } }),
    evaluate: async (_fn, arg) => {
      if (arg?.action === 'inject') {
        log.injects++; log.events.push('inject');
        notifyInjection?.();
        // Earlier-contract compatibility: its URL only becomes a draft URL during injection.
        if (new URL(current).pathname === '/publish/post') current = `${origin}/publish/post/${draftId}`;
        return { reachable: true, json: editorJson, ...(injectInsertion === undefined ? {} : { insertion: injectInsertion }) };
      }
      if (arg?.action === 'snapshot') {
        log.snapshots = (log.snapshots ?? 0) + 1;
        return persistedUnreachable ? { reachable: false } : { reachable: true, json: persistedJson ?? editorJson };
      }
      return undefined;
    },
  };
  const context = { request, newPage: async () => page, close: async () => { log.closed = true; }, once() {} };
  return { context, log };
}
async function runWithFakeBrowser(setup, args, failTitle, cfg = {}) {
  const origin = 'https://example.substack.com';
  let result;
  await fixture(async ({ dir, input, env, stateFile }) => {
    for (const f of fs.readdirSync(input)) fs.rmSync(path.join(input, f));
    saveState(stateFile, emptyState());
    setup(input, stateFile);
    if (cfg.initialState) saveState(stateFile, cfg.initialState);
    if (cfg.schema) fs.writeFileSync(env.SUBSTACK_SCHEMA_FILE, JSON.stringify(cfg.schema));
    const profileDir = path.join(dir, 'private', 'profile');
    const { context, log } = fakeBrowser({ origin, failTitle, stateFile, ...cfg });
    const deps = { env: { ...env, SUBSTACK_PROFILE_DIR: profileDir }, isTTY: false, stateFile, lockPath: path.join(dir, 'substack.lock'), schemaFile: env.SUBSTACK_SCHEMA_FILE, repoRoot: dir, timeouts: { newPostUrl: 50, save: 50, settle: 0, persistedRead: 0 }, launchBrowser: async () => context };
    const run = await invoke([...args, `--in-dir=${input}`, '--json'], deps);
    // フィクスチャ削除前に、main() が作ったプロファイルの権限を記録する
    result = { run, log, state: loadState(stateFile), profileDir, profileMode: fs.existsSync(profileDir) ? fs.statSync(profileDir).mode & 0o777 : null };
  });
  return result;
}

await test('QA-1 投稿ループで1件が失敗しても残りを処理し、部分成功(4)として報告する', async () => {
  const { run, log, state } = await runWithFakeBrowser((input) => {
    fs.writeFileSync(path.join(input, 'a-free-preview.html'), '<h1>Title A</h1><p>x</p>');
    fs.writeFileSync(path.join(input, 'b-free-preview.html'), '<h1>Title B</h1><p>y</p>');
  }, ['--limit=2'], 'Title A');
  const result = jsonOutput(run.out);
  assert.equal(run.code, 4, `expected partial success (4), got ${run.code}: ${JSON.stringify(result.errors)}`);
  const a = result.results.find((r) => r.slug === 'a');
  const b = result.results.find((r) => r.slug === 'b');
  assert.equal(a?.outcome, 'failed', 'failed slug must appear in results');
  assert.equal(b?.outcome, 'draft_created', 'later slug must still be processed');
  assert.equal(state.posts.b.status, 'draft_created');
  assert.equal(log.injects, 1);
  assert.equal(log.closed, true, 'browser must be closed');
});

await test('QA-2 サブタイトルが空なら欄に触れず、あるときだけ入力する', async () => {
  const { run, log } = await runWithFakeBrowser((input) => {
    fs.writeFileSync(path.join(input, 'n-free-preview.html'), '<h1>No subtitle</h1><p>x</p>');
    fs.writeFileSync(path.join(input, 's-free-preview.html'), '<h1>x</h1><p>y</p>');
    fs.writeFileSync(path.join(input, 's.meta.json'), JSON.stringify({ title: 'With subtitle', subtitle: 'Sub text' }));
  }, ['--limit=2']);
  assert.equal(run.code, 0, run.out.join(''));
  assert.deepEqual(log.subtitleFills, ['Sub text'], 'empty subtitle must not be filled');
});

await test('QA-3 stale ロック奪取の競合: 他者が作った新しいロックを消さない／消えていても奪取できる', async () => {
  await fixture(async ({ dir }) => {
    const lockPath = path.join(dir, 'race.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 456, startedAt: 1, token: 'old' }));
    assert.throws(() => acquireLock(lockPath, { pid: 789, isAlive: () => {
      fs.writeFileSync(lockPath, JSON.stringify({ pid: 999, startedAt: 2, token: 'fresh' }));
      return false;
    } }), (error) => error instanceof LockHeldError && error.exitCode === 6);
    assert.equal(JSON.parse(fs.readFileSync(lockPath, 'utf8')).token, 'fresh', 'a lock created by another process must not be removed');
    fs.rmSync(lockPath);
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 456, startedAt: 1, token: 'old' }));
    const taken = acquireLock(lockPath, { pid: 789, isAlive: () => { fs.unlinkSync(lockPath); return false; } });
    assert.equal(taken.stale, true);
    taken.release();
  });
});

await test('QA-4 プロファイルディレクトリは 0700 で作り、緩い既存ディレクトリは変更せず警告対象にする', async () => {
  await fixture(async ({ dir }) => {
    assert.equal(typeof contract.ensurePrivateDir, 'function', 'ensurePrivateDir must be exported');
    const target = path.join(dir, 'a', 'b');
    const created = contract.ensurePrivateDir(target);
    assert.equal(created.created, true);
    assert.equal(created.loose, false);
    assert.equal(fs.statSync(target).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.join(dir, 'a')).mode & 0o077, 0, 'parents created by us must not be group/other accessible');
    const loose = path.join(dir, 'loose');
    fs.mkdirSync(loose, { mode: 0o755 });
    fs.chmodSync(loose, 0o755);
    const existing = contract.ensurePrivateDir(loose);
    assert.equal(existing.created, false);
    assert.equal(existing.loose, true);
    assert.equal(fs.statSync(loose).mode & 0o777, 0o755, 'an existing directory must not be chmod-ed');
  });
  const { profileMode } = await runWithFakeBrowser((input) => {
    fs.writeFileSync(path.join(input, 'p-free-preview.html'), '<h1>P</h1><p>x</p>');
  }, ['--limit=1']);
  assert.equal(profileMode, 0o700, 'main() must create the browser profile directory as 0700 before launching the browser');
});







await test('AC-27', () => {
  assert.equal(typeof contract.browserLaunchOptions, 'function', 'browserLaunchOptions must be exported as a function');
  const o = contract.browserLaunchOptions();
  assert.equal(o.headless, false);
  assert.equal(o.viewport, null, 'viewport must be explicitly null');
  assert.equal(Array.isArray(o.args), true, 'args must be an array');
  assert.equal(o.args.includes('--window-size=1280,900'), true);
  const second = contract.browserLaunchOptions();
  assert.notStrictEqual(o, second, 'each call must return a new object');
  o.headless = true;
  o.viewport = { width: 1, height: 1 };
  o.args.push('--test-mutation');
  assert.equal(second.headless, false, 'mutating first result must not affect second');
  assert.equal(second.viewport, null);
  assert.equal(second.args.includes('--test-mutation'), false, 'args must not be shared between calls');

  const source = fs.readFileSync(path.join(root, 'src/cli.mjs'), 'utf8');
  const declaration = /export async function launchBrowser\b[\s\S]*?\)\s*\{/.exec(source);
  assert.ok(declaration, 'launchBrowser declaration must exist');
  const bodyStart = declaration.index + declaration[0].length - 1;
  let depth = 1;
  let end = bodyStart + 1;
  // Skip strings and comments so their braces cannot terminate the function body.
  const tokens = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|[{}]/g;
  tokens.lastIndex = end;
  for (let token; depth && (token = tokens.exec(source));) {
    if (token[0] === '{') depth++;
    if (token[0] === '}') depth--;
    end = tokens.lastIndex;
  }
  assert.equal(depth, 0, 'launchBrowser body must have a matching closing brace');
  const body = source.slice(bodyStart, end);
  assert.match(body, /\blaunchPersistentContext\s*\(/);
  assert.match(body, /\bbrowserLaunchOptions\s*\(/);
  assert.equal([...source.matchAll(/\blaunchPersistentContext\s*\(/g)].length, 1, 'exactly one launchPersistentContext call is allowed');
  const probe = fs.readFileSync(path.join(root, 'src/probe.mjs'), 'utf8');
  assert.equal(probe.includes('launchPersistentContext'), false, 'probe must launch through launchBrowser');
});




// Absent modules fail only their own tests, never module loading.
const api = await import('../src/modules/substack-api.mjs').catch(() => null);
const ui = await import('../src/modules/substack-ui.mjs').catch(() => null);
const origin = 'https://example.substack.com';
const requireApi = () => assert.ok(api, 'substack-api.mjs must exist and load');
const singleArticle = input => fs.writeFileSync(path.join(input, 'a-free-preview.html'), '<h1>Title A</h1><p>Free</p>');
const newVisits = log => log.gotos.filter(url => new URL(url).pathname === '/publish/post');
const runArticle = (cfg = {}, setup = singleArticle, args = ['--slug=a']) => {
  // The earlier list traversal has real polling delays; fail fast when the newer modules are absent.
  requireApi();
  return runWithFakeBrowser(setup, args, undefined, cfg);
};
function assertGlobal(run, code, nextAction) {
  const result = jsonOutput(run.out);
  assert.equal(run.code, 1, JSON.stringify(result));
  assert.equal(result.errors[0]?.code, code);
  if (nextAction) assert.equal(result.nextAction, nextAction);
  return result;
}
function assertOutcome(run, outcome, reason) {
  const result = jsonOutput(run.out);
  assert.equal(result.results.find(r => r.slug === 'a')?.outcome, outcome, JSON.stringify(result));
  if (reason) assert.equal(result.results.find(r => r.slug === 'a')?.reason, reason);
}

await test('AC-29', () => {
  assert.ok(ui, 'substack-ui.mjs must exist and load');
  assert.equal(ui.UI_OBSERVED_ON, '2026-11-15');
  assert.equal(ui.NEW_POST_PATH, '/publish/post?type=newsletter');
  assert.equal(ui.DASHBOARD_DRAFTS_PATH, '/publish/posts/drafts');
  assert.deepEqual(ui.LIST_ORDER, { drafts: 'draft_updated_at', published: 'post_date' });
  assert.ok(ui.DRAFT_PATH_RE instanceof RegExp);
  assert.match('/publish/post/123', ui.DRAFT_PATH_RE);
  assert.equal(ui.SAVE_REQUEST.method, 'PUT');
  assert.ok(ui.SAVE_REQUEST.pathRe instanceof RegExp);
  assert.match('/api/v1/drafts/123', ui.SAVE_REQUEST.pathRe);
  assert.doesNotMatch('/api/v1/drafts/123/theme', ui.SAVE_REQUEST.pathRe);
});

// Preserve strings while removing comments: URLs inside strings are not comments.
function withoutComments(source) {
  return source.replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,
    token => token.startsWith('//') || token.startsWith('/*') ? token.replace(/[^\n]/g, ' ') : token);
}
await test('AC-30', () => {
  const dir = path.join(root, 'src/diagnostics');
  const files = fs.readdirSync(dir).filter(file => file.endsWith('.mjs'));
  assert.ok(files.length > 0, 'at least one diagnostic is required');
  for (const file of files) {
    const full = path.join(dir, file);
    const source = withoutComments(fs.readFileSync(full, 'utf8'));
    assert.doesNotMatch(source, /\.\s*(?:click|fill|type|press)\s*\(|\b(?:setContent|insertContent)\s*\(|\brequest\s*\.\s*(?:post|put|patch|delete|fetch)\b/, file);
    for (const call of source.matchAll(/\bpage\s*\.\s*goto\s*\(\s*([^,\n)]+)/g)) {
      assert.ok(['`${origin}${route}`', '`${origin}/publish/posts/${kind}`', '`${origin}/publish/posts/drafts`', 'draftUrl'].includes(call[1].trim()), `${file}: forbidden goto ${call[1]}`);
    }
    const checked = spawnSync(process.execPath, ['--check', full], { encoding: 'utf8', timeout: 4000 });
    assert.equal(checked.error, undefined);
    assert.equal(checked.status, 0, checked.stderr);
  }
});

function getOnly(handler) {
  const calls = [];
  return { calls, request: { get: async url => {
    calls.push(url);
    const { status = 200, body } = await handler(new URL(url), calls.length);
    return { ok: () => status >= 200 && status < 300, status: () => status, json: async () => body };
  } } };
}
await test('AC-31 pagination and titles', async () => {
  requireApi();
  const expected = `${origin}/api/v1/post_management/drafts?offset=0&limit=25&order_by=draft_updated_at&order_direction=desc`;
  assert.equal(api.buildListUrl(origin, 'drafts', { offset: 0, limit: 25 }), expected);
  assert.equal(api.buildListUrl(origin, 'published', { offset: 0, limit: 25 }), `${origin}/api/v1/post_management/published?offset=0&limit=25&order_by=post_date&order_direction=desc`);
  for (const kind of ['drafts', 'published']) {
    const rows = Array.from({ length: 31 }, (_, id) => ({ id, title: kind === 'drafts' ? null : `Title ${id}`, draft_title: kind === 'drafts' ? `Title ${id}` : 'Wrong', slug: `slug-${id}`, is_published: kind === 'published' }));
    rows[30].title = ''; rows[30].draft_title = '';
    const { request, calls } = getOnly(u => ({ body: { posts: rows.slice(Number(u.searchParams.get('offset')), Number(u.searchParams.get('offset')) + 25), total: 31, isCapped: false } }));
    assert.deepEqual(Object.keys(request), ['get']);
    const result = await api.fetchAllPosts(request, origin, kind, { limit: 25 });
    assert.deepEqual(calls, [0, 25].map(offset => api.buildListUrl(origin, kind, { offset, limit: 25 })));
    assert.equal(result.total, 31);
    assert.deepEqual(result.posts, rows.slice(0, 30).map(row => ({ id: row.id, title: row.title || row.draft_title, slug: row.slug, isPublished: row.is_published })));
    assert.equal(api.findRemoteMatch(result.posts, '  ＴＩＴＬＥ   0 '), result.posts[0]);
    assert.equal(api.findRemoteMatch(result.posts, 'absent'), undefined);
  }
});
for (const [label, handler, options, expected, count] of [
  ['429', () => ({ status: 429 }), {}, 'rate_limited', 1],
  ['500', () => ({ status: 500 }), {}, 'unexpected_status', 1],
  ['missing posts', () => ({ body: { total: 0 } }), {}, 'unexpected_shape', 1],
  ['invalid total', () => ({ body: { posts: [], total: '0' } }), {}, 'unexpected_shape', 1],
  ['capped', () => ({ body: { posts: [], total: 0, isCapped: true } }), {}, 'capped', 1],
  ['empty second page', (_u, n) => ({ body: { posts: n === 1 ? [{ id: 1, draft_title: 'One' }] : [], total: 2 } }), { limit: 1 }, 'incomplete', 2],
  ['maxPages', () => ({ body: { posts: [{ id: 1, draft_title: 'One' }], total: 2 } }), { limit: 1, maxPages: 1 }, 'incomplete', 1],
]) await test(`AC-31 ${label}`, async () => {
  requireApi();
  const { request, calls } = getOnly(handler);
  await assert.rejects(() => api.fetchAllPosts(request, origin, 'drafts', options), e => e instanceof api.RemoteListError && e.code === expected);
  assert.equal(calls.length, count, 'must stop without extra requests');
});
for (const [label, status, body, expected] of [
  ['logged in', 200, { posts: [] }, 'logged_in'],
  ['401', 401, {}, { unknown: 'unexpected_status' }],
  ['500', 500, {}, { unknown: 'unexpected_status' }],
  ['shape', 200, {}, { unknown: 'unexpected_shape' }],
  ['429', 429, {}, null],
]) await test(`AC-31 login ${label}`, async () => {
  requireApi();
  const { request, calls } = getOnly(() => ({ status, body }));
  if (status === 429) await assert.rejects(() => api.checkLoginByApi(request, origin), e => e instanceof api.RemoteListError && e.code === 'rate_limited');
  else assert.deepEqual(await api.checkLoginByApi(request, origin), expected);
  assert.equal(calls.length, 1);
  assert.equal(calls[0], api.buildListUrl(origin, 'drafts', { offset: 0, limit: 1 }));
});

for (const status of [200, 401, 500, 429]) await test(`AC-32 ${status}`, async () => {
  const { run, log, state } = await runArticle({ apiStatus: status, redirectToSignIn: status === 401, newPostMissing: status !== 200 });
  const result = jsonOutput(run.out);
  if (status === 200) {
    assert.equal(run.code, 0);
    assert.equal(log.gotos.includes(`${origin}/publish/posts/drafts`), false);
    assert.ok(log.gets.length > 0);
  } else {
    assert.deepEqual(state.posts, {});
    if (status === 401) { assert.equal(run.code, 2); assert.equal(result.nextAction, 'run_login'); }
    if (status === 500) { assertGlobal(run, 'login_state_unknown'); assert.notEqual(result.nextAction, 'run_login'); }
    if (status === 429) { assertGlobal(run, 'rate_limited', 'retry_later'); assert.equal(log.gets.length, 1); assert.deepEqual(log.gotos, []); }
  }
});
for (const kind of ['drafts', 'published']) await test(`AC-33 duplicate ${kind}`, async () => {
  const { run, log } = await runArticle({ remote: { [kind]: [{ id: 7, title: kind === 'drafts' ? null : 'Title A', draft_title: 'Title A', slug: 'remote', is_published: kind === 'published' }] } });
  assertOutcome(run, 'skipped_remote');
  assert.equal(run.code, 0);
  assert.deepEqual(newVisits(log), []);
});
await test('AC-33 incomplete list', async () => {
  const { run, log, state } = await runArticle({ incompleteList: true });
  const result = assertGlobal(run, 'remote_list_incomplete');
  assert.equal(result.results.some(r => r.slug === 'a'), false);
  assert.deepEqual(newVisits(log), []);
  assert.deepEqual(state.posts, {});
});
await test('AC-34 draft URL persisted before title', async () => {
  const { run, log, state } = await runArticle();
  assert.equal(run.code, 0);
  assert.ok(ui, 'UI constants required');
  assert.deepEqual(newVisits(log), [`${origin}${ui.NEW_POST_PATH}`]);
  assert.equal(log.urlWaits.length, 1);
  assert.equal(log.urlWaits[0].timeout, 50);
  assert.equal(log.stateAtTitle[0]?.posts.a?.status, 'in_progress');
  assert.equal(log.stateAtTitle[0]?.posts.a?.draftUrl, `${origin}/publish/post/101`);
  assert.equal(state.posts.a.draftUrl, `${origin}/publish/post/101`);
});
await test('AC-34 unconfirmed new URL', async () => {
  const { run, log, state } = await runArticle({ newPostTimeout: true });
  assertOutcome(run, 'failed', 'new_post_unconfirmed');
  assert.notEqual(state.posts.a?.status, 'draft_created');
  assert.deepEqual(log.titleFills, []);
});
await test('AC-35 planTarget recovery', () => {
  for (const remoteMatch of [undefined, { id: 42, title: 'Title A' }]) {
    assert.deepEqual(planTarget({ entry: { status: 'in_progress', draftUrl: `${origin}/publish/post/42` }, remoteMatch, force: false }), { action: 'repair', reuseDraftUrl: `${origin}/publish/post/42` });
  }
  assert.equal(planTarget({ entry: { status: 'in_progress' }, force: false }).action, 'create');
});
await test('AC-35 main recovery', async () => {
  const draftUrl = `${origin}/publish/post/42`;
  const { run, log, state } = await runArticle({ initialState: { posts: { a: { status: 'in_progress', draftUrl } } } });
  assertOutcome(run, 'repaired');
  assert.equal(run.code, 0);
  assert.deepEqual(newVisits(log), []);
  assert.ok(log.gotos.includes(draftUrl));
  assert.equal(state.posts.a.draftUrl, draftUrl);
  assert.equal(state.posts.a.status, 'draft_created');
});
for (const [label, cfg, outcome, reason] of [
  ['no PUT', { saveTimeout: true }, 'draft_incomplete', 'save_unconfirmed'],
  ['wrong title', { titleMismatch: true }, 'draft_incomplete', 'title_mismatch'],
  ['confirmed', {}, 'draft_created', null],
]) await test(`AC-36 ${label}`, async () => {
  const { run, log, state } = await runArticle(cfg);
  assertOutcome(run, outcome, reason);
  assert.equal(run.code, outcome === 'draft_created' ? 0 : 5);
  assert.equal(state.posts.a.status, outcome);
  assert.equal(log.responseWaits.length, 1);
  assert.equal(log.responseWaits[0].timeout, 50);
  if (!cfg.saveTimeout) {
    assert.ok(log.events.indexOf('inject') < log.events.indexOf('save-response'));
    assert.ok(log.events.lastIndexOf('get') > log.events.indexOf('save-response'));
  }
});
const paragraph = text => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const paywall = { type: 'paywall' };
const doc = content => ({ type: 'doc', content });
for (const [label, json, opts, expected] of [
  ['invalid null', null, { paywallType: 'paywall', hasPaid: true }, [false, false]],
  ['invalid content', { content: {} }, { paywallType: 'paywall', hasPaid: true }, [false, false]],
  ['missing type', doc([paywall, paragraph('paid')]), { hasPaid: true }, [false, false]],
  ['missing wall', doc([paragraph('free')]), { paywallType: 'paywall', hasPaid: true }, [false, false]],
  ['nested wall', doc([{ type: 'blockquote', content: [paywall, paragraph('paid')] }]), { paywallType: 'paywall', hasPaid: true }, [false, false]],
  ['wall last', doc([paragraph('free'), paywall]), { paywallType: 'paywall', hasPaid: true }, [true, false]],
  ['empty after', doc([paragraph('free'), paywall, { type: 'paragraph', content: [] }]), { paywallType: 'paywall', hasPaid: true }, [true, false]],
  ['before only', doc([paragraph('paid'), paywall, { type: 'paragraph' }]), { paywallType: 'paywall', hasPaid: true }, [true, false]],
  ['body after', doc([paywall, paragraph('paid')]), { paywallType: 'paywall', hasPaid: true }, [true, true]],
  ['text after', doc([paywall, { type: 'text', text: 'paid' }]), { paywallType: 'paywall', hasPaid: true }, [true, true]],
  ['custom type', doc([{ type: 'custom_wall' }, paragraph('paid')]), { paywallType: 'custom_wall', hasPaid: true }, [true, true]],
]) await test(`AC-37 observe ${label}`, () => {
  assert.equal(typeof contract.observeEditorCompleteness, 'function');
  // 戻り値に paywallNested・paywallCount が加わった。このテストの対象は従来の2項目なので、その2項目だけを比べる（新しい項目は AC-45 が検査する）
  const observed = contract.observeEditorCompleteness(json, opts);
  assert.deepEqual({ paywallInserted: observed.paywallInserted, paidBodyInserted: observed.paidBodyInserted }, { paywallInserted: expected[0], paidBodyInserted: expected[1] });
});
await test('AC-37 classify fixtureAvailable', () => {
  for (const fixtureAvailable of [undefined, false, true]) {
    const args = { hasPaid: true, paywallInserted: false, paidBodyInserted: false, editorReachable: true, fixtureAvailable };
    assert.equal(classifyOutcome(args).reason, fixtureAvailable ? 'paywall_missing' : 'paywall_fixture_missing');
    assert.equal(classifyOutcome({ ...args, paywallInserted: true }).reason, 'paid_body_missing');
    assert.equal(classifyOutcome({ ...args, paywallInserted: true, paidBodyInserted: true }).outcome, 'draft_created');
    assert.equal(classifyOutcome({ ...args, editorReachable: false }).reason, 'editor_unreachable');
    assert.equal(classifyOutcome({ ...args, hasPaid: false }).outcome, 'draft_created');
  }
});
for (const [label, content, outcome, reason] of [
  ['no wall', [paragraph('free')], 'draft_incomplete', 'paywall_missing'],
  ['empty paid', [paragraph('free'), paywall, { type: 'paragraph', content: [] }], 'draft_incomplete', 'paid_body_missing'],
  ['complete', [paragraph('free'), paywall, paragraph('paid')], 'draft_created', null],
]) await test(`AC-37 main ${label}`, async () => {
  const { run, state, log } = await runArticle({ schema: { paywallNode: paywall, editorPath: 'element.editor' }, editorJson: doc(content) }, input => {
    singleArticle(input);
    fs.writeFileSync(path.join(input, 'a-paid-body.html'), '<p>Paid</p>');
  });
  assertOutcome(run, outcome, reason);
  assert.equal(run.code, outcome === 'draft_created' ? 0 : 5);
  assert.equal(state.posts.a.status, outcome);
  assert.equal(log.injects, 1);
});
await test('AC-38 initial rate limit', async () => {
  const { run, log, state } = await runArticle({ apiStatus: 429 });
  assertGlobal(run, 'rate_limited', 'retry_later');
  assert.equal(log.gets.length, 1);
  assert.equal(log.injects, 0);
  assert.deepEqual(log.gotos, []);
  assert.deepEqual(state.posts, {});
});
await test('AC-38 save verification rate limit stops later slugs', async () => {
  const { run, log, state } = await runArticle({ saveRateLimited: true }, input => {
    singleArticle(input);
    fs.writeFileSync(path.join(input, 'b-free-preview.html'), '<h1>Title B</h1><p>Free</p>');
  }, ['--limit=2']);
  const result = assertGlobal(run, 'rate_limited', 'retry_later');
  assert.equal(newVisits(log).length, 1);
  assert.deepEqual(log.titleFills, ['Title A']);
  assert.equal(log.injects, 1);
  assert.equal(result.results.some(r => r.slug === 'b'), false);
  assert.equal(state.posts.b, undefined);
  assert.notEqual(state.posts.a?.status, 'draft_created');
  assert.equal(state.posts.a?.draftUrl, `${origin}/publish/post/101`);
  const firstPostInjectionGet = log.events.indexOf('get', log.events.indexOf('inject'));
  assert.equal(log.events.slice(firstPostInjectionGet).filter(event => event === 'get').length, 1, '429 must not be retried');
});
await test('AC-39', () => {
  for (const file of ['cli.mjs', 'modules/substack-api.mjs', 'modules/substack-ui.mjs', 'modules/substack-contract.mjs']) {
    const source = withoutComments(fs.readFileSync(path.join(root, 'src', file), 'utf8'));
    assert.doesNotMatch(source, /\brequest\s*\.\s*(?:post|put|patch|delete|fetch)\b/, file);
  }
  const source = fs.readFileSync(path.join(root, 'src/cli.mjs'), 'utf8');
  assert.equal(source.includes('/new post/i'), false, 'must not rely on the New post landmark');
  assert.match(source, /export async function launchBrowser\b[\s\S]*?browserLaunchOptions\s*\(/);
});
// AC-40 is explicitly manual; this offline suite cannot certify the real UI.


// ---------------------------------------------------------------------------
// QA 回帰テスト（監査）: 「PUT が成功した」ことは「本文が保存された」ことを意味しない。
// プログラムによる setContent は、利用者の入力と違って update イベントを出さず、自動保存が本文を含まない可能性がある。
// そこで、保存後に下書きを開き直して、サーバーに保存された本文を読んで判定する。
// ---------------------------------------------------------------------------
const PAYWALL_SCHEMA = { editorPath: 'element.editor', paywallNode: { type: 'paywall' } };
const docWith = (...nodes) => ({ type: 'doc', content: nodes });
const para = (text) => (text ? { type: 'paragraph', content: [{ type: 'text', text }] } : { type: 'paragraph' });
const paidSetup = (input) => {
  fs.writeFileSync(path.join(input, 'a-free-preview.html'), '<h1>Title A</h1><p>free</p>');
  fs.writeFileSync(path.join(input, 'a-paid-body.html'), '<p>paid</p>');
};

await test('QA-9 PUT と題名が確認できても、保存された本文が空なら成功としない(body_not_saved)', async () => {
  const { run, state, log } = await runWithFakeBrowser((input) => {
    fs.writeFileSync(path.join(input, 'a-free-preview.html'), '<h1>Title A</h1><p>free</p>');
  }, ['--limit=1'], undefined, { persistedJson: docWith(para('')) });
  const result = jsonOutput(run.out);
  const a = result.results.find((r) => r.slug === 'a');
  assert.equal(a?.outcome, 'draft_incomplete', `empty persisted body must not be reported as created: ${JSON.stringify(a)}`);
  assert.equal(a?.reason, 'body_not_saved');
  assert.equal(run.code, 5);
  assert.equal(state.posts.a.status, 'draft_incomplete');
  assert.ok(state.posts.a.draftUrl, 'draftUrl must be kept so a rerun can repair the same draft');
  assert.ok((log.snapshots ?? 0) >= 1, 'the persisted draft must be read back');
});

await test('QA-10 完全性は「保存された本文」から判定する（注入直後の内容に Paywall があっても、保存後に無ければ不完全）', async () => {
  const { run } = await runWithFakeBrowser(paidSetup, ['--limit=1'], undefined, {
    schema: PAYWALL_SCHEMA,
    editorJson: docWith(para('free'), { type: 'paywall' }, para('paid')),
    persistedJson: docWith(para('free')),
  });
  const result = jsonOutput(run.out);
  const a = result.results.find((r) => r.slug === 'a');
  assert.equal(a?.outcome, 'draft_incomplete');
  assert.equal(a?.reason, 'paywall_missing');
});

await test('QA-11 保存された本文に Paywall と後続の内容があれば draft_created', async () => {
  const { run, state } = await runWithFakeBrowser(paidSetup, ['--limit=1'], undefined, {
    schema: PAYWALL_SCHEMA,
    editorJson: docWith(para('free'), { type: 'paywall' }, para('paid')),
    persistedJson: docWith(para('free'), { type: 'paywall' }, para('paid')),
  });
  const result = jsonOutput(run.out);
  assert.equal(result.results.find((r) => r.slug === 'a')?.outcome, 'draft_created');
  assert.equal(run.code, 0);
  assert.equal(state.posts.a.status, 'draft_created');
});

await test('QA-12 保存された本文を読み取れないときは save_unconfirmed（成功としない）', async () => {
  const { run } = await runWithFakeBrowser((input) => {
    fs.writeFileSync(path.join(input, 'a-free-preview.html'), '<h1>Title A</h1><p>free</p>');
  }, ['--limit=1'], undefined, { persistedUnreachable: true });
  const a = jsonOutput(run.out).results.find((r) => r.slug === 'a');
  assert.equal(a?.outcome, 'draft_incomplete');
  assert.equal(a?.reason, 'save_unconfirmed');
});

await test('QA-13 editorAction は setContent で update イベントを発行させる（自動保存を起こすため）', async () => {
  const calls = [];
  const editor = {
    commands: { setContent: (...args) => { calls.push(args); return true; }, focus: () => true, insertContent: () => true },
    getJSON: () => ({ type: 'doc', content: [] }),
  };
  globalThis.document = { querySelector: () => ({ editor }) };
  globalThis.window = {};
  try {
    const { editorAction } = await import('../src/cli.mjs');
    editorAction({ action: 'inject', plan: { freeHtml: '<p>x</p>', paywall: false }, paywallNode: undefined, editorPath: undefined });
  } finally {
    delete globalThis.document;
    delete globalThis.window;
  }
  assert.equal(calls.length, 1, 'setContent must be called once');
  const option = calls[0][1];
  assert.ok(option === true || option?.emitUpdate === true,
    `setContent must be asked to emit update (Tiptap v2: 2nd arg true / v3: { emitUpdate: true }), got ${JSON.stringify(option)}`);
});



// Selection-sensitive model; positions are opaque top-level offsets.
function makeFakeEditor({ freeNodes = [para('free')], swallowPaywall = false, paywallBeforeLast = false, trailingEmpty = false } = {}) {
  let nodes = [], selection;
  const fake = { legacyCalls: 0, setOptions: [] };
  const valueNode = value => typeof value === 'string' ? para('paid') : structuredClone(value);
  const editor = {
    getJSON: () => docWith(...structuredClone(nodes)),
    state: { doc: { content: { get size() { return nodes.length; } } } },
    commands: {
      setContent(_html, option) {
        fake.setOptions.push(option);
        nodes = structuredClone(freeNodes);
        selection = undefined;
        return true;
      },
      insertContentAt(pos, value) {
        if (pos !== nodes.length) return false;
        if (paywallBeforeLast && value?.type === 'paywall' && nodes.length) nodes.splice(nodes.length - 1, 0, valueNode(value));
        else if (!(swallowPaywall && value?.type === 'paywall')) nodes.push(valueNode(value));
        // TrailingNode 拡張の模擬: 挿入のたびに末尾が空段落でなければ空段落を足す
        if (trailingEmpty && nodes.at(-1)?.type !== 'paragraph') nodes.push({ type: 'paragraph' });
        return true;
      },
      focus(where) {
        assert.equal(where, 'end');
        fake.legacyCalls++;
        const last = nodes.at(-1);
        selection = ['orderedList', 'bulletList'].includes(last?.type) ? 'list'
          : last && !last.content ? 'node' : 'cursor';
        return true;
      },
      insertContent(value) {
        fake.legacyCalls++;
        if (swallowPaywall && value?.type === 'paywall') return true;
        if (selection === 'node') nodes.splice(nodes.length - 1, 1, valueNode(value));
        else if (selection === 'list') nodes.at(-1).content.at(-1).content.push(valueNode(value));
        else nodes.push(valueNode(value));
        return true;
      },
    },
  };
  fake.editor = editor;
  return fake;
}
async function withEditor(editor, run) {
  globalThis.document = { querySelector: () => ({ editor }) };
  globalThis.window = {};
  try {
    const { editorAction } = await import('../src/cli.mjs');
    assert.equal(typeof editorAction, 'function');
    return await run(editorAction);
  } finally {
    delete globalThis.document;
    delete globalThis.window;
  }
}
const orderedFree = [{ type: 'orderedList', content: [{ type: 'listItem', content: [para('free')] }] }];
const injectPaid = { action: 'inject', plan: { freeHtml: '<p>free</p>', paidHtml: '<p>paid</p>', paywall: true }, ...PAYWALL_SCHEMA };
for (const [label, freeNodes] of [['paragraph', [para('free')]], ['orderedList', orderedFree]]) {
  await test(`AC-43 legacy model ${label}`, () => {
    const fake = makeFakeEditor({ freeNodes });
    const legacyInject = editor => {
      editor.commands.setContent('<p>free</p>', true);
      editor.commands.focus('end');
      editor.commands.insertContent({ type: 'paywall' });
      editor.commands.focus('end');
      editor.commands.insertContent('<p>paid</p>');
    };
    legacyInject(fake.editor);
    const nodes = fake.editor.getJSON().content;
    assert.equal(fake.legacyCalls, 4);
    assert.equal(nodes.filter(n => n.type === 'paywall').length, 0);
    if (label === 'paragraph') assert.deepEqual(nodes, [para('free'), para('paid')]);
    else {
      assert.equal(nodes.length, 1);
      assert.deepEqual(nodes[0].content[0].content, [para('free'), { type: 'paywall' }, para('paid')]);
    }
  });
  await test(`AC-43 absolute insertion ${label}`, async () => {
    const fake = makeFakeEditor({ freeNodes });
    const result = await withEditor(fake.editor, action => action(injectPaid));
    assert.deepEqual(fake.editor.getJSON(), docWith(...freeNodes, { type: 'paywall' }, para('paid')));
    assert.deepEqual(result.json, fake.editor.getJSON());
    assert.equal(result.reachable, true);
    assert.equal(fake.legacyCalls, 0);
    assert.ok(fake.setOptions[0] === true || fake.setOptions[0]?.emitUpdate === true);
    assert.deepEqual(result.insertion, { paywallConfirmed: true, paidInserted: true });
  });
}
await test('AC-44 swallowed Paywall stops paid insertion', async () => {
  const fake = makeFakeEditor({ swallowPaywall: true });
  const result = await withEditor(fake.editor, action => action(injectPaid));
  assert.deepEqual(fake.editor.getJSON(), docWith(para('free')));
  assert.deepEqual(result.json, fake.editor.getJSON());
  assert.deepEqual(result.insertion, { paywallConfirmed: false, paidInserted: false });
});
for (const [label, overrides] of [['disabled', { plan: { ...injectPaid.plan, paywall: false } }], ['no fixture', { paywallNode: undefined }]]) {
  await test(`AC-44 no Paywall ${label}`, async () => {
    const fake = makeFakeEditor();
    delete fake.editor.state; // No absolute-position access is allowed on this path.
    const result = await withEditor(fake.editor, action => action({ ...injectPaid, ...overrides }));
    assert.deepEqual(fake.editor.getJSON(), docWith(para('free')));
    assert.deepEqual(result.insertion, { paywallConfirmed: null, paidInserted: false });
    assert.equal(fake.legacyCalls, 0);
  });
}
for (const [label, json, options, expected] of [
  ['complete', docWith(para('free'), paywall, para('paid')), { paywallType: 'paywall' }, [true, true, false, 1]],
  ['duplicated', docWith(paywall, para('paid'), paywall), { paywallType: 'paywall' }, [false, false, false, 2]],
  ['empty paid', docWith(paywall, para('')), { paywallType: 'paywall' }, [true, false, false, 1]],
  ['nested', docWith({ type: 'blockquote', content: [{ type: 'blockquote', content: [paywall] }] }), { paywallType: 'paywall' }, [false, false, true, 0]],
  // Paywall の後ろが、Paywall だけを入れ子に持つ引用ブロックのとき、本文の文字は無いので paidBodyInserted は false（入れ子の Paywall は数えない）
  ['top and nested', docWith(paywall, { type: 'blockquote', content: [paywall] }), { paywallType: 'paywall' }, [true, false, false, 1]],
  ['missing type', docWith(paywall, para('paid')), {}, [false, false, false, 0]],
  ['invalid', null, { paywallType: 'paywall' }, [false, false, false, 0]],
]) await test(`AC-45 observe ${label}`, () => {
  assert.equal(typeof contract.observeEditorCompleteness, 'function');
  assert.deepEqual(contract.observeEditorCompleteness(json, { hasPaid: true, ...options }), {
    paywallInserted: expected[0], paidBodyInserted: expected[1], paywallNested: expected[2], paywallCount: expected[3],
  });
});
for (const [label, fields, reason] of [
  ['duplicated', { paywallCount: 2, paywallNested: true }, 'paywall_duplicated'],
  ['nested', { paywallNested: true, paywallCount: 0 }, 'paywall_nested'],
  ['missing', {}, 'paywall_missing'],
  ['fixture missing', { fixtureAvailable: false }, 'paywall_fixture_missing'],
  ['paid missing', { paywallInserted: true }, 'paid_body_missing'],
  ['complete', { paywallInserted: true, paidBodyInserted: true }, null],
]) await test(`AC-45 classify ${label}`, () => {
  const result = classifyOutcome({ hasPaid: true, editorReachable: true, fixtureAvailable: true, paywallInserted: false, paidBodyInserted: false, ...fields });
  assert.equal(result.outcome, reason ? 'draft_incomplete' : 'draft_created');
  if (reason) assert.equal(result.reason, reason);
});
for (const [label, cfg, reason] of [
  ['missing persisted wall', { persistedJson: docWith(para('free')) }, 'paywall_not_inserted'],
  ['complete persisted body', {}, 'paywall_not_inserted'],
  ['save priority', { saveTimeout: true }, 'save_unconfirmed'],
  ['title priority', { titleMismatch: true }, 'title_mismatch'],
  ['body priority', { persistedJson: docWith(para('')) }, 'body_not_saved'],
  ['legacy insertion absent', { injectInsertion: undefined }, null],
]) await test(`AC-46 ${label}`, async () => {
  const { run, state } = await runWithFakeBrowser(paidSetup, ['--limit=1'], undefined, {
    schema: PAYWALL_SCHEMA,
    editorJson: docWith(para('free'), paywall, para('paid')),
    persistedJson: docWith(para('free'), paywall, para('paid')),
    injectInsertion: { paywallConfirmed: false, paidInserted: false }, ...cfg,
  });
  assertOutcome(run, reason ? 'draft_incomplete' : 'draft_created', reason);
  assert.equal(run.code, reason ? 5 : 0);
  assert.equal(state.posts.a.status, reason ? 'draft_incomplete' : 'draft_created');
  assert.equal(state.posts.a.draftUrl, `${origin}/publish/post/101`);
});
await test('AC-47 read-only draft diagnostic', () => {
  // AC-30 enumerates every .mjs in this directory, including this diagnostic.
  const file = path.join(root, 'src/diagnostics/substack-inspect-draft.mjs');
  assert.ok(fs.existsSync(file), 'substack-inspect-draft.mjs must exist');
  const checked = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', timeout: 4000 });
  assert.equal(checked.error, undefined);
  assert.equal(checked.status, 0, checked.stderr);
  const source = fs.readFileSync(file, 'utf8');
  assert.match(source, /paywall/i);
  assert.doesNotMatch(source, /TRY_INSERT|insertContent\s*\(|setContent\s*\(/);
});


// QA 回帰テスト（変異検査で見つかった穴）: 「Paywall が最上位に1つ」だけでなく「最上位の末尾にある」ことも確認する。
// 末尾でない位置に入った Paywall は、その後ろに無料部分のノードが残り、有料本編との境界が正しくない。
await test('QA-15 Paywall が最上位の末尾にない場合は確認できないものとして、有料本編を入れない', async () => {
  const fake = makeFakeEditor({ freeNodes: [para('free one'), para('free two')], paywallBeforeLast: true });
  globalThis.document = { querySelector: () => ({ editor: fake.editor }) };
  globalThis.window = {};
  let result;
  try {
    const { editorAction } = await import('../src/cli.mjs');
    result = editorAction({ action: 'inject', plan: { freeHtml: '<p>free</p>', paywall: true, paidHtml: '<p>paid</p>' }, paywallNode: { type: 'paywall' }, editorPath: undefined });
  } finally {
    delete globalThis.document;
    delete globalThis.window;
  }
  const types = fake.editor.getJSON().content.map((node) => node.type);
  assert.equal(types.filter((type) => type === 'paywall').length, 1, 'the paywall exists once at the top level');
  assert.notEqual(types.at(-1), 'paywall', 'precondition: the fake placed the paywall before the last node');
  assert.equal(result.insertion.paywallConfirmed, false, 'a paywall that is not at the end of the document must not be confirmed');
  assert.equal(result.insertion.paidInserted, false);
  assert.equal(fake.editor.getJSON().content.some((node) => JSON.stringify(node).includes('paid')), false, 'paid content must not be inserted');
});

// QA 指摘(High): TrailingNode 拡張が Paywall 直後に空段落を足しても、Paywall を確認済みとして有料本編を入れる。
await test('QA-16 Paywall の後ろに空段落だけが自動追加されても Paywall を確認でき、有料本編が Paywall の後に入る', async () => {
  const fake = makeFakeEditor({ freeNodes: [para('free one'), para('free two')], trailingEmpty: true });
  globalThis.document = { querySelector: () => ({ editor: fake.editor }) };
  globalThis.window = {};
  let result;
  try {
    const { editorAction } = await import('../src/cli.mjs');
    result = editorAction({ action: 'inject', plan: { freeHtml: '<p>free</p>', paywall: true, paidHtml: '<p>paid</p>' }, paywallNode: { type: 'paywall' }, editorPath: undefined });
  } finally {
    delete globalThis.document;
    delete globalThis.window;
  }
  const types = fake.editor.getJSON().content.map((node) => node.type);
  assert.equal(result.insertion.paywallConfirmed, true);
  assert.equal(result.insertion.paidInserted, true);
  assert.ok(types.indexOf('paywall') >= 0 && types.indexOf('paywall') < types.length - 1, 'paid content follows the paywall');
});

// Regressions from the pre-release audit.
await test('AUDIT-1 --force on a slug already held locally reports skipped_remote without failing or touching the state', async () => {
  const draftUrl = ['https://example.substack.com', 'publish', 'post', '7'].join('/');
  const { run, log, state } = await runWithFakeBrowser((input) => {
    fs.writeFileSync(path.join(input, 'a-free-preview.html'), '<h1>Title A</h1><p>x</p>');
  }, ['--force', '--slug=a'], undefined, {
    initialState: { posts: { a: { status: 'draft_created', draftUrl } } },
    remote: { drafts: [{ id: 7, title: null, draft_title: 'Title A', slug: null, is_published: false }] },
  });
  const result = jsonOutput(run.out);
  assert.equal(run.code, 0, JSON.stringify(result));
  assert.equal(result.results[0].outcome, 'skipped_remote');
  assert.equal(state.posts.a.status, 'draft_created');
  assert.equal(log.injects, 0);
});
await test('AUDIT-2 a failed interactive login does not tell the caller to log in again', async () => {
  assert.equal(buildResult({ mode: 'login', exitCode: 2 }).nextAction, 'ask_user');
  assert.equal(buildResult({ mode: 'post', exitCode: 2 }).nextAction, 'run_login');
});
await test('AUDIT-3 the state file is written readable only by its owner', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'substack-state-mode-'));
  try {
    const file = path.join(dir, 'sub', 'state.json');
    saveState(file, { posts: { a: { status: 'draft_created' } } });
    assert.equal(fs.statSync(file).mode & 0o077, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
await test('AUDIT-4 a paid-body file with no content is blocked instead of silently producing a free-only draft', async () => {
  const { run, log } = await runWithFakeBrowser((input) => {
    fs.writeFileSync(path.join(input, 'a-free-preview.html'), '<h1>Title A</h1><p>x</p>');
    fs.writeFileSync(path.join(input, 'a-paid-body.html'), '  \n ');
  }, ['--slug=a']);
  const result = jsonOutput(run.out);
  assert.equal(result.results[0].outcome, 'failed');
  assert.equal(result.results[0].reason, 'empty_paid_body');
  assert.equal(log.injects, 0);
});

process.exitCode = failures ? 1 : 0;
