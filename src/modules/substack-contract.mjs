import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { extractTitleAndBody } from './substack-tiptap.mjs';
export function browserLaunchOptions() {
  // viewport: null drops Playwright's fixed 1280x720 default so the page follows the window.
  // This addresses a page that did not follow the window; whether it also fixes how a CAPTCHA is displayed is unverified.
  // A human watches the screen, so this is never headless.
  return { headless: false, viewport: null, args: ['--window-size=1280,900'] };
}
export const EXIT = Object.freeze({ OK: 0, ERROR: 1, NOT_LOGGED_IN: 2, CI_REFUSED: 3, PARTIAL: 4, INCOMPLETE: 5, LOCK_HELD: 6, TIMEOUT: 7, USAGE: 64 });
export function exitCodeFor(results) {
  const failed = results.filter(r => r.outcome === 'failed').length;
  return failed ? failed === results.length ? 1 : 4 : results.some(r => r.outcome === 'draft_incomplete') ? 5 : 0;
}
export function classifyOutcome({ hasPaid, paywallInserted, paidBodyInserted, editorReachable, fixtureAvailable, paywallNested, paywallCount }) {
  const reason = !editorReachable ? 'editor_unreachable' : hasPaid && !paywallInserted ? (paywallCount > 1 ? 'paywall_duplicated' : paywallNested ? 'paywall_nested' : fixtureAvailable ? 'paywall_missing' : 'paywall_fixture_missing') : hasPaid && !paidBodyInserted ? 'paid_body_missing' : null;
  return { outcome: reason ? 'draft_incomplete' : 'draft_created', reason, completeness: { freePreview: true, paywall: !editorReachable ? false : hasPaid ? Boolean(paywallInserted) : null, paidBody: !editorReachable ? false : hasPaid ? Boolean(paywallInserted && paidBodyInserted) : null } };
}
export function buildResult({ mode, results = [], errors = [], exitCode = exitCodeFor(results), nextAction, remoteCheck = 'done' }) {
  // After a failed interactive login, do not tell the caller to log in again.
  nextAction ??= ({ 1: 'ask_user', 2: mode === 'login' ? 'ask_user' : 'run_login', 3: 'ask_user', 4: 'ask_user', 5: results.some(r => r.reason === 'paywall_fixture_missing') ? 'run_probe' : 'ask_user', 6: 'retry_later', 7: 'retry_later', 64: 'fix_input' })[exitCode] ?? (results.some(r => ['draft_created', 'repaired'].includes(r.outcome)) ? 'human_review_draft' : 'none');
  return { schema: 'substack-post-result/1', mode, ok: exitCode === 0, exitCode, nextAction, remoteCheck, results, errors };
}
export function resolveMeta({ metaJson, freeHtml }) {
  const title = [[metaJson?.title, 'meta_json'], [extractTitleAndBody(freeHtml).title, 'h1']].find(([v]) => typeof v === 'string' && v.trim());
  if (!title) return { error: 'missing_title' };
  const subtitle = [[metaJson?.subtitle, 'meta_json']].find(([v]) => typeof v === 'string' && v.trim()) ?? ['', 'none'];
  return { title: title[0].trim(), subtitle: subtitle[0].trim(), titleSource: title[1], subtitleSource: subtitle[1] };
}
export class UsageError extends Error { constructor(message) { super(message); this.exitCode = 64; this.code = 'usage'; } }
export function resolvePublication({ flag, env = process.env }) {
  try {
    const u = new URL(flag ?? env.SUBSTACK_PUBLICATION_URL);
    if (u.protocol !== 'https:' || u.pathname !== '/' || u.search || u.hash || u.username || u.password) throw new Error();
    return u.origin;
  } catch { const e = new UsageError('Specify --publication or SUBSTACK_PUBLICATION_URL as an HTTPS origin'); e.code = 'invalid_publication'; throw e; }
}
export const isCiEnvironment = env => env.GITHUB_ACTIONS !== undefined || (env.CI !== undefined && !['', '0', 'false'].includes(String(env.CI).toLowerCase()));
export function parseArgs(args) {
  const flags = new Set(['help', 'status', 'json', 'login', 'dry-run', 'force', 'open']);
  const values = new Set(['in-dir', 'slug', 'limit', 'mark-published', 'publication', 'timeout']);
  const opts = {};
  for (const arg of args) {
    const m = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m || !flags.has(m[1]) && !values.has(m[1])) throw new UsageError(`Unknown argument: ${arg}`);
    if (flags.has(m[1]) && m[2] !== undefined || values.has(m[1]) && !m[2]) throw new UsageError(`Invalid value: ${arg}`);
    opts[m[1]] = m[2] ?? true;
  }
  for (const name of ['slug', 'mark-published']) if (opts[name] && !/^[\w-]+$/.test(opts[name])) throw new UsageError('Invalid slug');
  for (const [name, fallback, max] of [['limit', 1, Number.MAX_SAFE_INTEGER], ['timeout', 900, 3600]]) {
    opts[name] = Number(opts[name] ?? fallback);
    if (!Number.isSafeInteger(opts[name]) || opts[name] < 1 || opts[name] > max) throw new UsageError(`Invalid --${name}`);
  }
  if (opts.open && opts.json) throw new UsageError('--open cannot be combined with --json');
  if (['help', 'status', 'login', 'dry-run', 'mark-published'].filter(k => opts[k]).length > 1) throw new UsageError('Specify only one mode');
  if (opts.login && (opts.slug || opts.open || opts.force)) throw new UsageError('Use --login on its own');
  return opts;
}
export class LockHeldError extends Error { constructor() { super('Another process is running'); this.exitCode = 6; this.code = 'lock_held'; } }
/**
 * Prepare the browser profile directory (it holds cookies) readable only by the owner (0700).
 * An existing directory is never chmod-ed (a location the user chose is not changed behind their back).
 * Returns loose:true when other users can read it, so the caller can warn.
 */
export function ensurePrivateDir(dir) {
  const existed = fs.existsSync(dir);
  if (!existed) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return { created: !existed, loose: existed && (fs.statSync(dir).mode & 0o077) !== 0 };
}
export function acquireLock(file, { pid = process.pid, now = Date.now, isAlive = p => { try { process.kill(p, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } } } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let stale = false;
  const token = randomUUID();
  for (let i = 0; i < 3; i++) {
    try { fs.writeFileSync(file, JSON.stringify({ pid, startedAt: now(), token }), { flag: 'wx' }); return { stale, release() { try { if (JSON.parse(fs.readFileSync(file)).token === token) fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; } } }; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let old;
      try { old = JSON.parse(fs.readFileSync(file)); } catch { throw new LockHeldError(); }
      if (!Number.isInteger(old.pid) || old.pid <= 0 || isAlive(old.pid)) throw new LockHeldError();
      // Between the read and the delete, another process may have created a new lock.
      // Take the lock over only if it is the same one that was read; otherwise refuse without deleting someone else's lock.
      try {
        if (JSON.parse(fs.readFileSync(file, 'utf8')).token !== old.token) throw new LockHeldError();
        fs.unlinkSync(file);
      } catch (error) {
        if (error instanceof LockHeldError) throw error;
        if (error instanceof SyntaxError) throw new LockHeldError(); // someone else is writing it
        if (error.code !== 'ENOENT') throw error; // someone already removed it; try to create it on the next pass
      }
      stale = true;
    }
  }
  throw new LockHeldError();
}
export class TimeoutError extends Error { constructor() { super('Processing timed out'); this.exitCode = 7; this.code = 'timeout'; } }
export async function withDeadline(run, ms) {
  let timer;
  try { return await Promise.race([Promise.resolve().then(run), new Promise((_, reject) => { timer = setTimeout(() => reject(new TimeoutError()), ms); })]); }
  finally { clearTimeout(timer); }
}
export function planTarget({ entry, remoteMatch, force = false } = {}) {
  if (entry?.status === 'in_progress' && entry.draftUrl) return { action: 'repair', reuseDraftUrl: entry.draftUrl };
  if (entry?.status === 'draft_incomplete') {
    if (!entry.draftUrl) throw new Error('The incomplete draft has no URL');
    return { action: 'repair', reuseDraftUrl: entry.draftUrl };
  }
  if (!force && ['draft_created', 'published'].includes(entry?.status)) return { action: 'skip', reason: 'state_skip' };
  if (remoteMatch) return { action: 'skip', reason: 'remote_duplicate' };
  return { action: 'create' };
}

/**
 * Whether the editor content (getJSON) has a non-empty body.
 * Confirming the saved title alone does not show the body was saved (this avoids reporting an empty-body draft as a success).
 * Nodes without text, such as a Paywall or a horizontal rule, do not count as body.
 */
export function docHasContent(docJson) {
  const has = (node) => Boolean(node && ((typeof node.text === 'string' && node.text.trim()) || (Array.isArray(node.content) && node.content.some(has))));
  return Array.isArray(docJson?.content) && docJson.content.some(has);
}
export function observeEditorCompleteness(docJson, { paywallType, hasPaid } = {}) {
  const content = docJson?.content;
  const index = hasPaid && paywallType && Array.isArray(content)
    ? content.findIndex(node => node?.type === paywallType) : -1;
  const hasContent = node => Boolean(typeof node?.text === 'string' && node.text.trim())
    || (Array.isArray(node?.content) && node.content.some(hasContent));
  const paywallCount = index >= 0 ? content.filter(node => node?.type === paywallType).length : 0;
  const containsPaywall = node => Boolean(node && (node.type === paywallType
    || (Array.isArray(node.content) && node.content.some(containsPaywall))));
  const paywallNested = Boolean(hasPaid && paywallType && paywallCount === 0
    && Array.isArray(content) && content.some(containsPaywall));
  const paywallInserted = paywallCount === 1;
  return { paywallInserted, paidBodyInserted: paywallInserted && content.slice(index + 1).some(hasContent), paywallNested, paywallCount };
}

export function resolveProfileDir({ env = process.env, home = os.homedir() } = {}) {
  if (env.SUBSTACK_PROFILE_DIR) return { dir: env.SUBSTACK_PROFILE_DIR };
  return { dir: path.join(home, '.substack-draft-poster', 'profile') };
}
export function resolvePaths({ env = process.env, cwd = process.cwd() } = {}) {
  return { stateFile: env.SUBSTACK_STATE_FILE ?? path.join(cwd, '.substack-poster/state.json'),
    schemaFile: env.SUBSTACK_SCHEMA_FILE ?? path.join(cwd, '.substack-poster/tiptap-schema.json'),
    inDir: env.SUBSTACK_IN_DIR ?? path.join(cwd, 'substack-input') };
}
