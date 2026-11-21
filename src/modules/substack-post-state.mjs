import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const emptyState = () => ({ posts: {} });
export function loadState(file) {
  if (!fs.existsSync(file)) return emptyState();
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!state.posts || typeof state.posts !== 'object' || Array.isArray(state.posts)) throw new Error('Invalid post state');
  return state;
}
export function saveState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(tmp, file);
  } finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
export const hashSource = (free, paid) => createHash('sha256').update(JSON.stringify([free, paid ?? null])).digest('hex');
export const normalizeTitle = (title) => String(title).normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
export function nextStatus(status, event) {
  if (event === 'draft_incomplete' && [null, undefined, 'in_progress', 'draft_incomplete'].includes(status)) return 'draft_incomplete';
  if (event === 'repair_ok' && status === 'draft_incomplete') return 'draft_created';
  if (event === 'start' && [null, undefined, 'in_progress', 'skipped'].includes(status)) return 'in_progress';
  if (event === 'draft_ok' && [null, undefined, 'in_progress'].includes(status)) return 'draft_created';
  if (event === 'mark_published' && ['draft_created', 'published'].includes(status)) return 'published';
  if (event === 'skip' && !['draft_created', 'published'].includes(status)) return 'skipped';
  throw new Error(`Invalid status transition: ${status} / ${event}`);
}
export const shouldSkip = (state, slug, { force = false } = {}) => !force && ['draft_created', 'published'].includes(state.posts[slug]?.status);
function record(state, slug, details, status) {
  return { ...state, posts: { ...state.posts, [slug]: { ...state.posts[slug], ...details, status, updatedAt: new Date().toISOString() } } };
}
export const recordDraftCreated = (state, slug, details) => record(state, slug, details, nextStatus(state.posts[slug]?.status, 'draft_ok'));
export const recordSkipped = (state, slug, details) => record(state, slug, details, nextStatus(state.posts[slug]?.status, 'skip'));

export const recordDraftIncomplete = (state, slug, details) => record(state, slug, details, nextStatus(state.posts[slug]?.status, 'draft_incomplete'));
export const recordRepaired = (state, slug, details) => record(state, slug, { ...details, reason: null }, nextStatus(state.posts[slug]?.status, 'repair_ok'));
