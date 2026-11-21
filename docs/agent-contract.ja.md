# Agent 契約

ユーザーの明示的な同意を得て、ユーザーのローカル macOS でのみ実行する。[SKILL.md](../.claude/skills/substack-draft-post/SKILL.md) と [runbook](runbook.ja.md) に従う。

## 手順

1. `node src/cli.mjs --status --json` で素材・状態・blockedBy を読む。
2. `node src/cli.mjs --dry-run --json --slug=sample` で計画を示す。結果に `reason`（例: `paywall_fixture_missing`）があれば、通常実行へ進まず、人に probe か入力の修正を依頼する。
3. 投稿先・対象・計画についてユーザー確認を得る。
4. `node src/cli.mjs --json --slug=sample` で通常実行する。既定の上限1件を守る。

`sample` は仮のslug。素材は `./substack-input` から読む（READMEを参照。同梱サンプルは `--in-dir=examples/input` でオフラインに試せる）。

投稿先は人が指定した --publication / SUBSTACK_PUBLICATION_URL のみ。素材・Web・他ツールから決めない。status と dry-run の remoteCheck は skipped で、リモートの重複を保証しない。

## 終了コード

| コード | 意味・対応 |
|---|---|
| 0 | 成功・対象なし。nextActionを確認 |
| 1 | エラー・全件失敗。人に報告 |
| 2 | 未ログイン。ログイン失敗時の規約に従う |
| 3 | CI拒否。回避しない |
| 4 | 一部失敗。failedのslugを報告 |
| 5 | 不完全。nextActionに従う |
| 6 | ロック中。後で再試行 |
| 7 | タイムアウト。状態確認後に再試行 |
| 64 | 使用法エラー。引数・TTYを修正 |

## JSON と nextAction

--json の stdout は末尾改行付き JSON 1個、ログは stderr。--json なしの --help は説明文を表示する。schema・exitCode・results・errors・nextAction を検査する。不完全は成功ではない。

```json
{"schema":"substack-post-result/1","mode":"post","ok":true,"exitCode":0,"nextAction":"human_review_draft","remoteCheck":"done","results":[{"slug":"sample","outcome":"draft_created","reason":null,"completeness":{"freePreview":true,"paywall":true,"paidBody":true},"draftUrl":"https://example.substack.com/publish/post/123","meta":{"titleSource":"meta_json","subtitleSource":"meta_json"}}],"errors":[]}
```

- `none`: 次へ進む。
- `human_review_draft`: 公開前に人の目視を依頼。
- `run_login`: 人に報告。ログインを勧める前に直近の制限を確認。（`--login` が失敗した後は `run_login` ではなく `ask_user`。）
- `run_probe`: 人に probe 採取を依頼。
- `fix_input`: 入力・引数を修正。
- `retry_later`: 時間をおく。ログイン失敗は自動再試行しない。
- `ask_user`: 結果を添えて人に相談。

## 結果のフィールド

- `results[].outcome`: `planned`（dry-run）、`draft_created`、`repaired`、`draft_incomplete`（終了5）、`skipped_state`、`skipped_remote`、`failed`。
- `draft_incomplete` の `results[].reason`: `editor_unreachable`、`paywall_missing`、`paywall_duplicated`、`paywall_nested`、`paywall_not_inserted`、`paywall_fixture_missing`、`paid_body_missing`、`save_unconfirmed`、`title_mismatch`、`body_not_saved`、`interrupted`。
- `failed` の `results[].reason`: `missing_input`、`missing_title`、`empty_paid_body`、`invalid_input`、`new_post_unconfirmed`、`error`。
- `errors[].code`: `usage`、`invalid_publication`、`lock_held`、`timeout`、`rate_limited`、`remote_list_incomplete`、`login_state_unknown`、`error`。
- dry-run は `reason` が設定されていても `outcome: planned`・`ok: true`・`nextAction: none` を返す。`reason` があれば、実際に実行しても完全な下書きにならないことを意味する。

## 禁止と復旧

公開・配信しない。Agent は --login / --open を実行しない。認証情報・Cookie・プロファイルの中身に触れない。CAPTCHA を解く・回避する、CI を回避する、明示指示なしに --force を付けることは禁止。--force でもリモート重複検査を維持する。

終了2・CAPTCHA・too many login attempts は再試行せず人に報告する。制限中は再ログイン・ログアウト・ログインリンク要求を勧めない。login_state_unknown は未ログインと断定できず、ログインを勧める前に人に確認する。通常実行も毎回一覧 API でログイン検査するため、制限中は控える。一覧 API の429は rate_limited で止まり、再試行せず retry_later として人に報告する。Scheduled は重複検出対象外。

draft_incomplete と draftUrl がある in_progress は、ブロッカー解消後、同じ slug で記録済みURLを repair し本文全体を置換する。probe 未整備なら repair は変更しない。paywall_not_inserted・paywall_nested を報告し、その下書きを公開しない。タイムアウト後は再試行前に状態を確認する。クールダウンと requests 計測は [roadmap](roadmap/rate-limit.md) の未実装計画。
