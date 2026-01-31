# 詳細設計書（Codex / Claude Code ↔ Slack Turn Bridge）

更新日: 2026-01-27

## 1. 設計方針

- 「Slackスレッド＝セッション（Slack新規スレッドで新規セッション開始）」は採用しない（セッションはCLI側の session_id/cwd を正とする）
- Slackは「ターン完了通知」＋「通知スレッドへの返信（次入力）」のみ
- ターン完了通知は **常に新規親メッセージ（新規スレッド開始）**
- DBなし（永続ストレージ不要）
- 競合は完全には防げないため、**スレッド返信時に運用注意（CLI終了→resume）を必ず返す**



## 2. コンポーネント構成
### 2.1 CLIコマンド（仕様書ベース）
- `slacklocalvibe`
  - 対話型セットアップ（通知は必須、返信も必須）
  - `slacklocalvibe notify`
  - Codex/Claudeのhookから **`slacklocalvibe`** で呼ばれ、Slackに**新規親**を投稿する
- `slacklocalvibe daemon`
  - Socket ModeでSlackイベントを監視し、**通知スレッドへの返信**を拾って `resume` 実行する（**npm（グローバル導入）**で常駐/手動起動）

#### 2.1.1 ウィザードのデフォルト判定
- **既存設定ファイルが見つかったCLIはデフォルトON**（ユーザーが最終確定）
  - Codex: `~/.codex/config.toml`（または `CODEX_HOME/config.toml`）
  - Claude: `~/.claude/settings.json`
- 本番同等テストは **確定したCLI設定に従い、テストプロンプトを新規送信**する
  - hooks経由でSlack通知が届くことを確認し、そのスレッド返信で `resume` を実行する
  - **`slacklocalvibe daemon` はウィザードがバックグラウンド起動する**（失敗時は手動で起動）

#### 2.1.2 テスト用プロンプト（固定）
「【SlackLocalVibe 本番同等テスト】このメッセージはテスト実行です。」と言ってください

#### 2.1.3 テスト実行コマンド（固定）

- Codex: `codex exec "「【SlackLocalVibe 本番同等テスト】このメッセージはテスト実行です。」と言ってください"`
- Claude: `claude -p "「【SlackLocalVibe 本番同等テスト】このメッセージはテスト実行です。」と言ってください"`

### 2.2 Slack App
- 推奨：Socket Mode（外部HTTP公開不要）
- OAuth Tokens（xoxb-）＋ App-Level Tokens（xapp-）
- 送信/受信は **DMのみ**（チャンネル対象外）
- 作成は **From a manifest** を推奨（再現性重視）
- 必要スコープ（最小）：
  - `chat:write`
  - `im:write`（DM開始のため `conversations.open` を使う）
  - `im:history`
  - `connections:write`, `authorizations:read`, `app_configurations:read`（App-level token）

## 2.3 Slack購読イベント（Socket Mode / Bot Events）

本パッケージは「通知スレッドへのスレッド返信」だけを扱うため、購読イベントは最小にする：

- `message.im`（DM）

※ `message.mpim`（グループDM）はスコープ外（送信先として扱わない）




## 3. データ設計（DBなし）

### 3.1 ルーティング情報（ローカル route ストア：必須）

復元は本文解析に依存せず、ローカル route ストアを **唯一の正**として用いる。

- 通知（親）メッセージ投稿時に `routes.jsonl` へ `tool/session_id/thread_ts/cwd` を保存する
- daemonはスレッド返信受信時、`thread_ts` で route を復元する
- `cwd` は route ストアに保存し、`resume` の実行ディレクトリとして使用する

### 3.2 型定義（必須）

以下は「実装で必ず満たす型」。

#### 3.2.1 ルーティング型

```ts
export type BridgeTool = "codex" | "claude";

export type BridgeRoute = {
  tool: BridgeTool;
  session_id: string; // 必須
  turn_id?: string;   // 取れる場合のみ
};
```

#### 3.2.2 route ストア型（通知親：必須）

```ts
export type RouteStoreEntry = {
  ts: string;         // ISO8601
  channel: string;    // D...
  thread_ts: string;  // 親メッセージのts
  tool: BridgeTool;
  session_id: string; // 必須
  turn_id?: string;   // 取れる場合のみ
  cwd?: string;       // 取れる場合のみ
};
```

#### 3.2.3 設定ファイル型（原則すべて設定ファイルで管理）

```ts
export type SlackConfig = {
  bot_token: string;  // xoxb-...
  app_token?: string; // xapp-...（返信機能を使う場合）
};

export type DestinationsConfig = {
  dm?: {
    enabled: boolean;
    target_user_id: string; // U...
  };
};

export type FeaturesConfig = {
  reply_resume: boolean;
  launchd_enabled: boolean; // reply_resume=false の場合は false を必須
};

export type SlackLocalVibeConfig = {
  slack: SlackConfig;
  destinations: DestinationsConfig;
  features: FeaturesConfig;
};
```



## 4. Slack 投稿設計
### 4.1 ターン完了通知（親メッセージ）
- API：`chat.postMessage`
- `thread_ts` は指定しない（=新規親）
- DM宛先：`conversations.open(users=<U...>)` で得た `D...` に投稿する（`channel=U...` 直指定は使用しない）
- 本文構成（mrkdwn想定）：
  1) 当初のユーザーメッセージ本文（可能な限りそのまま）
  2) （任意）デバッグ用の識別子行
- 当初ユーザーメッセージが抽出できない場合は、親本文に **`（ユーザーメッセージ抽出失敗）`** と明記する（空欄にしない）
- 送信先未設定はエラーとしてログに記録する

- **route ストア（必須）**：
  - 親メッセージ送信後に `routes.jsonl` へ `channel` / `thread_ts` / `tool` / `session_id` を保存
  - tool/session/turn の可視表示は任意（**route ストアを唯一の正**とする）

### 4.1.1 ターン完了本文（スレッド返信へ分割投稿）
- API：`chat.postMessage`（`thread_ts` 指定、親メッセージのスレッドに投稿）
- AI応答本文は **切り捨てず**、9章のルールで `MAX_TEXT` 上限内に分割して複数投稿する
- ユーザーメッセージが長い場合は、**続きの投稿（ユーザーメッセージの延長）を先に送る**（AI応答より前）
- （推奨）分割番号を付ける：`(1/3) ...`
- 分割による整形崩れは許容（本文の欠落回避を優先）

### 4.2 返信受領＆注意書き（スレッド返信）
- API：`chat.postMessage`（`thread_ts` 指定）
- **`resume` 実行前に必ず送信する**（受領→`resume` の順）
- 必ず含める：
  - 「受領した。resumeで実行する」旨
  - **重要**：「家でCLIを継続する場合は、今開いている対話CLIを一度終了してから、改めて resume で入り直す」旨
- `resume` が失敗した場合は、**受領メッセージ送信後**に失敗固定文言を投稿する（11.3）

### 4.3 対象外スレッドへの挙動

Bridge対象外のスレッド返信（route 情報が見つからない場合）：

- `resume` は実行しない
- スレッドに固定文言を返信する（11.2）
  - ただし空返信は 5.1 のとおり最優先で無視し、ここには到達しない




## 5. Slack返信受信・ルーティング復元

### 5.1 受信条件

- イベントが `message` かつ `thread_ts` を持つ（スレッド返信）
- bot自身の投稿（`bot_id` / `subtype=bot_message`）は除外
- 返信本文は `event.text` のみを使用（blocks/attachments/filesは無視）
- `message_changed` / `message_deleted` など **subtype付きイベントは対象外**（resumeしない）
- 返信本文が空（空文字/空白のみ）の場合は**最優先で無視**する（`resume` も固定文言返信も行わない。親取得もしない）
- Socket Modeのイベントは受信後すぐACK（`envelope_id` を返す）し、重い処理はACK後に行う（再送を最小化する）

### 5.2 route ストア取得

- `channel` と `thread_ts` から **ローカル route ストア**を検索する
  - 本パッケージは route ストア復元が主目的のため、Slack親取得は不要

### 5.3 ルーティング情報パース

- route ストアのレコードを読み取り、次を満たすことを検証する：
  - `tool` が `BridgeTool` 型に一致
  - `session_id` が存在する
- 満たさない場合：対象外として扱い、固定文言を返信して終了（4.3 / 11.2）

### 5.4 重複配信（Events再送）の扱い

Slackイベントの再送に関する重複対策は**CLI側で解決**し、本パッケージでは重複排除を実装しない。
ACKを早く返しても再送自体を**完全には防げない**前提で設計する。



## 6. CLI 実行設計（resume）
### 6.1 Codex
- コマンド（実仕様）：
  - `codex exec resume <SESSION_ID> -`（PROMPTは `-` でstdinから読み取る）
- 返信本文（Slackの `text`）を **PROMPT** として渡す
- PROMPT は **stdin (`-`) で渡す**（改行/クォート問題を避ける。シェル経由は使わない）
- `cwd` を取得できた場合は `resume` の実行ディレクトリとして使用する（取得不可の場合は未指定）

### 6.2 Claude Code
- コマンド（実仕様：`claude --help` で確認）：
  - `claude -r <SESSION_ID> [PROMPT]`（`--resume`。`SESSION_ID` はUUID。`PROMPT` は任意）
  - `claude -c [PROMPT]`（`--continue`。**現在ディレクトリの直近**を再開）
  - `claude --fork-session -r <SESSION_ID> [PROMPT]`（再開時に新しい session ID を発行）
  - `claude -p [PROMPT]`（`--print`。非対話の一発実行）
- 返信本文（Slackの `text`）を **PROMPT** として渡す（シェル経由は使わない）
- PROMPT は**引数で渡す**（公式CLI例は `claude -r <SESSION_ID> "query"`。stdin の例は `-p` のみ）
- **PROMPT正規化**：
  - 改行（CRLF/CR/LF）を **`\n`（文字列）へ変換**し、**単一引数**として渡す
  - 切り捨てや要約は行わない（欠落回避）
- 長文/引数長制限で失敗し得るため、**失敗はエラーとして明示**しログに残す（フォールバックなし）
- `cwd` を取得できた場合は `resume` の実行ディレクトリとして使用する（取得不可の場合は未指定）

### 6.3 同時実行対策

同時実行対策（プロセス間ロック、厳密な順序保証、二重実行の完全防止）はCLI側に任せ、本パッケージでは実装しない。  
Slack Events の再送に起因する重複も同様にCLI側で解決する。




## 7. ターン完了検知

### 7.1 Codex notify

- `notify` から `slacklocalvibe notify --tool codex` を起動する
- `slacklocalvibe notify` は入力JSONを受け取り、`type == "agent-turn-complete"` のみ処理する
- notify は **JSON文字列を1引数としてコマンド末尾に付与**して実行される（公式例：`sys.argv[1]` をJSONとして読む）
  - `slacklocalvibe notify --tool codex` の場合は JSON が**最後の引数**になるため、末尾引数をJSONとして読む
- JSONの主なキー（公式例）：`type`, `thread-id`, `turn-id`, `cwd`, `input-messages`, `last-assistant-message`
 - エラー時は Slack に「ログの場所:」を投稿する
- 親本文は **Codex の rollout JSONL (`~/.codex/sessions/**/rollout-*.jsonl`) の `event_msg` → `user_message` を正として抽出**する
  - `thread-id` に対応するファイル（ファイル名 or 内容一致）を探す
  - 最新の `user_message` を採用する
  - `input-messages` はデバッグメタとしてのみ保持する
- タイトル生成テンプレート文言に一致する場合は **SKIP**（内部タスク除外）
- rollout が見つからない／抽出できない場合は **`notify.user_text_missing` をエラー記録して通知しない**

#### Codexユーザー設定（公式：config.toml）
Codexの通知フックはユーザー設定ファイルで指定する（公式ドキュメント参照）。本パッケージの **ウィザード** は `~/.codex/config.toml`（`CODEX_HOME` が設定されている場合は `CODEX_HOME/config.toml`）を読み取り、**該当キー（notify）だけ**を更新して反映する（他の設定は保持する）。

例（概念）：

```toml
notify = ["slacklocalvibe", "notify", "--tool", "codex"]
```

### 7.2 Claude Stop hook

- `Stop` イベントで `slacklocalvibe notify --tool claude` を起動する
- `slacklocalvibe notify` は入力JSONを受け取り、`hook_event_name == "Stop"` のみ処理する
- `transcript_path` があれば本文抽出に利用
- hook入力は **stdinのJSON** を読む想定
- Hook Inputの共通キー：`session_id`, `transcript_path`, `cwd`, `permission_mode`, `hook_event_name`
- `Stop` 入力で追加されるキー：`stop_hook_active`
- `stop_hook_active == true` の場合は無限ループ防止のため再通知しない（通知をスキップする）

#### Claude Codeユーザー設定（公式：settings.json）
Claude Codeのhookはユーザー設定ファイルで指定する（公式ドキュメント参照）。本パッケージの **ウィザード** は `~/.claude/settings.json` を読み取り、**該当箇所（Stop hook）だけ**を更新して反映する（他の設定は保持する）。なおプロジェクト設定（`.claude/settings.json` / `.claude/settings.local.json`）は対象外とする。

例（概念）：

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "slacklocalvibe notify --tool claude"
          }
        ]
      }
    ]
  }
}
```



## 8. 応答本文抽出（Claude）
- `transcript_path` は **JSONL 形式のセッション全履歴**ファイルへのパス
- 可能な範囲で本文抽出を試み、抽出できない場合は「本文抽出エラー」として扱う（フォーマット変更のフォールバックはしない）
- 抽出失敗時：
  - Slackにはメタ情報のみ投稿し、「本文抽出エラー」と明記する（フォーマット変更のフォールバックはしない）




## 9. 文字数制御（スレッド分割で切り捨てない）

- `MAX_TEXT = 3800`
- Slackは 40,000 文字を超えると切り捨てられる。以前は 4,000 bytes 程度を推奨としていたため安全マージンとして 3,800 を採用する
- 親メッセージは**当初ユーザー入力**を投稿する（4.1）
- ユーザー入力が長い場合は、スレッドに分割して**続き→AI応答**の順で投稿する（4.1.1）
- 分割ルール：
  - 1メッセージあたり `MAX_TEXT` 文字以下
  - 可能なら改行境界で分割（ただし厳密な整形は必須ではない）
  - 分割数が複数の場合は番号を付ける（例：`(2/5)`）



## 10. エラー処理
- Slack投稿失敗：notify側はexit 0（CLI本体の失敗にしない）。ただしログはファイルへ出力する  
- Slack API 呼び出しは**最大2回までリトライ**する（ACKを遅らせない）
- 親取得失敗：固定文言を返信し、`resume` は実行しない（11.2）
- `resume` 失敗（exit非0）：スレッドに固定文言で失敗を返信（理由は最小限、11.3）
- 受領/対象外/失敗の**固定文言送信が失敗した場合も必ずログ**に残す

### 10.1 notify のログ出力先（macOS）
- `~/Library/Logs/slacklocalvibe/notify.log`
  - **成功/失敗とも**、1行JSON（時刻/ツール/宛先数/全体成功/Slack errorコード等）を追記する
  - トークン（xoxb/xapp）や本文はログに出さない

### 10.2 daemon のログ出力先（macOS）
- `~/Library/Logs/slacklocalvibe/daemon.log`
  - **成功/失敗/スキップを必ず記録**し、入力・分岐・外部I/O・出力・所要時間を追跡可能にする
  - 例：相関ID、イベント種別、対象スレッド、`resume` 実行可否、固定文言送信可否、処理時間
  - トークンや本文の生ログは出さない（長さ・件数・相関IDのみ）




## 11. 運用メッセージ（固定文）

### 11.1 受領＋注意（必須）

> 返信を受領しました。これを `resume` として実行します。  
> **注意：家でCLIを続ける場合は、いま開いている対話CLIをいったん終了し、改めて `resume` で入り直してください。**  
> （Slack側の `resume` は別プロセスで進むため、同時操作すると順序逆転・二重実行が起き得ます。）

### 11.2 対象外/復元失敗時（必須）

> この返信は `SlackLocalVibe` の通知スレッドとして認識できませんでした（route 情報が見つからない/不正）。  
> **通知（親）メッセージ**に対してスレッド返信してください。  
> （補足：このスレッドでは `resume` は実行しません）

### 11.3 resume 失敗時（必須）

> `resume` の実行に失敗しました。  
> 詳細はCLIログをご確認ください。

### 11.4 本番同等テスト用（ウィザード時）

> 「【SlackLocalVibe 本番同等テスト】このメッセージはテスト実行です。」と言ってください

## 12. launchd（macOS）常駐運用

> **返信（reply_resume）ONの場合のみ対象**。reply_resume=false の場合は launchd を有効化しない。

### インストール先

- plist: `~/Library/LaunchAgents/dev.slacklocalvibe.daemon.plist`

### plist要件（最低限）

- `Label`: `dev.slacklocalvibe.daemon`
- `ProgramArguments`: `["/ABS/PATH/TO/node","/ABS/PATH/TO/slacklocalvibe","daemon"]`（install時に絶対パスへ解決して埋め込む）
  - install時に `command -v slacklocalvibe` で解決できない場合はエラーとして中断する（フォールバックしない）
- `RunAtLoad`: `true`
- `KeepAlive`: `true`（異常終了時に再起動）
- `ThrottleInterval`: `10`（再起動ループを抑制）
- `StandardOutPath` / `StandardErrorPath`：`~/Library/Logs/slacklocalvibe/daemon.log` 等へ出力（原因調査を容易にする）
- 設定は **設定ファイル**から読む（環境変数は前提にしない）
- `EnvironmentVariables.PATH` を明示し、`node` / `codex` / `claude` が解決できるようにする（launchd はシェル初期化を読まない）

### CLIオプション（必須）

launchdの操作は、ユーザーが手で `launchctl` を叩かずに完結できるよう、以下を提供する（最小コマンド）：

- `slacklocalvibe launchd install`：plist生成＋`launchctl bootstrap`（ログイン時自動起動）
- `slacklocalvibe launchd uninstall`：`launchctl bootout`＋plist削除（完全削除）
- `slacklocalvibe launchd status`：現在の登録/稼働状態を表示

### アンインストール/無効化の期待挙動

- `uninstall` は常駐を停止し、ファイルも削除する（完全に戻す）

### 実装メモ（launchctlの実操作イメージ）

CLIは内部で以下相当の操作を行う（ユーザーに手操作を要求しない）：

- install:
  - `launchctl bootstrap gui/$UID ~/Library/LaunchAgents/dev.slacklocalvibe.daemon.plist`
- uninstall:
  - `launchctl bootout gui/$UID/dev.slacklocalvibe.daemon`
  - plist削除（`~/Library/LaunchAgents/...`）

※ 本設計はモダンmacOSの `bootstrap/bootout` を正とする



## 12. 受入テスト項目

1. Codexターン完了 → Slackに新規親が投稿される（route ストアに保存）
2. Claudeターン完了 → Slackに新規親が投稿される（route ストアに保存）
3. 返信 → route ストアから tool/session が復元され、`resume` が実行される
4. 返信スレッドに注意書きが返る（CLI終了→resumeし直し）
5. `resume` 実行後のターン完了 → Slackに別の新規親が投稿される
6. 長文応答が、親メッセージのスレッドに分割投稿され、本文が失われない
7. route ストア未検出 / 型不一致の場合、`resume` は実行されず、固定文言が返る
