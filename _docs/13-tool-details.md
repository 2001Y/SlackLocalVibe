# SlackLocalVibe ツール詳細ドキュメント

更新日: 2026-01-31

## 目次

1. [概要](#概要)
2. [アーキテクチャ](#アーキテクチャ)
3. [コマンド体系](#コマンド体系)
4. [主要機能の詳細](#主要機能の詳細)
5. [データフロー](#データフロー)
6. [設定ファイル](#設定ファイル)
7. [実装の詳細](#実装の詳細)
8. [エラーハンドリング](#エラーハンドリング)
9. [ログとデバッグ](#ログとデバッグ)
10. [制限事項と注意点](#制限事項と注意点)

---

## 概要

**SlackLocalVibe** は、Codex CLI および Claude Code CLI のターン完了を検知してSlack DMに通知し、Slackスレッドへの返信をCLIの`resume`コマンドとして実行するブリッジツールです。

### 主な特徴

- **ターン完了通知**: Codex/Claude Codeのターン完了を自動検知し、Slack DMに通知
- **返信→resume**: Slackスレッドへの返信を自動的にCLIの`resume`コマンドとして実行
- **Socket Mode**: HTTP公開不要でSlackイベントを受信
- **対話型セットアップ**: ウィザード形式で簡単にセットアップ可能
- **常駐対応**: launchdによる自動起動サポート（macOS）

### 対応CLI

- **Codex CLI**: `notify`イベント（`agent-turn-complete`）をフック
- **Claude Code CLI**: `Stop` hookをフック

### 動作環境

- **OS**: macOS（推奨）
- **Node.js**: 18以上
- **Slack**: Socket Mode対応のSlack Appが必要

---

## アーキテクチャ

### システム構成

```
┌─────────────────┐
│  Codex/Claude   │
│      CLI        │
└────────┬────────┘
         │ notify/hook
         │
         ▼
┌─────────────────┐
│ slacklocalvibe  │
│     notify      │ ──┐
└────────┬────────┘   │
         │            │
         │ Slack API  │
         ▼            │
┌─────────────────┐   │
│   Slack DM      │   │
│  (親メッセージ)  │   │
└────────┬────────┘   │
         │            │
         │ スレッド返信 │
         │            │
         ▼            │
┌─────────────────┐   │
│ slacklocalvibe  │   │
│     daemon      │ ◄─┘
└────────┬────────┘
         │
         │ resume
         ▼
┌─────────────────┐
│  Codex/Claude   │
│      CLI        │
└─────────────────┘
```

### コンポーネント

1. **`notify`コマンド**: ターン完了を検知し、Slackに通知を投稿
2. **`daemon`コマンド**: Socket ModeでSlackイベントを受信し、返信を`resume`として実行
3. **`wizard`コマンド**: 対話型セットアップウィザード
4. **`launchd`コマンド**: macOSのlaunchd管理（install/uninstall/status）

### データストア

- **設定ファイル**: `~/.config/slacklocalvibe/config.json`
- **ルートストア**: `~/.config/slacklocalvibe/routes.jsonl`
- **ログファイル**: `~/Library/Logs/slacklocalvibe/`

---

## コマンド体系

### 基本コマンド

```bash
# ウィザード起動（初回セットアップ）
npx slacklocalvibe

# 通知送信（Codex/Claude hookから呼び出される）
slacklocalvibe notify --tool codex
slacklocalvibe notify --tool claude

# デーモン起動（返信受信）
slacklocalvibe daemon

# launchd管理
slacklocalvibe launchd install    # インストール
slacklocalvibe launchd uninstall   # アンインストール
slacklocalvibe launchd status      # ステータス確認
```

### コマンドの詳細

#### `notify`コマンド

**用途**: Codex/Claude Codeのターン完了を検知し、Slack DMに通知を投稿

**引数**:
- `--tool <tool>`: `codex` または `claude`（必須）
- `[payload]`: JSON文字列（Codexの場合は最後の引数として自動付与）

**動作**:
1. 標準入力または引数からイベントJSONを読み取り
2. セッションID、ユーザーメッセージ、アシスタント応答を抽出
3. Slack DMチャンネルを開く（`conversations.open`）
4. 親メッセージを投稿（ユーザーメッセージ）
5. スレッド返信としてアシスタント応答を分割投稿
6. ルート情報を`routes.jsonl`に保存

**入力形式**:

**Codex**:
```json
{
  "type": "agent-turn-complete",
  "thread-id": "session-id",
  "turn-id": "turn-id",
  "cwd": "/path/to/project",
  "input-messages": [...],
  "last-assistant-message": {...}
}
```

**Claude**:
```json
{
  "hook_event_name": "Stop",
  "session_id": "session-id",
  "transcript_path": "/path/to/transcript.jsonl",
  "cwd": "/path/to/project",
  "stop_hook_active": false
}
```

#### `daemon`コマンド

**用途**: Socket ModeでSlackイベントを受信し、返信を`resume`として実行

**動作**:
1. Socket Modeクライアントを起動
2. `message.im`イベントを購読
3. スレッド返信を検知
4. `routes.jsonl`からルート情報を検索
5. 受領メッセージを返信
6. `resume`コマンドを実行
7. 失敗時はエラーメッセージを返信

**イベントフィルタリング**:
- `subtype`付きイベントは無視
- Botメッセージは無視
- DM以外は無視
- スレッド返信のみ処理（`thread_ts`が存在し、`ts !== thread_ts`）

#### `wizard`コマンド

**用途**: 対話型セットアップウィザード

**フロー**:
1. イントロ表示
2. 対応CLI選択（Codex/Claude）
3. DM送信先設定（ユーザーID）
4. Slack App作成ガイド（manifest提示）
5. App-Level Token入力
6. OAuth Token入力
7. 通知テスト
8. Codex/Claude設定更新
9. 返信テスト
10. launchd登録（オプション）
11. 完了サマリ

---

## 主要機能の詳細

### 1. ターン完了通知

#### Codex通知

**イベント検知**:
- `notify`イベントの`type`が`agent-turn-complete`の場合に処理
- 内部タイトル生成プロンプトはスキップ

**ユーザーメッセージ抽出**:
- `~/.codex/sessions/**/rollout-*.jsonl`から最新の`user_message`を抽出
- ファイル名または内容で`thread-id`を検索
- 最新の`event_msg` → `payload` → `type: user_message`を取得

**アシスタント応答抽出**:
- `last-assistant-message`からテキストを抽出
- ネストされた構造から再帰的にテキストを取得

#### Claude通知

**イベント検知**:
- `hook_event_name`が`Stop`の場合に処理
- `stop_hook_active === true`の場合はスキップ（無限ループ防止）

**メッセージ抽出**:
- `transcript_path`からJSONLファイルを読み取り
- 最新の`user`ロールと`assistant`ロールのメッセージを抽出

### 2. Slack投稿

#### 親メッセージ

- **形式**: `[ Codex | project-name ]\nユーザーメッセージ`
- **チャンネル**: DMチャンネル（`conversations.open`で取得）
- **分割**: ユーザーメッセージが長い場合は`MAX_TEXT=3800`で分割

#### スレッド返信

- **順序**: ユーザーメッセージの続き → アシスタント応答
- **分割**: 各チャンクを`MAX_TEXT=3800`で分割
- **マークダウン変換**: Markdown → HTML → mrkdwn形式に変換

### 3. 返信→resume処理

#### ルート検索

- `routes.jsonl`から`channel`と`thread_ts`で検索
- 見つからない場合は固定文言で説明を返信

#### resume実行

**Codex**:
```bash
codex exec --skip-git-repo-check resume <session-id> -
```
- 標準入力からプロンプトを読み取り
- `--cd <cwd>`オプションで作業ディレクトリを指定

**Claude**:
```bash
claude -r <session-id> <prompt>
```
- プロンプトの改行を`\n`に正規化
- 1引数として渡す（長文制限あり）

#### 受領メッセージ

`resume`実行前に必ず受領メッセージを返信:
```
返信を受領しました。
これを `resume` として実行しました。結果は新規スレッドが作成されます。
CLI再開：`codex exec ...`
VSCode拡張機能など：ウィンドウ再読込など
```

### 4. ルートストア

**保存形式**: JSONL（1行1JSON）

**エントリ構造**:
```json
{
  "ts": "2026-01-31T12:00:00.000Z",
  "channel": "D1234567890",
  "thread_ts": "1234567890.123456",
  "tool": "codex",
  "session_id": "session-id",
  "turn_id": "turn-id",
  "cwd": "/path/to/project"
}
```

**管理**:
- ファイルサイズが1MBを超える場合、最新2000行を保持
- 古いエントリは自動削除

---

## データフロー

### 通知フロー

```
1. Codex/Claude CLI ターン完了
   ↓
2. notify hook 実行
   slacklocalvibe notify --tool codex <JSON>
   ↓
3. イベントJSON解析
   - session_id抽出
   - ユーザーメッセージ抽出（rollout/transcript）
   - アシスタント応答抽出
   ↓
4. Slack DMチャンネル取得
   conversations.open(users=U...)
   ↓
5. 親メッセージ投稿
   chat.postMessage(channel=D..., text=...)
   ↓
6. ルート情報保存
   routes.jsonl に追加
   ↓
7. スレッド返信投稿（分割）
   chat.postMessage(thread_ts=..., text=...)
```

### 返信フロー

```
1. Slack DM スレッド返信
   ↓
2. Socket Mode イベント受信
   message.im (thread_ts存在)
   ↓
3. イベントフィルタリング
   - subtypeチェック
   - botチェック
   - DMチェック
   - スレッド返信チェック
   ↓
4. ルート検索
   findRoute(channel, thread_ts)
   ↓
5. 受領メッセージ返信
   postThreadMessage(...)
   ↓
6. resume実行
   codex resume <session-id> - < prompt
   または
   claude -r <session-id> <prompt>
   ↓
7. 結果確認
   - 成功: ログ記録
   - 失敗: エラーメッセージ返信
```

---

## 設定ファイル

### 設定ファイル構造

**パス**: `~/.config/slacklocalvibe/config.json`

**構造**:
```json
{
  "slack": {
    "bot_token": "xoxb-...",
    "app_token": "xapp-..."
  },
  "destinations": {
    "dm": {
      "enabled": true,
      "target_user_id": "U1234567890"
    }
  },
  "features": {
    "reply_resume": true,
    "launchd_enabled": true
  }
}
```

### 設定項目の説明

#### `slack.bot_token`
- **型**: 文字列
- **必須**: はい（通知用）
- **説明**: Bot User OAuth Token（`xoxb-...`）
- **取得方法**: Slack Apps → OAuth & Permissions → Bot User OAuth Token

#### `slack.app_token`
- **型**: 文字列
- **必須**: はい（返信用）
- **説明**: App-Level Token（`xapp-...`）
- **取得方法**: Slack Apps → Basic Information → App-Level Tokens
- **スコープ**: `connections:write`, `authorizations:read`, `app_configurations:read`

#### `destinations.dm.enabled`
- **型**: 真偽値
- **必須**: はい
- **説明**: DM通知を有効化
- **デフォルト**: `false`（未設定時）

#### `destinations.dm.target_user_id`
- **型**: 文字列
- **必須**: はい（`enabled: true`の場合）
- **説明**: DM送信先のユーザーID（`U...`）
- **取得方法**: Slackプロフィール → メンバーIDをコピー

#### `features.reply_resume`
- **型**: 真偽値
- **必須**: いいえ
- **説明**: 返信→resume機能を有効化
- **デフォルト**: `false`

#### `features.launchd_enabled`
- **型**: 真偽値
- **必須**: いいえ
- **説明**: launchd自動起動を有効化
- **制約**: `reply_resume: false`の場合は`false`に強制

### 設定ファイルの権限

- **推奨権限**: `600`（所有者のみ読み書き可能）
- **自動設定**: ウィザードで自動的に設定

---

## 実装の詳細

### ファイル構成

```
src/
├── cli.js                    # エントリーポイント
├── commands/
│   ├── wizard.js             # ウィザード実装
│   ├── notify.js             # 通知コマンド
│   ├── daemon.js             # デーモンコマンド
│   └── launchd.js             # launchd管理
└── lib/
    ├── config.js             # 設定管理
    ├── slack.js              # Slack API操作
    ├── route-store.js        # ルートストア
    ├── notify-input.js       # イベント解析
    ├── resume.js             # resume実行
    ├── markdown-to-mrkdwn.js # Markdown変換
    ├── messages.js           # 固定メッセージ
    ├── user-config.js        # Codex/Claude設定更新
    ├── launchd.js            # launchd操作
    ├── logger.js             # ログ管理
    ├── paths.js              # パス解決
    └── text.js               # テキスト分割
```

### 主要モジュール

#### `lib/config.js`

**機能**:
- 設定ファイルの読み書き
- 設定の正規化
- 設定の検証

**主要関数**:
- `loadConfig()`: 設定ファイルを読み込み
- `writeConfig(config)`: 設定ファイルを書き込み
- `normalizeConfig(config)`: 設定を正規化
- `assertNotifyConfig(config)`: 通知設定を検証
- `assertDaemonConfig(config)`: デーモン設定を検証

#### `lib/slack.js`

**機能**:
- Slack Web API操作
- リトライ処理（最大2回）
- タイミング計測

**主要関数**:
- `createWebClient(token)`: WebClient作成
- `openDmChannel({client, userId, log})`: DMチャンネル取得
- `postParentMessage({client, log, channel, text})`: 親メッセージ投稿
- `postThreadMessage({client, log, channel, threadTs, text})`: スレッド返信投稿
- `postMessage({client, log, channel, text})`: メッセージ投稿

#### `lib/route-store.js`

**機能**:
- ルート情報の保存・検索
- ファイルサイズ管理（自動削減）

**主要関数**:
- `recordRoute({channel, threadTs, tool, sessionId, turnId, cwd})`: ルート保存
- `findRoute({channel, threadTs})`: ルート検索

#### `lib/notify-input.js`

**機能**:
- Codex/Claudeイベントの解析
- メッセージ抽出

**主要関数**:
- `parseCodexNotify(rawJson)`: Codexイベント解析
- `parseClaudeHook(rawJson)`: Claudeイベント解析

**Codexメッセージ抽出**:
- `~/.codex/sessions/**/rollout-*.jsonl`を検索
- ファイル名または内容で`thread-id`を検索
- 最新の`user_message`を抽出

**Claudeメッセージ抽出**:
- `transcript_path`からJSONLを読み取り
- 最新の`user`と`assistant`ロールを抽出

#### `lib/resume.js`

**機能**:
- `resume`コマンドの実行

**主要関数**:
- `runCodexResume({sessionId, prompt, cwd})`: Codex resume実行
- `runClaudeResume({sessionId, prompt, cwd})`: Claude resume実行
- `normalizeClaudePrompt(text)`: Claudeプロンプト正規化（改行を`\n`に変換）

#### `lib/markdown-to-mrkdwn.js`

**機能**:
- Markdown → mrkdwn形式への変換

**処理**:
1. `marked`でMarkdown → HTML変換
2. `html-to-mrkdwn`でHTML → mrkdwn変換

#### `lib/text.js`

**機能**:
- テキスト分割（Slack制限対応）

**分割ルール**:
- `MAX_TEXT = 3800`文字で分割
- 改行を考慮した分割（簡易実装）

#### `lib/logger.js`

**機能**:
- 構造化ログ出力
- ログレベル管理

**ログレベル**:
- `DEBUG`: デバッグ情報
- `INFO`: 一般情報
- `WARNING`: 警告
- `ERROR`: エラー
- `SUCCESS`: 成功

**ログファイル**:
- `~/Library/Logs/slacklocalvibe/notify.log`
- `~/Library/Logs/slacklocalvibe/daemon.log`
- `~/Library/Logs/slacklocalvibe/wizard.log`

---

## エラーハンドリング

### エラー分類

1. **設定エラー**
   - 設定ファイルが見つからない
   - 設定が不正
   - 必須項目が未設定

2. **Slack APIエラー**
   - 認証エラー（`invalid_auth`）
   - レート制限
   - ネットワークエラー

3. **メッセージ抽出エラー**
   - rolloutファイルが見つからない
   - transcriptファイルが見つからない
   - JSON解析エラー

4. **resume実行エラー**
   - CLIコマンドが見つからない
   - セッションIDが無効
   - プロンプトが長すぎる

### エラー処理方針

- **リトライ**: Slack API呼び出しは最大2回リトライ
- **ログ記録**: すべてのエラーをログに記録
- **ユーザー通知**: 重要なエラーはSlackに通知（ログの場所を提示）
- **フォールバック**: メッセージ抽出失敗時は固定メッセージで通知継続

### エラーメッセージ

**通知エラー時**:
```
ログの場所:
- notify: ~/Library/Logs/slacklocalvibe/notify.log
- daemon: ~/Library/Logs/slacklocalvibe/daemon.log
- wizard: ~/Library/Logs/slacklocalvibe/wizard.log
```

**resume失敗時**:
```
`resume` の実行に失敗しました。
詳細はCLIログをご確認ください。
エラー: <エラー詳細>
```

---

## ログとデバッグ

### ログファイル

**場所**: `~/Library/Logs/slacklocalvibe/`

**ファイル**:
- `notify.log`: 通知コマンドのログ
- `daemon.log`: デーモンのログ
- `wizard.log`: ウィザードのログ

### ログ形式

**構造化ログ**（JSONL形式）:
```json
{
  "timestamp": "2026-01-31T12:00:00.000Z",
  "level": "INFO",
  "scope": "notify",
  "event": "notify.start",
  "data": {
    "tool": "codex"
  }
}
```

### 主要ログイベント

#### notify
- `notify.start`: 通知開始
- `notify.codex_prompt_source`: Codexメッセージ抽出情報
- `notify.route_recorded`: ルート保存成功
- `notify.done`: 通知完了
- `notify.user_text_missing`: ユーザーメッセージ抽出失敗
- `notify.slack_error`: Slack APIエラー

#### daemon
- `daemon.start`: デーモン起動
- `daemon.socket_connected`: Socket Mode接続成功
- `daemon.ack`: イベントACK成功
- `daemon.reply_received`: 受領メッセージ送信
- `daemon.resume_result`: resume実行結果
- `daemon.event_done`: イベント処理完了

#### wizard
- `wizard.start`: ウィザード開始
- `wizard.config_saved`: 設定保存成功
- `wizard.notify_test_ok`: 通知テスト成功
- `wizard.reply_test_ok`: 返信テスト成功

### デバッグ方法

1. **ログ確認**: 各ログファイルを確認
2. **設定確認**: `~/.config/slacklocalvibe/config.json`を確認
3. **ルート確認**: `~/.config/slacklocalvibe/routes.jsonl`を確認
4. **手動テスト**: `notify`コマンドを手動実行
5. **デーモン確認**: `daemon`コマンドを手動起動してログ確認

---

## 制限事項と注意点

### 制限事項

1. **Slack文字数制限**
   - メッセージ本文: 40,000文字（実装では3,800文字で分割）
   - 分割投稿で整形が崩れる可能性あり

2. **Claude resume制限**
   - 引数長制限あり（OS依存）
   - 長文プロンプトは失敗する可能性あり

3. **ルートストア**
   - ファイルサイズ制限: 1MB
   - 最大エントリ数: 2,000行（超過時は自動削減）

4. **同時実行**
   - 二重resume対策は実装していない（CLI側で解決）
   - 競合対策はCLI側に任せる

### 注意点

1. **セッション管理**
   - CLIセッションを終了してから`resume`を実行することを推奨
   - 同時実行は競合の可能性あり

2. **メッセージ抽出**
   - Codexのrolloutファイルが見つからない場合は通知しない
   - Claudeのtranscriptファイルが見つからない場合はエラーメッセージで通知

3. **Socket Mode**
   - インターネット接続が必要
   - 接続が切れた場合は自動再接続を試みる

4. **launchd**
   - macOS専用機能
   - ログイン時に自動起動
   - 手動起動の場合は`slacklocalvibe daemon`を実行

### トラブルシューティング

#### 通知が届かない

1. 設定ファイルを確認（`bot_token`, `target_user_id`）
2. 通知ログを確認（`notify.log`）
3. Slack Appの権限を確認（`chat:write`, `im:write`）
4. DMチャンネルが正しく開けているか確認

#### 返信が動作しない

1. デーモンが起動しているか確認（`launchd status`）
2. デーモンログを確認（`daemon.log`）
3. Socket Modeが有効か確認
4. `app_token`が正しいか確認
5. イベント購読設定を確認（`message.im`）

#### resumeが失敗する

1. CLIコマンドがインストールされているか確認
2. セッションIDが有効か確認
3. プロンプトが長すぎないか確認
4. 作業ディレクトリが存在するか確認

---

## 付録

### Slack App Manifest

```yaml
_metadata:
  major_version: 1

display_information:
  name: LocalVibe
  description: DMで通知と返信を扱うブリッジ
  background_color: "#0a0a0a"

features:
  bot_user:
    display_name: LocalVibe
    always_online: false
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false

oauth_config:
  scopes:
    bot:
      - chat:write
      - im:write
      - im:history

settings:
  socket_mode_enabled: true
  is_hosted: false
  token_rotation_enabled: false
  event_subscriptions:
    bot_events:
      - message.im
  org_deploy_enabled: false
```

### テストプロンプト

ウィザードで使用される固定プロンプト:
```
あなたは誰？
```

### 固定メッセージ

**受領メッセージ**:
```
返信を受領しました。
これを `resume` として実行しました。結果は新規スレッドが作成されます。
CLI再開：`codex exec ...`
VSCode拡張機能など：ウィンドウ再読込など
```

**無効な返信**:
```
この返信は `SlackLocalVibe` の通知スレッドとして認識できませんでした（route 情報が見つからない/不正）。
**通知（親）メッセージ**に対してスレッド返信してください。
（補足：このスレッドでは `resume` は実行しません）
```

**resume失敗**:
```
`resume` の実行に失敗しました。
詳細はCLIログをご確認ください。
```

---

*このドキュメントは、SlackLocalVibe v0.1.7 を基に作成されました。*
