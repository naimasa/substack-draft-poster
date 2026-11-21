#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { buildInjectionPlan } from './modules/substack-tiptap.mjs';
import { loadState, saveState, hashSource, normalizeTitle, nextStatus, shouldSkip, recordDraftCreated, recordSkipped, recordDraftIncomplete } from './modules/substack-post-state.mjs';

export const schemaFile = (options = {}) => resolvePaths(options).schemaFile;
import { resolveProfileDir, resolvePaths, parseArgs, observeEditorCompleteness, resolvePublication, resolveMeta, isCiEnvironment, buildResult, classifyOutcome, planTarget, acquireLock, withDeadline, ensurePrivateDir, browserLaunchOptions, docHasContent} from './modules/substack-contract.mjs';
import { checkLoginByApi, fetchAllPosts, findRemoteMatch, findDraftById, RemoteListError } from './modules/substack-api.mjs';
import { NEW_POST_PATH, DRAFT_PATH_RE, DASHBOARD_DRAFTS_PATH, SAVE_REQUEST } from './modules/substack-ui.mjs';
const help = `Configuration:
| Environment | Flag | Default |
| SUBSTACK_PUBLICATION_URL | --publication | required for post/login |
| SUBSTACK_PROFILE_DIR | — | ~/.substack-draft-poster/profile |
| SUBSTACK_STATE_FILE | — | ./.substack-poster/state.json |
| SUBSTACK_SCHEMA_FILE | — | ./.substack-poster/tiptap-schema.json |
| SUBSTACK_IN_DIR | --in-dir | ./substack-input |
| — | --slug | all eligible inputs, up to --limit |
| — | --limit | 1 |
| — | --dry-run --force --open --mark-published --status --json --login --help | false |
| — | --timeout | 900 seconds |

Substack draft poster (local Mac only; a human publishes)
  --status                   offline inventory of inputs and state
  --json                     print one machine-readable JSON result
  --publication=<url>        target publication (https, no path)
  --timeout=<sec>            processing limit (default 900, max 3600 seconds)
  --help                     show this help (does not start a browser)
  --login                    a human signs in in the browser, then presses Enter
  --in-dir=<path>            HTML input directory (default ./substack-input; SUBSTACK_IN_DIR also works)
  --slug=<slug>              process only this article
  --limit=<n>                maximum number of articles to process (default 1)
  --dry-run                  print the injection plan offline; changes no draft or state
  --force                    lift the local-state skip (the remote duplicate check stays on)
  --open                     keep the draft open until a human closes the browser
  --mark-published=<slug>    record an article a human has published in the state (no posting)`;

export async function prompt(message, output = process.stderr, signal) {
  const rl = createInterface({ input: process.stdin, output });
  try { return await rl.question(message, { signal }); } finally { rl.close(); }
}
export async function launchBrowser({ profileDir = undefined } = {}) {
  if (!profileDir) {
    const profile = resolveProfileDir();
    profileDir = profile.dir;
  }
  const { chromium } = await import('playwright');
  return chromium.launchPersistentContext(profileDir, browserLaunchOptions());
}

// Serialized into the page by Playwright; keep this function self-contained.
export function editorAction({ action, plan, paywallNode, editorPath }) {
  const el = document.querySelector('.ProseMirror');
  const resolve = (key) => {
    if (key === 'element.editor') return el?.editor;
    if (key === 'element.__tiptapEditor') return el?.__tiptapEditor;
    if (key === 'window.editor') return window.editor;
    if (key === 'window.tiptapEditor') return window.tiptapEditor;
    return null;
  };
  const keys = [editorPath, 'element.editor', 'element.__tiptapEditor', 'window.editor', 'window.tiptapEditor'].filter(Boolean);
  const key = keys.find((k) => typeof resolve(k)?.commands?.setContent === 'function' && typeof resolve(k)?.getJSON === 'function');
  const editor = resolve(key);
  if (!editor) return { reachable: false };
  if (action === 'snapshot') return { reachable: true, editorPath: key, json: editor.getJSON() };
  // Tiptap v2 setContent(content, emitUpdate = false) does not emit an update by default (v3 takes { emitUpdate }).
  // Without an update event, Substack's autosave may not include the body. In v2 a truthy second argument emits it; in v3 { emitUpdate: true } does.
  if (editor.commands.setContent(plan.freeHtml, { emitUpdate: true }) === false) throw new Error('setContent rejected HTML');
  const insertion = { paywallConfirmed: null, paidInserted: false };
  if (paywallNode && plan.paywall) {
    // The old approach depended on the selection and could replace the Paywall or insert it inside a list.
    // Append at the absolute end of the document and confirm the top-level boundary before inserting the paid body.
    if (editor.commands.insertContentAt(editor.state.doc.content.size, paywallNode) === false) throw new Error('Paywall insertion rejected');
    const json = editor.getJSON();
    const content = json?.content;
    // TrailingNode-style extensions may add an empty paragraph right after the Paywall. Only empty paragraphs may remain after it.
    const isEmptyParagraph = node => node?.type === 'paragraph' && !(node.content || []).length;
    let end = Array.isArray(content) ? content.length : 0;
    while (end > 0 && isEmptyParagraph(content[end - 1])) end -= 1;
    insertion.paywallConfirmed = Array.isArray(content)
      && content.filter(node => node?.type === paywallNode.type).length === 1
      && end > 0 && content[end - 1]?.type === paywallNode.type;
    if (!insertion.paywallConfirmed) return { reachable: true, json, insertion };
    if (editor.commands.insertContentAt(editor.state.doc.content.size, plan.paidHtml) === false) throw new Error('Paid content insertion rejected');
    insertion.paidInserted = true;
  }
  return { reachable: true, json: editor.getJSON(), insertion };
}

const onSignIn = page => /\/sign-in|\/login/.test(new URL(page.url()).pathname);

async function checkLogin(request, page, origin) {
  if (await checkLoginByApi(request, origin) === 'logged_in') return true;
  await page.goto(`${origin}${DASHBOARD_DRAFTS_PATH}`);
  if (onSignIn(page)) return false;
  throw Object.assign(new Error('Cannot determine the login state from the list API. Do not log in again; report this to a human.'), { code: 'login_state_unknown' });
}

function validateDraftUrl(value, origin) {
  const url = new URL(value);
  const match = url.pathname.match(DRAFT_PATH_RE);
  if (url.origin !== origin || !match || match[0] !== url.pathname || url.search || url.hash) throw new Error('Invalid draft URL');
  return url;
}

// Reopen the saved draft in a separate page, wait for the body to load and return the editor content. Returns null if it cannot be read.
// The page being edited is left alone (to avoid reload and leave-page confirmation dialogs).
async function readPersistedDoc(context, draftUrl, schema, readMs) {
  const page = await context.newPage();
  try {
    await page.goto(draftUrl, { waitUntil: 'domcontentloaded' });
    await page.locator('.ProseMirror').waitFor({ timeout: 20000 });
    const deadline = Date.now() + readMs;
    let json = null;
    for (;;) {
      const snapshot = await page.evaluate(editorAction, { action: 'snapshot', editorPath: schema?.editorPath });
      if (!snapshot?.reachable) return null;
      json = snapshot.json;
      // The editor frame appears before the body loads. Wait until content appears or time runs out.
      if (docHasContent(json) || Date.now() + 500 > deadline) return json;
      await delay(500);
    }
  } catch (error) {
    if (error.exitCode !== undefined || error.code === 'rate_limited') throw error;
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

async function inject(page, plan, schema, err) {
  const result = await page.evaluate(editorAction, { action: 'inject', plan, paywallNode: schema?.paywallNode, editorPath: schema?.editorPath });
  if (!result.reachable) {
    err('Warning: setContent is unreachable, so only the free preview was inserted through a synthetic DataTransfer. Check the Paywall and the paid body manually.');
    await page.locator('.ProseMirror').evaluate((el, html) => {
      el.focus();
      const transfer = new DataTransfer();
      transfer.setData('text/html', html);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }));
    }, plan.freeHtml);
    await page.waitForFunction(() => document.querySelector('.ProseMirror')?.textContent.trim().length > 0, null, { timeout: 10000 });
    return classifyOutcome({ hasPaid: plan.paywall, editorReachable: false });
  }
  if (result.insertion?.paywallConfirmed === false) return { outcome: 'draft_incomplete', completeness: { freePreview: true, paywall: false, paidBody: false }, reason: 'paywall_not_inserted' };
  const observed = observeEditorCompleteness(result.json, { paywallType: schema?.paywallNode?.type, hasPaid: plan.paywall });
  return classifyOutcome({ hasPaid: plan.paywall, editorReachable: true, ...observed, fixtureAvailable: Boolean(schema?.paywallNode) });
}

export async function main(args = process.argv.slice(2), deps = {}) {
  const env = deps.env ?? process.env;
  const out = deps.out ?? (text => process.stdout.write(text));
  const err = deps.err ?? (text => process.stderr.write(`${text}\n`));
  const now = deps.now ?? Date.now;
  const timeouts = { newPostUrl: 20000, save: 60000, settle: 3000, persistedRead: 10000, ...deps.timeouts };
  const stamp = () => new Date(now()).toISOString();
  const abort = new AbortController();
  let opts, mode = 'usage', context, lock, expired = false;
  let remoteCheck = 'skipped';
  const results = [];
  const finish = (extra = {}) => {
    const result = buildResult({ mode, results, remoteCheck, ...extra });
    out((opts?.json || args.includes('--json')) ? `${JSON.stringify(result)}\n` : mode === 'help' ? `${help}\n` : `Substack ${mode}: exit ${result.exitCode} / ${result.nextAction}\n${results.map(r => `${r.slug}: ${r.outcome ?? (r.eligible ? 'eligible' : r.blockedBy.join(',') || 'skipped')} ${r.draftUrl ?? ''}`).join('\n')}\n`);
    return result.exitCode;
  };
  try {
    opts = parseArgs(args);
    mode = opts.help ? 'help' : opts.status ? 'status' : opts['dry-run'] ? 'dry-run' : opts.login ? 'login' : opts['mark-published'] ? 'mark-published' : 'post';
    if (mode === 'help') return finish();
    if (mode !== 'status' && isCiEnvironment(env)) {
      err('This tool runs only on a local Mac. It cannot run in CI.');
      return finish({ exitCode: 3 });
    }
    if ((opts.login || opts.open) && !(deps.isTTY ?? process.stdin.isTTY)) {
      return finish({ exitCode: 64, nextAction: opts.login ? 'ask_user' : 'fix_input', errors: [{ code: 'usage', message: 'Run this from a human TTY' }] });
    }
    const cwd = deps.cwd ?? process.cwd();
    const paths = resolvePaths({ env, cwd });
    const statePath = deps.stateFile ?? paths.stateFile;
    const schemaPath = deps.schemaFile ?? paths.schemaFile;
    const profile = resolveProfileDir({ env, home: deps.home ?? os.homedir() });
    const profileDir = profile.dir;
    const origin = ['post', 'login'].includes(mode) ? resolvePublication({ flag: opts.publication, env }) : undefined;
    const locked = ['login', 'post', 'mark-published'].includes(mode);
    if (locked) {
      lock = acquireLock(deps.lockPath ?? path.join(path.dirname(profileDir), 'substack.lock'), { now });
      if (lock.stale) err('Warning: reclaimed a lock left by a finished process');
    }
    let state = loadState(statePath);
    if (mode === 'mark-published') {
      const slug = opts['mark-published'];
      const post = state.posts[slug];
      state = { ...state, posts: { ...state.posts, [slug]: { ...post, status: nextStatus(post?.status, 'mark_published'), updatedAt: stamp() } } };
      saveState(statePath, state);
      return finish();
    }
    const run = async () => {
      const check = () => { if (expired) throw new Error('Processing deadline exceeded'); };
      const openBrowser = async () => {
        if (ensurePrivateDir(profileDir).loose) err(`Warning: profile ${profileDir} is readable by other users (it contains cookies). chmod 700 is recommended.`);
        context = await (deps.launchBrowser ?? launchBrowser)({ profileDir });
        if (expired) { await context.close(); check(); }
        return context.newPage();
      };
      if (mode === 'login') {
        const page = await openBrowser();
        await page.goto(`${origin}/sign-in`);
        check();
        await prompt('Sign in in the browser. Press Enter when done: ', { write: text => err(text) }, abort.signal);
        check();
        return await checkLogin(deps.request ?? context.request, page, origin) ? 0 : 2;
      }
      const inDir = path.resolve(cwd, opts['in-dir'] ?? paths.inDir);
      const readJson = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
      const schema = readJson(schemaPath);
      if (schema && (!schema.paywallNode?.type || !schema.editorPath)) throw new Error('The probe fixture is invalid. Capture it again.');
      const slugs = fs.existsSync(inDir) ? fs.readdirSync(inDir).filter(f => f.endsWith('-free-preview.html')).map(f => f.slice(0, -18)).sort() : [];
      if (opts.slug && !slugs.includes(opts.slug)) slugs.push(opts.slug);
      const inputs = [];
      for (const slug of slugs.filter(s => !opts.slug || s === opts.slug)) {
        try {
          const freePath = path.join(inDir, `${slug}-free-preview.html`);
          const paidPath = path.join(inDir, `${slug}-paid-body.html`);
          const hasFree = fs.existsSync(freePath), hasPaid = fs.existsSync(paidPath);
          const free = hasFree ? fs.readFileSync(freePath, 'utf8') : '';
          const paid = hasPaid ? fs.readFileSync(paidPath, 'utf8') : null;
          const meta = resolveMeta({ metaJson: readJson(path.join(inDir, `${slug}.meta.json`)), freeHtml: free });
          const blockedBy = [...(!hasFree ? ['missing_input'] : []), ...(meta.error ? [meta.error] : []), ...(hasPaid && !paid.trim() ? ['empty_paid_body'] : []), ...(hasPaid && !schema ? ['paywall_fixture_missing'] : [])];
          const sources = { titleSource: meta.titleSource ?? 'none', subtitleSource: meta.subtitleSource ?? 'none' };
          if (mode === 'status') {
            results.push({ slug, hasFree, hasPaid, meta: sources, stateStatus: state.posts[slug]?.status ?? null, draftUrl: state.posts[slug]?.draftUrl ?? null, eligible: !blockedBy.length && !shouldSkip(state, slug, opts), blockedBy });
          } else inputs.push({ slug, free, paid, meta, sources, blockedBy });
        } catch (e) { results.push({ slug, outcome: 'failed', reason: 'invalid_input', message: e.message }); }
      }
      if (mode === 'status') return;
      for (const i of inputs.filter(i => shouldSkip(state, i.slug, opts))) results.push({ slug: i.slug, outcome: 'skipped_state', reason: 'state_skip' });
      const targets = inputs.filter(i => !shouldSkip(state, i.slug, opts)).slice(0, opts.limit);
      if (mode === 'dry-run') {
        for (const i of targets) results.push({ slug: i.slug, outcome: i.blockedBy.some(b => b !== 'paywall_fixture_missing') ? 'failed' : 'planned', reason: i.blockedBy[0] ?? null, meta: i.sources, plan: buildInjectionPlan({ freePreviewHtml: i.free, paidBodyHtml: i.paid, titleEn: i.meta.title, excerptEn: i.meta.subtitle }) });
        return;
      }
      const page = await openBrowser();
      if (!await checkLogin(deps.request ?? context.request, page, origin)) return 2;
      const request = deps.request ?? context.request;
      const remote = [];
      try {
        for (const kind of ['drafts', 'published']) {
          const list = await fetchAllPosts(request, origin, kind);
          remote.push(...list.posts.map(post => ({ title: post.title, url: `${origin}/publish/${kind === 'drafts' ? 'post' : 'posts/detail'}/${post.id}` })));
        }
      } catch (error) {
        if (error instanceof RemoteListError && error.code !== 'rate_limited') {
          throw Object.assign(new Error(`The list API response is incomplete: ${error.code}`), { code: 'remote_list_incomplete' });
        }
        throw error;
      }
      remoteCheck = 'done';
      let count = 0;
      for (const i of targets) {
        try {
          check();
          const { slug, free, paid, meta, sources, blockedBy } = i;
          if (blockedBy.some(b => b !== 'paywall_fixture_missing')) { results.push({ slug, outcome: 'failed', reason: blockedBy[0], meta: sources }); continue; }
          const details = { titleEn: meta.title, sourceHash: hashSource(free, paid) };
          const remoteMatch = findRemoteMatch(remote, meta.title);
          const target = planTarget({ entry: state.posts[slug], force: opts.force, remoteMatch });
          if (target.action === 'skip') {
            if (target.reason === 'remote_duplicate') {
              // A draft recovered after interruption has unverified contents.
              if (state.posts[slug]?.status === 'in_progress' && /\/publish\/post\//.test(remoteMatch.url)) {
                state = recordDraftIncomplete(state, slug, { ...details, draftUrl: remoteMatch.url, reason: 'interrupted', completeness: { freePreview: false, paywall: false, paidBody: false } });
                results.push({ slug, outcome: 'draft_incomplete', reason: 'interrupted', draftUrl: remoteMatch.url });
              } else if (['draft_created', 'published'].includes(state.posts[slug]?.status)) {
                // --force on a slug the local state already holds: report the remote duplicate without touching the state
                results.push({ slug, outcome: 'skipped_remote', reason: target.reason, draftUrl: remoteMatch.url });
              } else {
                state = recordSkipped(state, slug, { ...details, draftUrl: remoteMatch.url });
                results.push({ slug, outcome: 'skipped_remote', reason: target.reason, draftUrl: remoteMatch.url });
              }
              check(); saveState(statePath, state);
            } else results.push({ slug, outcome: 'skipped_state', reason: target.reason });
            continue;
          }
          if (target.action === 'repair' && blockedBy.includes('paywall_fixture_missing')) {
            results.push({ slug, outcome: 'draft_incomplete', reason: 'paywall_fixture_missing', draftUrl: target.reuseDraftUrl, meta: sources });
            continue;
          }
          if (count++) await delay(3000);
          check();
          const plan = buildInjectionPlan({ freePreviewHtml: free, paidBodyHtml: paid, titleEn: meta.title, excerptEn: meta.subtitle });
          if (target.action === 'create') {
            state = { ...state, posts: { ...state.posts, [slug]: { ...details, status: 'in_progress', updatedAt: stamp() } } };
            saveState(statePath, state);
          }
          let draftUrl;
          if (target.action === 'create') {
            await page.goto(`${origin}${NEW_POST_PATH}`);
            try {
              await page.waitForURL(DRAFT_PATH_RE, { timeout: timeouts.newPostUrl });
              draftUrl = page.url();
              validateDraftUrl(draftUrl, origin);
            } catch (error) {
              if (expired || error.exitCode !== undefined || error.code === 'rate_limited') throw error;
              throw Object.assign(new Error(`Cannot confirm the draft URL: ${error.message}`), { code: 'new_post_unconfirmed' });
            }
            check();
            state = { ...state, posts: { ...state.posts, [slug]: { ...state.posts[slug], draftUrl } } };
            saveState(statePath, state);
            await delay(timeouts.settle);
          } else {
            draftUrl = target.reuseDraftUrl;
            validateDraftUrl(draftUrl, origin);
            state = { ...state, posts: { ...state.posts, [slug]: { ...state.posts[slug], ...details, status: 'in_progress', updatedAt: stamp() } } };
            saveState(statePath, state);
            await page.goto(draftUrl);
          }
          await page.locator('.ProseMirror').waitFor({ timeout: 20000 });
          check();
          await page.getByPlaceholder(/^title$/i).fill(plan.title);
          if (plan.subtitle) await page.getByPlaceholder(/^(subtitle|add a subtitle)/i).fill(plan.subtitle);
          const id = Number(validateDraftUrl(draftUrl, origin).pathname.split('/').at(-1));
          // Register before injection; attach a rejection handler immediately.
          const saveResponse = page.waitForResponse(response => {
            const url = new URL(response.url());
            return response.request().method() === SAVE_REQUEST.method
              && url.origin === origin && SAVE_REQUEST.pathRe.test(url.pathname)
              && Number(url.pathname.split('/').at(-1)) === id && response.status() === 200;
          }, { timeout: timeouts.save }).then(() => true, error => {
            if (error.exitCode !== undefined || error.code === 'rate_limited') throw error;
            return false;
          });
          // Also handle rejection while injection itself is pending or fails.
          saveResponse.catch(() => {});
          let outcome = await inject(page, plan, schema, err);
          let saveReason = 'save_unconfirmed';
          if (await saveResponse) {
            try {
              const draft = await findDraftById(request, origin, id);
              if (draft) saveReason = normalizeTitle(draft.draft_title) === normalizeTitle(plan.title) ? null : 'title_mismatch';
            } catch (error) {
              if (error.code === 'rate_limited' || error.exitCode !== undefined) throw error;
              if (!(error instanceof RemoteListError)) throw error;
            }
          }
          // A successful PUT with a matching title does not mean the body was saved. Unlike user input, a programmatic setContent
          // may not emit an update event; autosave can then store only the title and leave an empty draft.
          // After saving, reopen the draft in a separate page and judge from the body the server stored.
          if (!saveReason) {
            const persisted = await readPersistedDoc(context, draftUrl, schema, timeouts.persistedRead);
            if (!persisted) saveReason = 'save_unconfirmed';
            else if (!docHasContent(persisted)) saveReason = 'body_not_saved';
            else if (!['editor_unreachable', 'paywall_not_inserted'].includes(outcome.reason)) {
              // Judge completeness from the saved content, not from the in-memory content right after injection
              const observed = observeEditorCompleteness(persisted, { paywallType: schema?.paywallNode?.type, hasPaid: plan.paywall });
              outcome = classifyOutcome({ hasPaid: plan.paywall, editorReachable: true, ...observed, fixtureAvailable: Boolean(schema?.paywallNode) });
            }
          }
          check();
          if (saveReason) outcome = { ...outcome, outcome: 'draft_incomplete', reason: saveReason };
          const saved = { ...details, ...outcome, draftUrl };
          state = outcome.outcome === 'draft_incomplete' ? recordDraftIncomplete(state, slug, saved) : recordDraftCreated(state, slug, saved);
          saveState(statePath, state);
          results.push({ slug, ...outcome, outcome: outcome.outcome === 'draft_created' && target.action === 'repair' ? 'repaired' : outcome.outcome, draftUrl, meta: sources });
          remote.push({ title: meta.title, url: draftUrl });
        } catch (error) {
          // A deadline or a typed error (lock/deadline) stops the whole run. Anything else is recorded as one failure and the rest continue.
          if (expired || error.exitCode !== undefined || error.code === 'rate_limited') throw error;
          err(`Failed: ${i.slug}: ${error.message}`);
          results.push({ slug: i.slug, outcome: 'failed', reason: error.code ?? 'error', message: error.message, meta: i.sources });
        }
      }
    };
    const code = ['post', 'login'].includes(mode) ? await withDeadline(run, opts.timeout * 1000) : await run();
    if (opts.open && context && !code) {
      err('Review the draft visually, then close the browser.');
      await new Promise(resolve => context.once('close', resolve));
    }
    return finish(code ? { exitCode: code } : {});
  } catch (error) {
    expired = true;
    abort.abort();
    err(error.message);
    return finish({ exitCode: error.exitCode ?? 1, ...(error.code === 'rate_limited' ? { nextAction: 'retry_later' } : {}), errors: [{ code: error.code ?? 'error', message: error.message }] });
  } finally {
    expired = true;
    try { if (context) await context.close(); } finally { lock?.release(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
