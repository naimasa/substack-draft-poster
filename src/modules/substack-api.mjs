// The dashboard's private API may change. Only HTTP GET is used; nothing is written.
import { normalizeTitle } from './substack-post-state.mjs';
import { LIST_ORDER } from './substack-ui.mjs';

export class RemoteListError extends Error {
  constructor(code) { super(code); this.name = 'RemoteListError'; this.code = code; }
}
export function buildListUrl(origin, kind, { offset = 0, limit = 25 } = {}) {
  if (!Object.hasOwn(LIST_ORDER, kind)) throw new TypeError('Invalid list kind');
  const url = new URL(`/api/v1/post_management/${kind}`, origin);
  url.search = new URLSearchParams({ offset, limit, order_by: LIST_ORDER[kind], order_direction: 'desc' }).toString();
  return url.href;
}
async function readList(request, url) {
  const response = await request.get(url);
  if (response.status() === 429) throw new RemoteListError('rate_limited');
  if (response.status() !== 200) throw new RemoteListError('unexpected_status');
  let data;
  try { data = await response.json(); } catch { throw new RemoteListError('unexpected_shape'); }
  if (!data || !Array.isArray(data.posts)) throw new RemoteListError('unexpected_shape');
  return data;
}
export async function checkLoginByApi(request, origin) {
  try {
    await readList(request, buildListUrl(origin, 'drafts', { offset: 0, limit: 1 }));
    return 'logged_in';
  } catch (error) {
    if (!(error instanceof RemoteListError) || error.code === 'rate_limited') throw error;
    return { unknown: error.code };
  }
}
export async function fetchAllPosts(request, origin, kind, { limit = 25, maxPages = 40 } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(maxPages) || maxPages < 1) throw new TypeError('Invalid pagination');
  const posts = [];
  const ids = new Set();
  let total;
  for (let page = 0, offset = 0; page < maxPages; page++, offset += limit) {
    const data = await readList(request, buildListUrl(origin, kind, { offset, limit }));
    if (!Number.isSafeInteger(data.total) || data.total < 0) throw new RemoteListError('unexpected_shape');
    if (data.isCapped === true) throw new RemoteListError('capped');
    if (total !== undefined && total !== data.total) throw new RemoteListError('incomplete');
    total = data.total;
    if (data.posts.length > limit || offset + data.posts.length > total) throw new RemoteListError('unexpected_shape');
    for (const row of data.posts) {
      if (!row || !Number.isSafeInteger(row.id) || (row.title != null && typeof row.title !== 'string') || (row.draft_title != null && typeof row.draft_title !== 'string')) throw new RemoteListError('unexpected_shape');
      if (ids.has(row.id)) throw new RemoteListError('incomplete');
      ids.add(row.id);
      const title = row.title || row.draft_title;
      if (title?.trim()) posts.push({ id: row.id, title, slug: row.slug, isPublished: row.is_published });
    }
    if (offset + data.posts.length === total) return { posts, total };
    if (!data.posts.length || data.posts.length < limit) throw new RemoteListError('incomplete');
  }
  throw new RemoteListError('incomplete');
}
export const findRemoteMatch = (remotePosts, title) => remotePosts.find(post => normalizeTitle(post.title) === normalizeTitle(title));

// Saving is verified against draft_title on the first dashboard page.
export async function findDraftById(request, origin, id) {
  const data = await readList(request, buildListUrl(origin, 'drafts'));
  return data.posts.find(post => post?.id === id);
}
