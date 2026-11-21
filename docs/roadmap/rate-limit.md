# Not implemented: rate-limit mitigation

This is a plan, not a feature. The tool currently stops on a 429 from the list API (`rate_limited`, exit 1, `retry_later`) and nothing more.

## Observed facts

- A list API call returned 429 during a real run, and Substack's own pages sometimes show "Too many requests". The threshold and the time until it clears are unknown.
- A 429 is detected only from the list API response. If a page navigation returns a 429 page, `page.goto` does not throw, the `.ProseMirror` wait times out, and the failure is reported as something else (for example `new_post_unconfirmed`).
- The number of requests one run sends to Substack has not been counted. The tool's own list GETs (one login check, every drafts/published page, one check after saving) and the traffic the page and editor generate on their own (including the autosave `PUT`) are mixed together; which dominates is unmeasured.
- Nothing stops an immediate re-run after a 429; only documentation warns the user.

## Planned design

1. **Measure first.** Count requests per run by kind (`api_get`, `navigation`, `xhr`, `write`, `asset`) for the publication origin and `substack.com`, using Playwright request/response events plus the tool's own GET calls, and report them as `requests` in the result JSON (approximate; zero for status, dry-run, mark-published, help and usage errors).
2. **Detect 429 on pages.** Treat a 429 on a main-frame navigation or an `/api/` fetch/XHR as `rate_limited` and stop at the next check without retrying. Count, but do not stop on, 429s from assets or third-party hosts.
3. **Cooldown.** Record the time of a 429 in the state file (`rateLimit.at`). A posting run within `--cooldown` minutes (default 30, 0 disables, integer 0-1440) is refused without starting a browser: exit 1, `retry_later`, `errors[0].code: cooldown`, plus `retryAfter`. No new exit code. `--dry-run`, `--status`, `--mark-published` and `--help` are never refused; `--login` only warns.
4. **Pace the list reads.** Wait between list pages and between the drafts and published lists (default 1.5 s).
5. **Reuse one read.** Merge the login check with the first drafts-list request, and always fetch the post-save check fresh.
6. **Unchanged.** Exit-code table, the `--open`/`--json` exclusion, drafts only, GET-only HTTP, and the existing result keys (`requests`, `retryAfter` and `cooldown` are additions).

## Out of scope

Finding the real threshold (decide after seeing measurements), removing the persisted-body re-read (needed to confirm saves), and anything on Substack's side.

## Manual check once implemented

Run one article without `--dry-run`, read `requests` to see which kind dominates and, if a 429 occurs, confirm that `rateLimit.at` is recorded and a re-run within 30 minutes is refused. Whether 429s decrease can only be judged over several runs.
