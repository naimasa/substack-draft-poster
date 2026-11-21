// Observed 2026-11-15 to 16; see docs/ui-observations.md.
export const UI_OBSERVED_ON = '2026-11-15';
// Observed 2026-11-15 to 16; see docs/ui-observations.md.
// type=newsletter is an assumption. Confirm the value manually.
export const NEW_POST_PATH = '/publish/post?type=newsletter';
// Observed 2026-11-15 to 16; see docs/ui-observations.md.
export const DRAFT_PATH_RE = /\/publish\/post\/\d+/;
// Observed 2026-11-15 to 16; see docs/ui-observations.md.
export const DASHBOARD_DRAFTS_PATH = '/publish/posts/drafts';
// Observed 2026-11-15 to 16; see docs/ui-observations.md.
export const LIST_ORDER = Object.freeze({ drafts: 'draft_updated_at', published: 'post_date' });
// Observed 2026-11-15 to 16; see docs/ui-observations.md.
export const SAVE_REQUEST = Object.freeze({ method: 'PUT', pathRe: /\/api\/v\d+\/drafts\/\d+$/ });
