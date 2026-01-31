# 詳細要件書（Codex / Claude Code ↔ Slack Turn Bridge）

更新日: 2026-01-27

## 1. 背景・方針（重要）

本当は「Slackのスレッド＝AIセッション」として **Slackで新規スレッドを作ったら新規セッションを開始**したいが、実行環境を一意に決められないため、今回は採用しない。

本プロジェクトのスコープは以下に限定する：

- **AIレスポンス（ターン完了通知）は常に新規スレッド（親メッセージ）で投稿する**
- Slackは **「AIレスポンス完了の通知」＋「その通知に対するレス（次の入力）」** に留める
- Slack上の任意の新規投稿を「新規セッション開始」としては扱わない（対象外）
- Slack受信は **Socket Mode** 前提（Events APIのHTTP公開は行わない）
- Slack App 作成は **From a manifest** を推奨（再現性を優先）
- 返信→`resume` は本パッケージのメイン機能であり、ウィザードで必須設定とする



## 2. 目的
1. Codex CLI と Claude Code CLI の **ターン完了**を検知し、Slackへ通知する  
2. 通知スレッドへの返信を、該当CLIセッションへの **次のユーザーメッセージ**として `resume` 実行する  
3. `resume` 実行の次のターン完了も、再びSlackへ通知する  




## 3. スコープ

### 3.1 対象

- **Codex CLI**
  - `notify` によりターン完了イベント（現状 `agent-turn-complete`）をフックし、外部コマンドを実行できること
- **Claude Code CLI**
  - `Stop` hook（ターン完了相当）で外部コマンドを実行できること
- **Slack**
  - Turn完了通知の投稿（新規親メッセージ）
  - 返信の受信（DM内スレッド返信）
  - 返信に対する運用注意返信（短文）
- **コマンド体系**
- `slacklocalvibe notify`：通知投稿（Codex/Claude hookから `slacklocalvibe` で起動）
  - `slacklocalvibe daemon`：Socket Modeで返信受信し、`resume` 実行（npm（グローバル導入）で常駐/手動起動）

### 3.1.1 ウィザードの既定値（必須）

- **既存設定ファイルが見つかったCLIはデフォルトON**（ユーザーが最終確定）
  - Codex: `~/.codex/config.toml`（または `CODEX_HOME/config.toml`）
  - Claude: `~/.claude/settings.json`
- 本番同等テストは **確定したCLI設定に従い、テストプロンプトを新規送信**する
  - hooks経由でSlack通知が届くことを確認し、そのスレッド返信で `resume` を実行する
- **`slacklocalvibe daemon` はウィザードがバックグラウンド起動する**（失敗時は手動で起動）

### 3.1.2 テスト用プロンプト（固定）

「【SlackLocalVibe 本番同等テスト】このメッセージはテスト実行です。」と言ってください

### 3.1.3 テスト実行コマンド（固定）

- Codex: `codex exec "「【SlackLocalVibe 本番同等テスト】このメッセージはテスト実行です。」と言ってください"`
- Claude: `claude -p "「【SlackLocalVibe 本番同等テスト】このメッセージはテスト実行です。」と言ってください"`

### 3.2 非対象（Non-goals）

- Slack新規投稿から **新規セッション開始**（ディレクトリ決定問題のため採用しない）
- Slackスレッド内で完了通知を積み増し（常に新規スレッド）
- Slackチャンネルの通知/受信（DMのみ対象）
- 永続DB（RDB/Redis/SQLite）を前提にした設計（DBは持たない）
- “fork”戦略（分岐）— **resumeのみ**を採用
- 競合（同時実行・順序逆転・重複実行）の**完全防止**（運用注意は必須。競合対策はCLI側に任せ、本パッケージでは実装しない）
- 二重resumeの抑止・排除は**本パッケージでは実装しない**（CLI側で解決）
- Slack Events の再送による重複対策も**CLI側で解決**し、本パッケージでは重複排除を実装しない
- 多重実行の完治（exactly-once保証）は**行わない**（CLI側の責務）
- Events API（HTTP受信のRequest URL公開）を前提にした運用



## 4. 用語
- **ターン**：ユーザー入力→モデル応答→待機に戻るまでの1サイクル
- **セッションID**
  - Codex: `thread-id` 相当
  - Claude Code: `session_id`
- **通知スレッド**：ターン完了通知の親メッセージを起点とするSlackスレッド
- **対象スレッド**：Bridgeが作成した通知スレッド  
  - 対象外スレッドは `resume` しない（ただし固定文言で説明は返す）




## 5. 機能要件（FR）

### FR-1 ターン完了通知（共通）

- ターン完了ごとに、ウィザードで指定したDM送信先へ **必ず新規親メッセージ**として投稿する（新規スレッド開始）
  - DM：あなた（人間ユーザー）↔ Bot のDM（DMの相手はユーザーID `U...` を1つ）  
    - 送信は `conversations.open(users=<U...>)` で DM チャンネルID（`D...`）を取得し、`chat.postMessage(channel=<D...>)` で行う（`channel=U...` 直指定は使用しない）
- 親メッセージ本文は**当初のユーザーメッセージ**を投稿する
- tool種別 / セッションID / ターンID（取得できる場合）は **ローカルの route ストア**に必ず保存する
- AI応答本文は**必ずスレッド返信に投稿**する（FR-6）
- 親メッセージ送信時に **ルーティング情報をローカル保存**する（FR-4のため、DR-1参照）
- 送信者は常にBot（OAuth Tokensで投稿する）
- 送信先は必須。未設定はエラーとして扱う
- **全体成功/失敗はログに必ず記録**する
- **エラー時は Slack に「ログの場所:」を必ず投稿**する  
  - ただし **ユーザーメッセージ抽出失敗は通知せずログのみ**とする

### FR-2 ターン完了通知（Codex）

- Codex CLIの `notify` から提供されるイベントJSONを受け取り、`agent-turn-complete` をターン完了として扱う
- notify は **JSON文字列を1引数としてコマンド末尾に付与**して実行される（例：`python3 script.py <JSON>`）
  - `notify = ["slacklocalvibe", "notify", "--tool", "codex"]` の場合は JSON が**最後の引数**になるため、slacklocalvibe は末尾引数を JSON として読む
- JSONの主なキー（公式例）：`type`, `thread-id`, `turn-id`, `cwd`, `input-messages`, `last-assistant-message`
- セッションIDは `thread-id`、`turn-id` / `last-assistant-message` / `input-messages` は取得できる場合に使用する
- 親メッセージ本文（当初ユーザーメッセージ）は **Codex の rollout JSONL（`~/.codex/sessions/**/rollout-*.jsonl`）の `event_msg` → `user_message` を正として抽出**する
  - `thread-id` に対応するファイル（ファイル名 or 内容一致）を探し、**最新の user_message** を採用する
  - `input-messages` は **デバッグ用メタ**としてのみ保持する（本文抽出には使わない）
- ただし **タイトル生成テンプレート文言に一致する場合は SKIP**（内部タスク除外）
- rollout が見つからない／抽出できない場合は **`notify.user_text_missing` をエラーとして記録し、Slack通知は行わない**
- `cwd` が取得できる場合は route ストアに保存し、`resume` の実行ディレクトリとして使用する
  - 抽出できない場合は親本文に固定のエラーメッセージを入れて通知を続行する（空欄にしない）

### FR-3 ターン完了通知（Claude Code）

- Claude Codeの `Stop` hook をターン完了相当として扱う
- hook入力（stdinのJSON）から `session_id` を取得する
- hook入力の主なキー（公式例）：`session_id`, `transcript_path`, `hook_event_name`, `stop_hook_active`, `permission_mode`, `cwd`
- 応答本文は原則 `transcript_path` から抽出する（`transcript_path` は JSONL 形式のセッション全履歴ファイル）
- スキーマは固定保証されないため、抽出できない場合は「本文抽出エラー」で通知し、理由を明記する
- `stop_hook_active == true` の場合は無限ループ防止のため通知を行わない
- 親メッセージ本文（当初ユーザーメッセージ）は `transcript_path` から **直近の user role** を抽出して使用する
  - 抽出できない場合は親本文に固定のエラーメッセージを入れて通知を続行する（空欄にしない）

### FR-4 Slack返信 → 次のユーザーメッセージとして resume 実行

- Bridgeが作成した通知スレッドに返信があった場合のみ、次を実施する：
  1. ローカルの route ストアから `tool`, `session_id` を復元（DR-1）
  2. **受領メッセージを先に送信**する（FR-5）
  3. 返信本文（`text` のみ。blocks/attachments/filesは無視）をプロンプトとして `resume` を実行
- **Claude へのプロンプト正規化**：
  - 改行（CRLF/CR/LF）を **`\n`（文字列）に変換**して **1引数で渡す**
  - 文字列化で長さが増えることは許容し、**切り捨てはしない**
  - 引数長制限で失敗した場合は **エラーとして明示**しログに残す（フォールバックなし）
- 返信本文が空（空文字/空白のみ）の場合は**最優先で無視**する（`resume` も返信も行わない）
- 空返信は対象外判定の固定文言返信も行わない（親取得もしない）
- Bridgeが作成していないスレッドへの返信は `resume` を実行しない  
  - ただし **route 情報が見つからない**場合は、スレッドに固定文言を返信して説明する（設計書の固定文言に従う）
- `message_changed` / `message_deleted` などの **subtype付きイベントは対象外**（resumeしない）

### FR-5 返信スレッドへの受領/注意書き返信（必須）

- Slack返信を受けたら、**`resume` 実行前に**同スレッドへ短文で返信する：
  - 「受領した／実行を開始した」旨
  - **重要注意**：「家に戻ってCLIで継続する場合は、今動いている対話CLIを一度終了し、改めて `resume` で入り直す必要がある」旨（強く明記）
- `resume` が失敗した場合も、**受領メッセージは送った上で**失敗文言を返信する（設計書の固定文言に従う）

### FR-6 Slack文字数制限への対応（スレッド分割で切り捨てない）

- Slack制限を踏まえ、長文は **スレッド返信へ分割投稿**して切り捨てをしない：
  - 親メッセージ：当初ユーザーメッセージを投稿
  - ユーザーメッセージが長い場合は、`MAX_TEXT = 3800` を上限に分割し、**続きは同スレッドに投稿（AI応答の前）**
  - AI応答本文：親メッセージのスレッドに、`MAX_TEXT = 3800`（安全マージン）を上限として複数メッセージに分割して投稿する
  - 分割投稿は順序を保つ（例：`(1/3) ...` のような番号付けは可）
  - 分割で整形が崩れることは許容（本文の欠落回避を優先）
  - Slackは本文が 40,000 文字を超えると切り捨てられる。以前は 4,000 bytes 程度を推奨としていたため安全マージンとして `MAX_TEXT=3800` を採用する

### FR-7 DBなし

- 永続DBを用いず、必要な状態はローカルの `routes.jsonl` に保存して復元する



## 6. データ要件（DR）
### DR-1 ローカル route ストアによるルーティング情報（必須）
- 通知（親）メッセージ送信時に **route 情報をローカルへ保存**する
- 返信→resume時の復元は **ローカル route ストアのみ**を正とする（本文解析による復元は行わない）
- route ストアの型は設計書にて定義する（`04-design.md` の型定義を参照）

#### DR-1.1 route ストアの保存仕様
- 保存先：`~/.config/slacklocalvibe/routes.jsonl`
- 1行1JSON（JSONL）
- 保存項目：
  - `channel`
  - `thread_ts`
  - `tool`
  - `session_id`
  - `turn_id`（任意）
  - `ts`

#### DR-1.2 route ストアの取得仕様
- 返信イベントが持つ `channel` と `thread_ts` を使って **ローカルの route ストア**を検索する
- 見つからない場合は `resume` せず、固定文言で説明する（FR-4）

### DR-2 本文内の埋め込み行（任意）
- 本文への `[bridge] ...` の埋め込みは **任意**（人間の可読性向上目的）
- ルーティング復元の主経路ではない（DR-1）ため、本文分割/整形は自由（ただし切り捨てはしない：FR-6）

### DR-3 設定ファイル（必須・統一）

- 原則すべて設定ファイル（例：`~/.config/slacklocalvibe/config.json`）で管理する
- 環境変数を前提にしない
- 最低限のキー（概念）：
  - `slack.bot_token`（必須）
  - `slack.app_token`（必須）
  - `destinations.dm.enabled`（**必須**。未設定は `false` 扱い）
  - `destinations.dm.target_user_id`（必須）
  - `features.reply_resume` / `features.launchd_enabled`（**reply_resume=false の場合は launchd_enabled=false を必須**）




## 7. 非機能要件（NFR）

- 可用性：Slack listener停止中でもCLIは通常利用できる（通知・返信連携のみ影響）
- セキュリティ：Slackトークンは設定ファイルで管理しコミットしない
- Socket Mode：受信イベントは必ずACK（`envelope_id` を返す）し、重い処理はACK後に行う
- Slack API 呼び出しは**最大2回までリトライ**する（失敗は明示）
- **ログ/可観測性**（必須）：
  - daemon のログは `~/Library/Logs/slacklocalvibe/daemon.log` に出力する
  - **成功/失敗/スキップを必ずログ**し、入力・分岐・外部I/O・出力・所要時間を追跡可能にする
  - 固定文言（受領/対象外/失敗）の送信失敗も必ずログに残す
  - トークンや本文の生ログは避け、必要なら長さ・件数・相関IDを記録する
- **Claude resume の長文制約**：
  - `claude -r` は引数渡しのため長文/改行/引数長制限で失敗し得る
  - 改行は `\n` へ正規化して **1引数で渡す**（改行の欠落はさせない）
  - フォールバックは行わず、**失敗はエラーとして明示**しログに残す

## 7.1 Slack購読イベント（Socket Mode / Bot Events）

Socket Mode + Events API（bot events）で、最低限以下を購読する：

- `message.im`（DM）

※ `message.mpim`（グループDM）は本スコープ外（送信先として扱わない）



## 8. 受入基準（Acceptance Criteria）

1. Codexのターン完了ごとに、Slackに**新規親**が投稿される（route ストアに保存され、**親本文は当初ユーザー入力**）
2. Claude Codeのターン完了ごとに、Slackに**新規親**が投稿される（route ストアに保存され、**親本文は当初ユーザー入力**）
3. そのスレッドに返信すると、対応セッションに `resume` 実行される
4. 返信スレッドに **「CLIで継続するには終了→resumeし直し」注意**が必ず投稿される
5. `resume` の次ターン完了で、Slackに**別の新規スレッド**が投稿される
6. 長文応答は、親メッセージのスレッドに **分割投稿**され、本文が失われない（整形崩れは許容）
7. ユーザー入力が長い場合も、親スレッド内で分割され、欠落しない
8. route ストアに該当レコードが無いスレッドに返信しても、`resume` は実行されず、固定文言で説明される
9. `resume` が失敗した場合でも、**受領メッセージが送信され**、その後に失敗固定文言が投稿される
10. 送信先未設定の場合、通知は行われず**エラーとしてログに記録**される
