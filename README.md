# Substack Draft Poster

## Overview

Create or repair Substack drafts from prepared free-preview and optional paid-body HTML using a visible local browser. A human reviews and publishes. [日本語版](README.ja.md).

## What it does not do

Does not publish, send newsletters, generate or translate content, export Markdown, upload cover/body images, solve CAPTCHA, or provide unattended CI posting.

## Requirements

macOS, Node.js 20+, npm, Playwright and its Chromium browser. Interactive login and --open need a human terminal (TTY). Have access to the publication you explicitly configure.

## Installation

From the cloned repository directory:
```sh
npm install
npx playwright install chromium
```
Run commands from this directory. No global installation is required.

## Quick start

Within five minutes after installation, try the synthetic sample offline:

```sh
node src/cli.mjs --in-dir=examples/input --slug=sample --dry-run --json
```
No login, network access, browser, draft creation or state write is needed. A paid sample without a probe reports paywall_fixture_missing; that is an incomplete posting plan, not a posting failure. Inspect the JSON and example files before using real input.

## Configuration

| Environment | Flag | Default / behavior |
|---|---|---|
| SUBSTACK_PUBLICATION_URL | --publication=URL | No default; HTTPS origin; flag wins; required for browser modes |
| SUBSTACK_PROFILE_DIR | — | ~/.substack-draft-poster/profile |
| SUBSTACK_STATE_FILE | — | ./.substack-poster/state.json |
| SUBSTACK_SCHEMA_FILE | — | ./.substack-poster/tiptap-schema.json |
| SUBSTACK_IN_DIR | --in-dir=PATH | ./substack-input; flag wins |
| — | --slug=SLUG | All discovered slugs, up to --limit |
| — | --limit=N | 1; positive integer |
| — | --timeout=SECONDS | 900; integer 1–3600 |
| — | --dry-run | false; offline plan |
| — | --force | false; bypass local skip only |
| — | --open | false; wait for human browser close |
| — | --mark-published=SLUG | Unset; mark an existing draft_created record as published locally |
| — | --status | false; offline input and state inventory |
| — | --json | false; one result JSON on stdout |
| — | --login | false; human interactive login |
| — | --help | false; show help |

Paths are relative to the working directory. The browser profile defaults to ~/.substack-draft-poster/profile. Set SUBSTACK_PROFILE_DIR to use another directory, or, to keep an existing signed-in profile, make the default a symlink to it (`mkdir -p ~/.substack-draft-poster && ln -s /path/to/existing-profile ~/.substack-draft-poster/profile`). The lock is substack.lock in the profile parent. --open requires a TTY and cannot accompany --json. Mode selectors --help, --status, --login, --dry-run and --mark-published are mutually exclusive; value flags use =VALUE. --login cannot accompany --slug, --force or --open. The timeout excludes human waiting with --open; --login is subject to --timeout, so a sign-in slower than the limit exits 7.

## Input format

Prepare `<slug>-free-preview.html` (required), `<slug>-paid-body.html` (optional) and `<slug>.meta.json` (optional) in ./substack-input. Slugs use letters, digits, underscores and hyphens. Example metadata:
```json
{"title":"Example article","subtitle":"A synthetic example"}
```
Title comes from nonempty metadata title, then free HTML h1. Subtitle comes only from metadata, otherwise empty. Missing title blocks posting. The tool consumes pre-split HTML, not Markdown: put the free part (introduction and first section) in `<slug>-free-preview.html` and the paid sections in `<slug>-paid-body.html`. The result is free preview → one top-level Paywall → paid body.

Run `node src/probe.mjs` with a human to observe the editor. The probe needs SUBSTACK_PUBLICATION_URL set, a profile already signed in with `--login`, and the same working directory; the "fixture" it writes is `.substack-poster/tiptap-schema.json`. Alternatively copy examples/tiptap-schema.example.json to .substack-poster/tiptap-schema.json (create the directory first) to skip the probe. This structural example is not loaded automatically and may need re-observation. Without a fixture, a new paid draft saves only the free preview as incomplete; blocked repair leaves the existing draft unchanged.

## Usage

```sh
export SUBSTACK_PUBLICATION_URL=https://example.substack.com
node src/cli.mjs --login
node src/cli.mjs --status --json
node src/cli.mjs --slug=sample --dry-run --json
node src/cli.mjs --slug=sample --json
node src/cli.mjs --slug=sample --open
node src/cli.mjs --mark-published=sample
node src/cli.mjs --slug=sample --json
```

First copy the sample inputs (`cp -r examples/input substack-input`) or pass `--in-dir=examples/input`; `sample` is a placeholder slug. The first command is human login; status and dry-run inspect offline. After reviewing the plan, normal execution creates a draft; --open is an interactive alternative that waits for browser close. The human publishes, then --mark-published updates only the existing local record (it must have status draft_created or already be published; otherwise it exits 1). The last command illustrates repair: for draft_incomplete or interrupted in_progress with a recorded URL, resolve blockers and rerun the same slug to replace the whole body at that URL. Completed local records are skipped. --force requires explicit human instruction and still checks remote duplicates. See [runbook](docs/runbook.md).

## Exit codes and JSON result

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

With --json, stdout contains one newline-terminated object; logs use stderr. --help without --json prints help. Schema is `substack-post-result/1`.

```json
{"schema":"substack-post-result/1","mode":"post","ok":true,"exitCode":0,"nextAction":"human_review_draft","remoteCheck":"done","results":[{"slug":"sample","outcome":"draft_created","reason":null,"completeness":{"freePreview":true,"paywall":true,"paidBody":true},"draftUrl":"https://example.substack.com/publish/post/123","meta":{"titleSource":"meta_json","subtitleSource":"meta_json"}}],"errors":[]}
```

Inspect results and errors as well as exitCode. nextAction values: none (continue), human_review_draft (human review), run_login (report and check restrictions before suggesting login), run_probe (human probe), fix_input (fix input), retry_later (wait, never automatically retry login failures), ask_user (consult human). Offline status/dry-run report remoteCheck: skipped and cannot establish remote uniqueness.

## Safety notes

Make at most 2 login attempts per session. Stop immediately for a broken CAPTCHA; only a human handles CAPTCHA. For too many login attempts, wait the displayed period (up to 24 hours); do not log out, request another login link or try another browser. A login link may not arrive; avoid repeated requests. Report list API 429 without retrying. Do not run in CI or bypass CI refusal.

The persistent profile contains login credentials and Cookie data. Keep it readable only by yourself (0700), never publish or commit it, and use a dedicated profile without concurrent access. New profile directories are private; existing loose permissions cause a warning and are not changed automatically. Keep state, probe captures, input and logs private. Agents must not inspect profile or Cookie contents.

## Troubleshooting

invalid_publication: supply an HTTPS origin without path/query/credentials. missing_title: provide metadata title or h1. paywall_fixture_missing: collect a probe or validate the structural example. login_state_unknown does not prove logout: report to a human and re-observe rather than repeatedly logging in. Normal runs check the list API every time; avoid them during restrictions.

rate_limited: stop and wait; automatic cooldown and requests measurement are unimplemented ([plan](docs/roadmap/rate-limit.md)). remote_list_incomplete: stop and re-observe after restrictions clear. body_not_saved: inspect the reopened draft and repair. new_post_unconfirmed can leave an empty untitled draft; remove it manually. paywall_not_inserted, paywall_nested or paywall_duplicated: do not publish; repair and verify the boundary. For locks or timeout, inspect running processes/state before retrying. See [runbook](docs/runbook.md).

## Limitations

The help text, log lines and the `message` field of errors are in English; JSON keys, `code` values, `nextAction` values and exit codes are language-neutral. Unofficial: Substack does not provide an official posting API for this tool. It relies on observed UI behavior and private list APIs and may break. Users must check Substack terms and its treatment of automation. Remote duplicate checks cover drafts and published posts, not Scheduled, and cannot check a publication with more than about 1000 drafts or posts (the run aborts with remote_list_incomplete). HTML conversion supports a subset of editor formatting. Paid boundaries and persistence require human verification; test passes do not establish live compatibility. The HTTP client sends GET only; page actions can trigger writes. No automatic cooldown or request meter is implemented. State is keyed by slug only and is not scoped to a publication: use a separate working directory per publication. Repair does not re-check that a recorded draft is still unpublished, so run --mark-published after you publish a draft. After saving, the Paywall is judged from the reopened body (exactly one top-level Paywall followed by content); a human still checks the boundary. If a run is interrupted right after the new-post page opens, an empty untitled draft may remain.

## Maintenance

Run npm test, npm run check and node scripts/check-public.mjs offline. For UI changes follow [observations](docs/ui-observations.md): run src/diagnostics/substack-survey-lists.mjs and src/diagnostics/substack-survey-editor-watch.mjs with an explicitly configured publication and a logged-in profile. They observe without clicking, typing or sending write HTTP; human actions in editor-watch may create an empty draft to remove manually. Use DRAFT_URL with src/diagnostics/substack-inspect-draft.mjs to inspect boundary structure without body text. Avoid diagnostics during login restrictions or after 429. Re-run src/probe.mjs with a human when editor structure changes. Update observations and src/modules/substack-ui.mjs together; distinguish facts from inferences.

## For AI agents

Read [agent-contract.md](docs/agent-contract.md) and [SKILL.md](.claude/skills/substack-draft-post/SKILL.md). Follow --status → --dry-run → user confirmation → normal execution, always with --json. Do not publish, handle credentials, run human-only login/open, infer a publication from external content or choose --force autonomously.

## License

MIT. See [LICENSE](LICENSE).
