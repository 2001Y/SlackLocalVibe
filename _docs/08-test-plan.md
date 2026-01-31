# テストパターン詳細（全ケース網羅）

更新日: 2026-01-28

## 0. 事前準備（必須）

- macOS
- Node.js >= 18
- Slack App（Socket Mode）
  - OAuth Tokens（xoxb-...）
  - App-Level Tokens（xapp-...）
- Scopes: `chat:write`, `im:write`, `im:history`, `connections:write`, `authorizations:read`, `app_configurations:read`
  - Event Subscriptions（bot events）: `message.im`
  - App Home: Messages タブを ON
- DM 送信先（自分の `U...`）
- ログ出力先を確認:
  - `~/Library/Logs/slacklocalvibe/notify.log`
  - `~/Library/Logs/slacklocalvibe/daemon.log`
  - `~/Library/Logs/slacklocalvibe/wizard.log`

## 1. ウィザード（`npx slacklocalvibe`）テスト

### 1.1 通常フロー（推奨すべて ON）
1) `npx slacklocalvibe`
2) 既存設定がある場合は「アップデートを確認する（最優先）」が表示される
   - 「現在 / 最新」バージョンが表示される
   - 更新があれば「アップデートしますか？」が表示される
   - 更新後に「launchd を再登録しますか？」が表示される
2) 対応するCLIを選択（Codex / Claude、デフォルト両方）
3) DM 送信先を設定
4) manifest がクリップボードにコピーされる
5) 「Slack Apps 新規作成を開く」を実行
   - manifest は **YAML** である
   - アプリ作成後の **Basic Information** にある **App-Level Tokens** で `xapp-...` を発行
   - App-Level Tokens のスコープは `connections:write` / `authorizations:read` / `app_configurations:read`
   - 次に **OAuth & Permissions** で **OAuth Tokens** を発行（OAuth Tokens の取得が目的）
6) App-Level Tokens（xapp-...）入力
7) OAuth Tokens（xoxb-...）入力
8) 通知テスト実行（成功）
9) Slack通知が届いたか確認し、必要ならログを表示
10) Codex 設定を有効（既存設定があればデフォルト ON）
11) Claude 設定を有効（既存設定があればデフォルト ON）
12) Slack からの返信に対応するため、必要なら `npm i -g slacklocalvibe` を実行
13) 本番同等テストを実行（Codex/Claude の片方 or 両方）
    - 返信対応のため daemon はウィザードが自動起動
    - Codex: `codex exec "あなたは誰？"`
    - Claude: `claude -p "あなたは誰？"`
14) Slack通知が届いたか確認し、必要ならログを表示
15) 通知スレッドに返信し、`resume` 結果が新しいスレッドで届くことを確認
    - 例: 「あなたはなにができる？」
16) launchd を登録（スキップ可）

期待結果:
- 設定ファイルが保存される: `~/.config/slacklocalvibe/config.json`
- OAuth Tokens / App-Level Tokens が保存される（ログに値は出ない）
- 通知テストが Slack DM に届く
- Codex: `~/.codex/config.toml` の notify が上書きされる
- Claude: `~/.claude/settings.json` の Stop hook が追加される
- npm グローバルインストールが成功する（`command -v slacklocalvibe` で解決）
- launchd 登録が成功（`launchctl print gui/$UID/dev.slacklocalvibe.daemon` で確認）

### 1.2 通知テスト失敗 → 再入力
1) OAuth Tokens に誤った値を入力
2) 通知テスト失敗 → 再入力を選ぶ

期待結果:
- 失敗ログが記録される
- 再入力できる
- 成功するまで完了できない

### 1.3 Codex/Claude 設定の更新失敗
1) それぞれの設定ファイルを削除 or 破損させる
2) 更新を有効にする

期待結果:
- 「再試行 / 終了」を選べる
- 失敗はエラーとしてログに記録される

### 1.4 返信テストで daemon 自動起動に失敗
1) daemon の自動起動に失敗する環境で返信テストを実行

期待結果:
- 手動起動を促す表示が出る
- Slack 返信 → resume 反映が起きない（daemon 依存）
- 失敗をログで確認可能

## 2. notify（Codex）テスト

### 2.1 ターン完了イベント（正常）
実行:
```sh
node src/cli.js notify --tool codex '{"type":"agent-turn-complete","thread-id":"t-123","turn-id":"1","cwd":"/tmp/project","input-messages":[{"role":"user","content":"hi"}],"last-assistant-message":"hello"}'
node src/cli.js notify --tool codex '{"type":"agent-turn-complete","thread-id":"t-123","turn-id":"2","cwd":"/tmp/project","input-messages":[{"content":[{"type":"input_text","text":"hi no role"}]}],"last-assistant-message":"ok"}'
```
期待結果:
- DM に新規親メッセージ（本文: `hi`）が投稿される
- route ストア（`routes.jsonl`）に `channel` / `thread_ts` / `tool` / `session_id` / `cwd` が保存される
- `last-assistant-message` がスレッド返信として投稿される

### 2.2 非対象イベント（スキップ）
実行:
```sh
node src/cli.js notify --tool codex '{"type":"agent-start","thread-id":"t-123"}'
```
期待結果:
- Slack 送信されない
- `notify.skip.not_target_event` が記録される

### 2.3 ユーザーメッセージ抽出失敗
実行:
```sh
node src/cli.js notify --tool codex '{"type":"agent-turn-complete","thread-id":"t-123"}'
```
期待結果:
- Slack 送信されない
- `notify.user_text_missing` が **ERROR** で記録される

### 2.4 JSONL user_message を正とする
準備:
- `~/.codex/sessions/**/rollout-*.jsonl` に `event_msg` → `user_message` が存在すること

実行（input-messages に内部タスクが混在していても、JSONL を正とする）:
```sh
node src/cli.js notify --tool codex '{"type":"agent-turn-complete","thread-id":"<thread-id>","input-messages":[{"role":"user","content":"INTERNAL TASK PROMPT"}],"last-assistant-message":"ok"}'
```
期待結果:
- 親本文は JSONL の `user_message` が採用される
- `notify.codex_prompt_source` に `rollout_source` が記録される

### 2.5 JSONL が見つからない場合
実行:
```sh
node src/cli.js notify --tool codex '{"type":"agent-turn-complete","thread-id":"missing-thread-id","input-messages":[{"role":"user","content":"hi"}],"last-assistant-message":"ok"}'
```
期待結果:
- 親本文が `（ユーザーメッセージ抽出失敗）` になる
- `notify.user_text_missing` に `codex_rollout_error` が記録される

### 2.6 タイトル生成プロンプトを除外（内部タスク）
準備:
- `~/.codex/sessions/**/rollout-*.jsonl` の最新 `user_message` がタイトル生成テンプレート文言

実行:
```sh
node src/cli.js notify --tool codex '{"type":"agent-turn-complete","thread-id":"<thread-id>","input-messages":[{"role":"user","content":"dummy"}],"last-assistant-message":"ok"}'
```
期待結果:
- Slack 送信されない
- `notify.skip.codex_internal_title_prompt` が記録される

## 3. notify（Claude）テスト

### 3.1 Stop hook 正常
stdin で Stop JSON を流す（`transcript_path` は実在ファイル）:
```sh
cat /path/to/transcript.jsonl | node src/cli.js notify --tool claude
```
期待結果:
- 直近の user メッセージが親本文
- 直近の assistant メッセージがスレッド返信

### 3.2 stop_hook_active=true
stdin:
```json
{"hook_event_name":"Stop","stop_hook_active":true}
```
期待結果:
- Slack 送信されずスキップ

### 3.3 transcript_path 不正
stdin:
```json
{"hook_event_name":"Stop","session_id":"s-1","transcript_path":"/no/such/file"}
```
期待結果:
- 親本文 `（ユーザーメッセージ抽出失敗）`
- assistant 本文は `（本文抽出エラー: ...）`

## 4. スレッド分割（長文）

### 4.1 ユーザーメッセージ長文
`input-messages` を 4000 文字以上にして notify 実行。

期待結果:
- 親は最初の 3800 文字
- 残りはスレッド返信に分割投稿（AI応答より先に投稿される）

### 4.2 AI 応答長文
`last-assistant-message` を 4000 文字以上にして notify 実行。

期待結果:
- スレッド返信が複数投稿され、本文が欠落しない

## 5. daemon（返信 → resume）テスト

### 5.1 正常系（route ストア有効）
1) Slack DM に通知が届く
2) そのスレッドへ返信

期待結果:
- 受領メッセージ（注意文付き）が先に投稿
- `codex exec resume` または `claude -r` が実行される

### 5.2 route ストア未検出
条件:
- route ストアに該当レコードが存在しない

期待結果:
- `REPLY_INVALID_MESSAGE` が返信され、resume は実行されない

### 5.3 空返信
条件:
- 返信本文が空文字/空白のみ

期待結果:
- 何も返信されず、親取得もしない

### 5.4 bot 投稿/サブタイプ
条件:
- `bot_id` / `subtype` を含むイベント

期待結果:
- 無視（resume しない）

### 5.5 グループDM（mpim）
条件:
- `event.channel_type === "mpim"`

期待結果:
- 無視（resume しない）

### 5.6 Claude 改行正規化
条件:
- 返信本文に複数行

期待結果:
- `\r\n`/`\r` が `\n` へ正規化され、`claude -r <id> "<PROMPT>"` で実行される

### 5.7 resume 失敗
条件:
- codex/claude コマンドが non-zero で終了

期待結果:
- 受領後に `RESUME_FAILED_MESSAGE` が投稿される

## 6. launchd テスト

### 6.1 install
実行:
```sh
slacklocalvibe launchd install
```
期待結果:
- plist 作成: `~/Library/LaunchAgents/dev.slacklocalvibe.daemon.plist`
- `launchctl bootstrap` 成功

### 6.2 status
実行:
```sh
slacklocalvibe launchd status
```
期待結果:
- 登録済みなら success, 未登録なら warning

### 6.3 uninstall
実行:
```sh
slacklocalvibe launchd uninstall
```
期待結果:
- bootout 後に plist 削除

## 7. ログ検証（必須）

確認ポイント:
- JSON Lines 形式で 1 行 1 イベント
- `level`, `scope`, `message`, `duration_ms` を含む
- トークン/本文がログに含まれない

ログ例（要素のみ検証）:
- `notify.start`, `notify.done`, `notify.slack_error`
- `daemon.ack`, `daemon.reply_received`, `daemon.resume_result`, `daemon.event_done`
- `launchd.install_ok`, `launchd.uninstall_ok`
