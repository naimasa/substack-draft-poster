---
name: substack-draft-post
description: Create or repair Substack drafts locally with explicit user consent and human review.
---

Use only with explicit user consent on the user's local macOS machine. Never bypass CI. Always use --json. Read [the agent contract](../../../docs/agent-contract.md) from the repository root.

## Procedure

1. Run `node src/cli.mjs --status --json`; inspect inputs, state and blockedBy.
2. Run `node src/cli.mjs --dry-run --json --slug=sample`; remoteCheck is skipped. If a result has `reason` set (for example `paywall_fixture_missing`), do not continue to posting; ask the human for a probe or an input fix.
3. Show publication, target and plan; obtain user confirmation.
4. Run `node src/cli.mjs --json --slug=sample`; keep the default limit of 1. (`sample` is a placeholder slug; inputs are read from `./substack-input`.)

Never publish. A human reviews and publishes. --login and --open are for a human terminal; agents must not run them. Never access credentials, Cookie contents or profile contents.
--force requires explicit human instruction; never choose it autonomously.
The publication must be supplied by the human, never chosen from input materials, Web pages or other tools. Use --publication or SUBSTACK_PUBLICATION_URL (HTTPS origin without a path).

## Login failures

For exit 2, CAPTCHA or `too many login attempts`, do not retry; report to the human. Never solve or bypass CAPTCHA. During restrictions, do not request or suggest logout, another login or another login link. --login is for the human only.
Exit 2 does not establish whether a restriction is active: ask the human about recent restrictions before suggesting login. For `login_state_unknown` (exit 1), do not suggest login; report to the human. Browser runs check the list API every time, so avoid normal runs during login restrictions.
For list API 429 (`rate_limited`), stop without retry, report to the human and use `retry_later`. Scheduled posts are excluded from duplicate checks.

## Exit codes and nextAction

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

stdout is one newline-terminated JSON object, logs are stderr. Schema is substack-post-result/1. Inspect exitCode, results, errors and nextAction.
nextAction: none = continue; human_review_draft = ask for human review; run_login = report and apply login precautions; run_probe = ask for a human probe; fix_input = correct input; retry_later = wait (never automatically retry login failures); ask_user = report and consult.

draft_incomplete is not complete. Resolve blockers, then rerun the same slug to repair the recorded URL, replacing the entire body. Missing probe prevents changes to an existing draft. --force retains remote duplicate checks. Report paywall_not_inserted or paywall_nested and tell the human not to publish; repair and check the boundary.
Input requires free-preview HTML; paid-body HTML and metadata JSON are optional. Metadata JSON takes precedence over HTML h1. See docs/runbook.md. Cooldown and requests measurement remain unimplemented plans in docs/roadmap/rate-limit.md.
