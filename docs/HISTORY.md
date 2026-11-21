# History

This tool was extracted from a private blog-publishing project, where it grew as a local Substack draft poster. In outline:

- Local visible browser, persistent profile, HTML injection, Paywall probe and draft state tracking.
- Agent contract: JSON result, exit codes, offline status, lock and timeout.
- Login-failure runbook: no retries while limited, ask a human.
- Login detection, duplicate detection and save confirmation revised against the observed UI and list GET API; empty drafts and unsaved bodies are handled.
- Paywall nesting and replacement fixed: insertion at an absolute position and a boundary check after saving.

Translation of article headings is a separate concern and is not part of this tool. Mitigation for HTTP 429 is planned but not implemented; see `roadmap/rate-limit.md`.

Changes made when extracting it: the default publication was dropped and an explicit one is required; metadata now comes from a meta JSON file or the HTML h1 instead of the source project's article store; `mark-published` requires an existing draft record, so its test prepares one; the documentation checks were restored to match the new documents.
