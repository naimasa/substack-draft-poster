# Substack UI and API observations

Observed on 2026-11-15–16: the authenticated Substack publication dashboard and draft editor, reported by a local user. Publication names and draft/article IDs are replaced with synthetic example.substack.com and 123. Facts, inferences and unobserved behavior are distinguished below.

## Observed facts and inferences

- No `New post` link existed. The dashboard had Create, Drafts and Posts links, and Published, Scheduled and Drafts tabs. Cookie `substack.sid` had an expiry of approximately 90 days and survived browser restarts; no Cookie value is recorded here.
- `/publish/posts/drafts` and `/publish/posts/published` existed; `/publish/posts` redirected to the latter. Draft rows linked to `/publish/post/123`; published rows to `/publish/posts/detail/123`. The initial published view showed only part of the list, with no pagination button found. Whole-row text probably contains more than a title; that inference was not verified by reading the text.
- The dashboard issued `GET /api/v1/post_management/drafts?offset=0&limit=25&order_by=draft_updated_at&order_direction=desc` and `GET /api/v1/post_management/published?offset=0&limit=25&order_by=post_date&order_direction=desc`. Repeating those dashboard GETs returned 200. Responses contained `{ posts, offset, limit, total, isCapped }`.
- Post fields included numeric id, title, draft_title, slug, is_published, post_date, draft_created_at and draft_updated_at. Draft title was null and draft_title carried the title; published posts used title.
- Create offered Article, Video, Note, Chat thread and Recording studio. Article navigated to `/publish/post?type=<value>`. Arrival triggered `POST /api/v1/drafts`, creating an empty draft before typing, then changed the URL to `/publish/post/123`. The actual type value was not recorded: `/publish/post?type=newsletter` is inferred from the page title Editing newsletter.
- Title used `textarea placeholder="Title" aria-label="title"`; subtitle used `Add a subtitle…`; there was one `.ProseMirror`. `element.editor` exposed setContent and getJSON; three other candidate paths did not exist.
- Saving... briefly became Saved on creation. Manual typing produced `PUT /api/v1/drafts/123` responses with status 200, approximately ten seconds later and again about ten seconds after that. These POST/PUT calls were made by the page, not by the tool's HTTP client.
- Several auxiliary GETs returned 429 immediately after draft creation, including publication/has_multiple_users, caption_translations, theme and auto-upload-state. Thresholds and recovery times remain unknown.

## Paywall observations on 2026-11-16

A run returned draft_incomplete/paywall_missing. After a diagnostic experiment, a reopened draft had paid headings directly after the free preview without a top-level Paywall; the user also reported seeing all headings. The exact body immediately after the run and before that experiment was not read.

In a diagnostic draft ending in an ordered list, focus('end') plus insertContent returned true without increasing the top-level node count. The UI displayed `Paid content below this line` and Saved. A probe captured a top-level `{ type: 'paywall' }` with no attributes.

Unverified hypotheses: a second focus('end') selected and replaced the boundary, or insertion placed the Paywall inside a nested list item. A visible banner does not establish a top-level boundary. The implementation therefore uses insertContentAt at the absolute end of the document and verifies exactly one top-level Paywall before adding paid content.

## Unobserved behavior

- Actual insertContentAt behavior and the repaired boundary's visibility to free readers need human verification.
- Scheduled list API; conditions for isCapped; logged-out API statuses; the exact Create → Article type value remain unobserved.
- Paywall getJSON was initially unobserved before the later probe noted above.
- Whether programmatic setContent triggers autosave PUT and includes the body remains unobserved. The observed PUT was from manual typing. Tiptap version-specific update behavior may differ. The tool passes `{ emitUpdate: true }` and reopens the saved draft in a separate page to inspect persisted content; an empty body yields body_not_saved.
- Time until a reopened body is readable is unmeasured; the tool polls up to ten seconds at 500 ms intervals.

## Re-observation

For login_state_unknown, remote_list_incomplete or suspected UI changes, use the read-only diagnostics with a logged-in local profile. Do not run during login restrictions or retry after 429.

```sh
export SUBSTACK_PUBLICATION_URL=https://example.substack.com
node src/diagnostics/substack-survey-lists.mjs
DRAFT_URL=https://example.substack.com/publish/post/123 node src/diagnostics/substack-survey-lists.mjs
node src/diagnostics/substack-survey-editor-watch.mjs
```

DRAFT_URL selects an existing draft; otherwise editor inspection is skipped. SUBSTACK_PROFILE_DIR selects a profile. editor-watch inspects list response keys and types, then watches human Create → Article, typing and saving (240 seconds by default; WATCH_SECONDS overrides). Diagnostics do not click, type or send write HTTP themselves. Human creation leaves an empty draft; the human removes it after observation. Update src/modules/substack-ui.mjs constants, observation dates, facts, inferences and unknowns together. Confirm the actual type before promoting newsletter from inference to fact.
