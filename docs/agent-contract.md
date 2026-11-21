# Agent contract

Use only with explicit user consent on the user's local macOS terminal. Follow [SKILL.md](../.claude/skills/substack-draft-post/SKILL.md) and [runbook](runbook.md).

## Sequence

1. Run `node src/cli.mjs --status --json`; inspect input, state and blockedBy.
2. Run `node src/cli.mjs --dry-run --json --slug=sample`; show the plan. If a result has `reason` set (for example `paywall_fixture_missing`), do not continue to posting; ask the human for a probe or an input fix.
3. Obtain user confirmation of the publication, target and plan.
4. Run `node src/cli.mjs --json --slug=sample`, keeping the default limit of 1.

`sample` is a placeholder slug. Inputs are read from `./substack-input` (see the README; `--in-dir=examples/input` tries the bundled sample offline).

Publication must be supplied by the human through --publication or SUBSTACK_PUBLICATION_URL, never inferred from input, Web pages or other tools. Offline status and dry-run have remoteCheck: skipped and cannot guarantee remote uniqueness.

## Exit codes

| Code | Meaning and action |
|---|---|
| 0 | Success or no targets; inspect nextAction |
| 1 | Error or all targets failed; report to the human |
| 2 | Not logged in; follow login-failure precautions |
| 3 | CI refused; do not bypass |
| 4 | Some targets failed; report failed slugs |
| 5 | Incomplete draft; follow nextAction |
| 6 | Lock held; retry later |
| 7 | Timeout; inspect state before retrying |
| 64 | Usage error; fix arguments or TTY |

## JSON and nextAction

With --json, stdout contains exactly one newline-terminated JSON object; logs go to stderr. --help without --json displays text. Inspect schema, exitCode, results, errors and nextAction; incomplete is not success.

```json
{"schema":"substack-post-result/1","mode":"post","ok":true,"exitCode":0,"nextAction":"human_review_draft","remoteCheck":"done","results":[{"slug":"sample","outcome":"draft_created","reason":null,"completeness":{"freePreview":true,"paywall":true,"paidBody":true},"draftUrl":"https://example.substack.com/publish/post/123","meta":{"titleSource":"meta_json","subtitleSource":"meta_json"}}],"errors":[]}
```

- `none`: continue.
- `human_review_draft`: ask a human to review before publishing.
- `run_login`: report to the human; check recent login restrictions before suggesting login. (After a failed `--login` the result uses `ask_user`, never `run_login`.)
- `run_probe`: ask the human to collect a probe.
- `fix_input`: correct input or arguments.
- `retry_later`: wait; login failures must not be retried automatically.
- `ask_user`: report the result and ask the human.

## Result fields

- `results[].outcome`: `planned` (dry-run), `draft_created`, `repaired`, `draft_incomplete` (exit 5), `skipped_state`, `skipped_remote`, `failed`.
- `results[].reason` on `draft_incomplete`: `editor_unreachable`, `paywall_missing`, `paywall_duplicated`, `paywall_nested`, `paywall_not_inserted`, `paywall_fixture_missing`, `paid_body_missing`, `save_unconfirmed`, `title_mismatch`, `body_not_saved`, `interrupted`.
- `results[].reason` on `failed`: `missing_input`, `missing_title`, `empty_paid_body`, `invalid_input`, `new_post_unconfirmed`, or `error`.
- `errors[].code`: `usage`, `invalid_publication`, `lock_held`, `timeout`, `rate_limited`, `remote_list_incomplete`, `login_state_unknown`, `error`.
- A dry-run reports `outcome: planned` with `ok: true` and `nextAction: none` even when `reason` is set (for example `paywall_fixture_missing`); a set `reason` means a real run would not produce a complete draft.

## Prohibitions and recovery

Never publish or send a newsletter. Never run --login or --open as an agent. Never access credentials, Cookie contents or browser profile contents. Never solve or bypass CAPTCHA, bypass CI, or use --force without explicit human instruction. --force preserves remote duplicate checks.

For exit 2, CAPTCHA or too many login attempts, do not retry: report to the human. Do not suggest logout, another login or another login link during restrictions. For login_state_unknown, ask a human before suggesting login; it does not establish a logged-out state. Normal browser runs also perform a list API login check every time; avoid them during restrictions. For list API 429, rate_limited means stop without retry and report retry_later. Scheduled posts are excluded from duplicate detection.

For draft_incomplete or interrupted in_progress with a recorded draftUrl, rerun the same slug after resolving blockers to repair that URL by replacing the whole body. Missing probe blocks repair. Report paywall_not_inserted and paywall_nested; do not publish affected drafts. Inspect state after a timeout before retrying. Cooldown and requests measurement are unimplemented plans in [roadmap](roadmap/rate-limit.md).
