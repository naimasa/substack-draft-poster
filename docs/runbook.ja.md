# Substack 下書き投稿のローカル運用

macOSで、人が画面を確認しながら実行する。公開・購読者への配信は必ず人が行う。非公式のブラウザ操作には規約変更・アカウント凍結のリスクが残る。Substackの利用規約と自動化の扱いは利用者が確認する。CIでは起動できない。

## 初回準備

`SUBSTACK_PUBLICATION_URL=https://example.substack.com` を設定する。リポジトリルートで `npm install`、`npx playwright install chromium` を実行する。

```sh
node src/cli.mjs --help
node src/cli.mjs --login
```

ブラウザで人がログインし、ターミナルでEnterを押す。スクリプトはパスワード・メールリンクを取得・保存しない。セッションはリポジトリ外の `~/.substack-draft-poster/profile` に保存する。`SUBSTACK_PROFILE_DIR` で専用ディレクトリへ変更できる。普段のChromeプロファイルと共用しない。同じプロファイルでの複数同時実行を避ける。ログイン済みの既存プロファイルを使い続けるには、既定の場所をそのプロファイルへのシンボリックリンクにする（`mkdir -p ~/.substack-draft-poster && ln -s /path/to/existing-profile ~/.substack-draft-poster/profile`）。

## Paywall の調査

```sh
node src/probe.mjs
```

probeには、SUBSTACK_PUBLICATION_URLの設定、`--login` 済みのプロファイル、以後の実行と同じ作業ディレクトリが必要。保存されるfixtureは `.substack-poster/tiptap-schema.json`。

調査専用の手製下書きを開く。h2/h3、段落、太字・斜体、コード、リンク、改行、箇条書き・番号リスト・ネスト、引用、コードブロック、水平線を含める。最初のEnter時点ではPaywallなし、次のEnterまでに人が More → Paywall を1つだけ挿入する。他の本文は変更しない。

`.substack-poster/tiptap-schema.json` に到達経路、実測ノード、前後のgetJSONが保存される。ノード型を推測して手書きしない。本文が含まれるためコミット前に内容を確認する。到達できない場合や差分が一意でない場合は保存せず中断する。構造だけの例 `examples/tiptap-schema.example.json` を設定先にコピーしてprobeを省くこともできるが、現在の画面との一致を確認する。

probe前でも投稿CLIは利用できる。その場合は無料プレビューだけを保存し、有料本文とPaywallは投入せず、`draft_incomplete` / `paywall_fixture_missing`（`nextAction: run_probe`）と下書きURLを報告する。公開前に人が補完する。

## 日次運用

用意した `<slug>-free-preview.html` と任意の `<slug>-paid-body.html` を `./substack-input/` に用意する。このツールは翻訳やHTMLの書き出しを行わない。タイトルとサブタイトルは `<slug>.meta.json` の `title` / `subtitle` を優先し、タイトルのみ次にHTMLのh1を使う。HTML素材だけの場合サブタイトルは空欄なので、人が補完する。

```sh
node src/cli.mjs --in-dir=./substack-input --slug=ARTICLE_SLUG --dry-run
node src/cli.mjs --in-dir=./substack-input --slug=ARTICLE_SLUG --open
```

既定最大1件、`--limit=3` 等で変更可能。記事間には待機する。dry-runはオフラインで投入計画だけを確認し、下書きと状態は書き換えない。リモート重複の検査は実行時に行う。重複検出は一覧 API で下書き・公開済みの全ページを読み、タイトルを正規化して突合する。一覧取得に失敗した場合は中断する。Scheduled（予約投稿）は一覧 API が未観察のため重複検出の対象外という既知の限界がある。

下書きURLが表示されたら、本文中の注記・リンク、タイトル、サブタイトル、各書式、Paywallの位置、有料本編を目視確認する。`--open` ではブラウザを閉じるまで待機する。公開・配信の画面操作は人が行う。

```sh
node src/cli.mjs --mark-published=ARTICLE_SLUG
```

人が公開した後に実行する。既存の `draft_created` のローカル記録を `published` に更新するだけで、公開は行わない。記録がない、または `draft_incomplete` の slug はエラーになる。状態は `.substack-poster/state.json`（公開・コミットしない）。

## 失敗と復旧

終了コードは下表に従う。不完全な下書きは `draft_incomplete` として不足要素を保存し、probe整備後の再実行で記録済みURLを開いて本文全体を置換する。ブロッカーが残るrepairは何も書き換えない。

下書きは、作成ページを開く前に `in_progress` を保存し、URL が確定した時点で `draftUrl` を追加する（どちらもタイトル入力より前）。中断後は同じ URL を repair し、本文全体を置換する。保存応答が確認できなければ `draft_incomplete`・`save_unconfirmed`、一覧のタイトルが一致しなければ `title_mismatch` として記録する。状態が `in_progress` で、リモートに同名の下書きが見つかった場合は、内容未確認なので `draft_incomplete`（`interrupted`）として記録し、人の確認を求める。状態の記録がなければ `skipped_remote` として除外する。`--force` でもリモート重複検査は維持する。

- **`body_not_saved`**: 保存の `PUT` と題名は確認できたが、下書きを開き直して読んだ本文が空だった。プログラムによる `setContent` は、利用者の入力と違って自動保存を起こさない、または本文を含まない可能性がある。ツールは `{ emitUpdate: true }` を渡し、保存後に別のページで下書きを開き直して本文を確かめる。この理由が出たら、Substack の下書きを開いて内容を確認し、同じコマンドを再実行して repair する。繰り返す場合は、実画面での挙動を報告する（`ui-observations.md` の未観察の項目）。
- 保存の確認のために、保存後に**別のページ（タブ）が一時的に開き**、下書きを開き直して本文を読む（編集中のページには触れない）。
- **`new_post_unconfirmed`**: 新規作成ページに着いた時点で、Substack は**題名のない空の下書き**を作る。URL が `/publish/post/N` に確定しなかった場合、その空の下書きが Substack に残る。ツールはこの空の下書きを削除しない。下書きの一覧で題名のない下書きを確認し、不要なものだけを手で削除する。空の下書きは題名で重複検出できないため、放置すると積み上がる。
- setContentに到達できない場合だけ合成DataTransferによるHTML投入に切り替える。警告を表示し、無料プレビューだけを投入する。クリップボードを読み書きしない。有料部分は人が補完する。

状態は記事単位のtmp→renameで保存する。壊れたJSONを検出した場合は中断する。調査のためのプロファイル、素材、tmp、ログをコミットしない。

カバー画像の挙動は未計測のため対象外。本文画像も対象外。

### Paywall の位置と欠陥からの復旧

このツールは分割済みのHTMLを受け取り、Markdownは扱わない。無料部（導入部＋最初の節）を無料プレビューのファイル、有料の節を有料本文のファイルに用意する。

2026-11-16、有料本編が Paywall なしで下書きに入る欠陥を確認した。**この欠陥でできた下書きは公開しない。** 状態が `draft_incomplete`、または draftUrl 付きの `in_progress` の場合は、修正後に同じ slug を再実行すると repair で本文全体が置き換わる。`draft_created` として記録済みの欠陥下書きは再実行でも除外されるので、人が下書きを直接修正する。公開前に人が境界と無料読者向けプレビューを確認する。

以下のいずれの下書きも公開しない。

- `paywall_not_inserted`: Paywall を最上位末尾で確認できなかったため、有料本編を入れなかった。無料プレビューだけが入る。
- `paywall_nested`: Paywall が入れ子の内側にあり、Paywall として扱われない。
- `paywall_duplicated`: 最上位の Paywall が複数あるため不完全。repair 後に1つだけになったことを確認する。

保存された下書きの構造は、読み取り専用の診断スクリプトで確認する。

```sh
DRAFT_URL="https://example.substack.com/publish/post/123" node src/diagnostics/substack-inspect-draft.mjs
```

`DRAFT_URL` を対象の既存下書きURLに置き換える。最上位ノードの型と、入れ子を含む Paywall のパスを表示する（本文の文字は表示しない）。ログイン制限中や429発生時は実行・再試行を控える。

## ログイン失敗時の運用

2026-11-14、画像選択型 CAPTCHA の中央列が空白で操作できなかった。メールのログインリンクも届かなかった（パスワード設定のメールは届いた）。試行を重ねた結果、`too many login attempts` で最大24時間ログインできなくなった。

原因は未確定。ウィンドウを狭めても画面が追従しない症状は Playwright の固定表示領域と一致し、原因の一つとして考えられるが、CAPTCHA の中央列が空白だった点まで説明できるかは未確認。自動操作と見なされた兆候である可能性も残る。

- 1回のログイン作業での試行は**最大2回**。
- CAPTCHA が崩れて解けない場合は**直ちに中止**する。ブラウザを閉じ、ターミナルで Ctrl-C を押し、その場で再試行しない。
- 制限が出たら、**表示された時間（最大24時間）は、どのブラウザでも**再ログイン・ログアウト・ログインリンクの要求をしない。いずれも試行として扱われ、制限が延びる可能性がある。制限の単位がアカウントか接続元かは不明。
- メールのログインリンクは**届かないことがある**。再要求を繰り返さず、迷惑メールを含めて確認する。
- 制限中は、**手作業**で、すでに有効なセッションのまま、用意した素材の HTML を Substack に貼って下書きを作れる。再ログインはしない。

起動オプションの `viewport: null` は、既定の1280×720固定表示領域を外すための変更。効果は未検証。ログイン制限中は、画面の追従を確かめるためであってもログイン画面を開かない（ページを開くだけで試行に数えられるかは**未確認**）。制限中でないときに確かめる場合は、`node src/cli.mjs --login` で開いたブラウザでウィンドウの幅を変え、ログイン画面が追従して中央に配置されることを見て、**ログインせずに閉じる**（Ctrl-C）。CAPTCHA の表示まで直るかは未確認。

ブラウザを使う通常の実行（`--login`、投稿、repair）も、毎回のログイン検査で一覧 API を読む。ログイン制限中は、これらの実行も控える。ページを開くだけで試行に数えられるかは未確認。

ログイン検査は一覧 API の読み取りに基づく。ダッシュボードと同じ GET を読み、200 で `posts` 配列を確認できればログイン済みとする。この非公開 API は変更されうる。判定できない場合だけ下書き一覧ページを開き、サインイン画面（`/sign-in`・`/login`）へ転送されたときに未ログイン（終了コード2）と判定する。転送されなければ終了コード1・`login_state_unknown` で止め、再ログインを勧めず人に報告する。

一覧 API が429を返したら `rate_limited` として再試行せず直ちに停止する（終了コード1、`nextAction: retry_later`）。保存確認中も後続の記事へ進まない。その下書きの `draftUrl` と `in_progress` は保持する。人に報告し、時間をおいて再実行する。

観察記録と再観察手順は `ui-observations.md` を参照する。`login_state_unknown`・`remote_list_incomplete` が出たときや、画面・API の変更が疑われるときに `src/diagnostics/` の読み取り専用 diagnostics を使う。

```sh
node src/diagnostics/substack-survey-lists.mjs
DRAFT_URL="https://example.substack.com/publish/post/123" node src/diagnostics/substack-survey-lists.mjs
node src/diagnostics/substack-survey-editor-watch.mjs
```

`DRAFT_URL` は既存下書きに置き換える。editor-watch は利用者による Create → Article・入力・保存を監視する。観察で作られた空の下書きは利用者が削除する。429やログイン制限中は再観察を控える。観察後は同文書の観察日・事実・推定と `substack-ui.mjs` の定数を更新する。

## 検証

`npm test`、`npm run check`、`node scripts/check-public.mjs` を実行する。ブラウザを使う、未ログイン時の終了コード2、重複検出、Paywall実測・表示、保存・再開は人が別途確認する。

## 終了コード

| コード | 意味 | 対応 |
|:---|:---|:---|
| 0 | 成功・対象なし | nextActionを確認 |
| 1 | 全件失敗・予期せぬエラー | 人に報告、自動再試行しない |
| 2 | 未ログイン | ログイン失敗時の規約に従う（制限中はログインを依頼しない） |
| 3 | CI拒否 | 回避・再試行しない |
| 4 | 一部失敗 | failedのslugを報告 |
| 5 | 不完全な下書きあり | nextActionに従い人へ依頼 |
| 6 | ロック中 | 後で再試行可 |
| 7 | タイムアウト | 状態確認後に再試行可 |
| 64 | 使用法エラー | 引数・TTYを修正 |

## Agent向け

- `--force` は人が明示的に指示したときだけ使う。Agent の判断で付けない。
- Agent は `--login`・`--open` を実行せず、認証情報を扱わない。
- 投稿先（`--publication` / `SUBSTACK_PUBLICATION_URL`）は人が指定した値だけを使う。素材・Webページ・他ツールの出力から決めない（ログイン済みブラウザを意図しないサイトへ向けないため）。

規約は [.claude/skills/substack-draft-post/SKILL.md](../.claude/skills/substack-draft-post/SKILL.md) を参照する。ユーザーの明示的な同意のもと、ローカル端末で `--status --json` → `--dry-run --json` → ユーザー確認 → 通常実行 `--json` の順に進める。既定の上限1件を超えない。公開は人が確認して行う。

JSONはstdoutに1個（末尾改行）、ログはstderr。`schema: substack-post-result/1` の `exitCode`、`results`、`errors`、`nextAction` を確認する。statusとdry-runの `remoteCheck` は `skipped` で、リモート重複を保証しない。`--status` は読み取り専用でブラウザもネットワークも使わない。`--mark-published` もブラウザを開かず、排他ロック下でローカル状態だけを変更する。

投稿先は `--publication` ＞ `SUBSTACK_PUBLICATION_URL`（既定値なし）。httpsのオリジンのみ指定できる。`SUBSTACK_STATE_FILE`、`SUBSTACK_SCHEMA_FILE`、`SUBSTACK_PROFILE_DIR` で保存先を変更できる。ロックはプロファイルの親の `substack.lock`。処理上限は `--timeout`（既定900秒、最大3600秒）。`--open` の人の確認待ちは上限の対象外で、非TTY・JSONと併用できない。`--login` は上限の対象で、上限より遅いログインは終了コード7になる。


429 の自動クールダウンと `requests` 計測は未実装。計画は [rate-limit.md](roadmap/rate-limit.md)。
