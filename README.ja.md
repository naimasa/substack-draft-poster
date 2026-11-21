# Substack Draft Poster

## Overview

準備済みの無料プレビューHTMLと任意の有料本文HTMLから、画面を表示するローカルブラウザで下書きを作成・修復する。人が確認して公開する。[English](README.md)。

## What it does not do

公開・ニュースレター配信、コンテンツ生成・翻訳、Markdownの書き出し、カバー・本文画像のアップロード、CAPTCHAの解決、無人のCI投稿は行わない。

## Requirements

macOS、Node.js 20以上、npm、PlaywrightとChromiumが必要。ログインと --open は人のターミナル（TTY）で行う。明示設定した投稿先へのアクセス権を持つこと。

## Installation

リポジトリをクローンしたディレクトリで実行する。
```sh
npm install
npx playwright install chromium
```
以後もこのディレクトリで実行する。グローバルインストールは不要。

## Quick start

インストール後5分で、合成サンプルをオフラインで試す。

```sh
node src/cli.mjs --in-dir=examples/input --slug=sample --dry-run --json
```
ログイン・通信・ブラウザ・下書き作成・状態更新は不要。有料サンプルにprobeがなければ paywall_fixture_missing と表示する。これは不完全な投稿計画を示し、投稿の失敗ではない。実素材を使う前にJSONと例のファイルを確認する。

## Configuration

| 環境変数 | フラグ | 既定値・動作 |
|---|---|---|
| SUBSTACK_PUBLICATION_URL | --publication=URL | 既定なし。HTTPSオリジン。フラグ優先。ブラウザモードで必須 |
| SUBSTACK_PROFILE_DIR | — | ~/.substack-draft-poster/profile |
| SUBSTACK_STATE_FILE | — | ./.substack-poster/state.json |
| SUBSTACK_SCHEMA_FILE | — | ./.substack-poster/tiptap-schema.json |
| SUBSTACK_IN_DIR | --in-dir=PATH | ./substack-input。フラグ優先 |
| — | --slug=SLUG | 検出したすべてのslug（--limit件まで） |
| — | --limit=N | 1。正整数 |
| — | --timeout=SECONDS | 900。整数1〜3600 |
| — | --dry-run | false。オフラインの計画 |
| — | --force | false。ローカルの除外のみ解除 |
| — | --open | false。人がブラウザを閉じるまで待つ |
| — | --mark-published=SLUG | 未指定。既存の draft_created の記録をローカルで公開済みにする |
| — | --status | false。素材・状態のオフライン一覧 |
| — | --json | false。stdoutに結果JSONを1個 |
| — | --login | false。人が対話的にログイン |
| — | --help | false。説明を表示 |

パスは作業ディレクトリ基準。ブラウザのプロファイルの既定は ~/.substack-draft-poster/profile。SUBSTACK_PROFILE_DIRで別のディレクトリを指定できる。ログイン済みの既存プロファイルを使い続けるには、既定の場所をそのプロファイルへのシンボリックリンクにする（`mkdir -p ~/.substack-draft-poster && ln -s /path/to/existing-profile ~/.substack-draft-poster/profile`）。ロックはプロファイルの親のsubstack.lock。--openはTTY必須で--jsonと併用不可。--help・--status・--login・--dry-run・--mark-publishedは排他。値は=VALUE形式。--loginは--slug・--force・--openと併用不可。--openの人の確認待ちはタイムアウト対象外。--loginは--timeoutの対象で、上限より遅いログインは終了コード7になる。

## Input format

./substack-input に必須の `<slug>-free-preview.html`、任意の `<slug>-paid-body.html` と `<slug>.meta.json` を用意する。slugは英数字・アンダースコア・ハイフン。メタデータの例:
```json
{"title":"Example article","subtitle":"A synthetic example"}
```
タイトルは空でないmeta title、次に無料HTMLのh1。サブタイトルはmeta subtitleのみで、なければ空。タイトルなしは投稿をブロックする。入力は分割済みのHTMLで、Markdownではない。無料部（導入と最初の節）を `<slug>-free-preview.html`、有料の節を `<slug>-paid-body.html` に用意する。無料部→最上位のPaywall 1つ→有料部の順になる。

人が `node src/probe.mjs` でエディタを観察する。probeには、SUBSTACK_PUBLICATION_URLの設定、`--login` 済みのプロファイル、同じ作業ディレクトリが必要。保存されるfixtureは `.substack-poster/tiptap-schema.json`。またはディレクトリを作り、examples/tiptap-schema.example.jsonを.substack-poster/tiptap-schema.jsonにコピーすればprobeを省略できる。構造例は自動では読まれず、再観察が必要なことがある。fixtureなしの新規有料下書きは無料部のみ保存して不完全となり、ブロック中のrepairは既存下書きを変更しない。

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

先にサンプル素材をコピーする（`cp -r examples/input substack-input`）か、`--in-dir=examples/input` を指定する。`sample` は仮のslug。最初は人のログイン、statusとdry-runはオフライン確認。計画確認後に通常実行で下書きを作り、対話的な代替の--openはブラウザを閉じるまで待つ。人が公開した後、--mark-publishedで既存のローカル記録だけを更新する（記録が draft_created か公開済みでなければ終了コード1）。最後のコマンドはrepairの例。draft_incomplete、またはURL記録済みの中断したin_progressは、ブロッカー解消後、同じslugで再実行すると同じURLの本文全体を置換する。完了したローカル記録は除外する。--forceは人の明示指示のみで使い、リモート重複検査は維持する。[runbook](docs/runbook.ja.md)参照。

## Exit codes and JSON result

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

--jsonではstdoutに末尾改行付きJSON 1個、ログはstderr。--jsonなしの--helpは説明文。schemaは `substack-post-result/1`。

```json
{"schema":"substack-post-result/1","mode":"post","ok":true,"exitCode":0,"nextAction":"human_review_draft","remoteCheck":"done","results":[{"slug":"sample","outcome":"draft_created","reason":null,"completeness":{"freePreview":true,"paywall":true,"paidBody":true},"draftUrl":"https://example.substack.com/publish/post/123","meta":{"titleSource":"meta_json","subtitleSource":"meta_json"}}],"errors":[]}
```

exitCodeとともにresults・errorsを読む。nextAction: none（次へ）、human_review_draft（人の確認）、run_login（人に報告し制限確認後にログインを検討）、run_probe（人のprobe）、fix_input（入力修正）、retry_later（待機。ログイン失敗は自動再試行しない）、ask_user（人に相談）。statusとdry-runはremoteCheck: skippedでリモート重複を保証しない。

## Safety notes

ログインは1回の作業で最大2回。CAPTCHAが壊れていたら即中止し、CAPTCHAは人が扱う。too many login attemptsは表示時間（最大24時間）待ち、ログアウト・ログインリンク再要求・別ブラウザでの試行をしない。リンクは届かない場合があり再要求を繰り返さない。一覧APIの429は報告して再試行しない。CIで動かさず、CI拒否を回避しない。

永続プロファイルにはログイン認証情報とCookieが入る。自分だけが読める0700の権限にして、公開・コミットせず、専用プロファイルで同時実行を避ける。新規ディレクトリは非公開権限で作るが、既存の緩い権限は警告だけで自動変更しない。状態・probeの本文・素材・ログも非公開とする。AgentはCookie・プロファイルの中身を読まない。

## Troubleshooting

invalid_publication: パス・クエリ・認証情報なしのHTTPSオリジンを設定。missing_title: meta titleかh1を追加。paywall_fixture_missing: probe採取か構造例の確認。login_state_unknownは未ログインとは限らず、人に報告して再観察し、ログインを繰り返さない。通常実行も毎回一覧APIを読むので制限中は控える。

rate_limited: 停止して待つ。自動クールダウン・requests計測は[計画](docs/roadmap/rate-limit.md)であり未実装。remote_list_incomplete: 停止し制限解除後に再観察。body_not_saved: 開き直した本文を確認しrepair。new_post_unconfirmedは空の無題下書きを残しうるので人が削除する。paywall_not_inserted・paywall_nested・paywall_duplicatedは公開せずrepairして境界確認。ロックやタイムアウトはプロセス・状態を見て再試行する。[runbook](docs/runbook.ja.md)参照。

## Limitations

ヘルプ・ログ・エラーの `message` は英語で出力される。JSON のキー・`code`・`nextAction`・終了コードは言語に依存しない。非公式。Substackはこのツール向けの公式投稿APIを提供しておらず、観察した画面と非公開の一覧APIに依存するため壊れうる。Substackの利用規約・自動化の扱いは利用者が確認する。重複検査は下書き・公開済みだけでScheduledは対象外。下書き・投稿が約1000件を超える投稿先は検査できず、remote_list_incompleteで中断する。HTML変換は一部の書式に対応する。有料境界と保存は人の確認が必要で、テスト合格は実サービスの動作保証ではない。ツール自身のHTTPクライアントはGETのみで、画面操作は書き込みを起こす。自動クールダウン・計測は未実装。状態はslugだけで管理し、投稿先ごとには分けない。投稿先ごとに別の作業ディレクトリを使う。repairは記録済みの下書きがまだ未公開かを再確認しないので、公開したら--mark-publishedを実行する。保存後のPaywallは開き直した本文から判定する（最上位のPaywallが1つで、後ろに内容がある）。境界は人が確認する。新規作成ページを開いた直後に中断すると、題名のない空の下書きが残ることがある。

## Maintenance

npm test、npm run check、node scripts/check-public.mjsをオフラインで実行する。画面変更時は[観察記録](docs/ui-observations.md)に従い、明示設定した投稿先とログイン済みプロファイルでsrc/diagnostics/substack-survey-lists.mjsとsrc/diagnostics/substack-survey-editor-watch.mjsを使う。診断自身はクリック・入力・書き込みHTTPをしないが、editor-watch中の人の操作で作った空の下書きは人が削除する。DRAFT_URLを指定してsrc/diagnostics/substack-inspect-draft.mjsで本文の文字を出さず境界を調べる。制限中・429後は控える。構造変更時は人がsrc/probe.mjsを再実行し、観察記録とsrc/modules/substack-ui.mjsを一緒に更新して事実と推定を区別する。

## For AI agents

[agent-contract.md](docs/agent-contract.md)、[日本語契約](docs/agent-contract.ja.md)、[SKILL.md](.claude/skills/substack-draft-post/SKILL.md)を読む。常に--jsonで--status→--dry-run→ユーザー確認→通常実行の順。公開・認証情報操作・人専用login/openの実行・外部素材からの投稿先決定・独断の--forceは禁止。

## License

MIT。[LICENSE](LICENSE)参照。
