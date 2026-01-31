# SlackLocalVibe セットアップ手順（コマンドは1つ / 画面操作込み）

このドキュメントは「**ユーザーが叩くコマンドは1つだけ（グローバル固定）**」という前提で、
CLI内の必須/推奨ステップ分岐と **Slack画面操作** をまとめたものです。

---

## 1. 叩くコマンドはこれだけ

```sh
npx slacklocalvibe
```

- ここから **対話ウィザード** が開始
- 必須は必ず通過、推奨はスキップ可（launchdのみ）
- 返信/常駐が必要な場合も、**ウィザード内で誘導**される

---

## 2. Slack画面操作（最短導線 / DMのみ / Socket Mode）

> UIは変更される可能性があるため、**最短の辿り方**を明記します。

### 2.1 Slack Apps 画面へ
- 新規作成ショートカット：`https://api.slack.com/apps?new_app=1`

### 2.2 アプリ作成（From a manifest 推奨）
1. **Create New App** → **From a manifest**
2. 下記 manifest を貼り付け
3. **Create** → Workspace を選択

- manifest は **YAML** です

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

- **Socket Mode なので Request URL は不要**

### 2.3 Basic Information（App-Level Tokens）
1. アプリ作成直後に表示される **Basic Information** ページの少し下に **App-Level Tokens** がある  
   - **App-Level Tokens のスコープは `connections:write` / `authorizations:read` / `app_configurations:read` を選択する**
   - `xapp-...` を発行して控える  
2. 次に **OAuth & Permissions** へ移動する

### 2.4 OAuth & Permissions（OAuth Tokens）
1. 左メニュー **Features > OAuth & Permissions**
2. **Install to Workspace**（または Reinstall）
3. **OAuth Tokens** を発行するのが目的（ここで OAuth Tokens が取得できる）
4. **Bot User OAuth Token（xoxb-...）** をコピー

### 2.4 Socket Mode（必須）
1. 左メニュー **Settings > Socket Mode** を **Enable**
2. **App-Level Tokens** を発行（`connections:write` / `authorizations:read` / `app_configurations:read`）
3. **App-Level Tokens（xapp-...）** をコピー

### 2.5 Event Subscriptions（必須）
1. 左メニュー **Features > Event Subscriptions** を **Enable**
2. **Subscribe to bot events** に以下を追加：
   - `message.im`
3. **Save Changes**

### 2.6 App Home（DM受信のため）
1. 左メニュー **Features > App Home**
2. **Messages Tab** を有効化

### 2.7 自分のユーザーID（DM先）を確認
- Slackプロフィール → **「メンバーIDをコピー」** で `U...` を取得

---

## 3. CLIウィザード内のステップ（必須/推奨の分岐）

> ここから先は **`npx slacklocalvibe` 内で説明**され、
> ユーザーが打つ追加コマンドはありません。

### 3.1 対応CLIの選択（必須）
- 対応したいCLI（Codex / Claude）を選択
- デフォルトは両方選択

### 3.2 DM送信先の設定（必須）
- DM先の `U...` を入力
- DM送信先は必須

### 3.3 Slack Apps 新規作成（manifest）
- manifest をクリップボードにコピー
- Slack Apps 新規作成で「From a manifest（YAML）」を選び、貼り付けて作成

### 3.4 App-Level Tokens 入力（必須）
- `xapp-...` を入力（入力済み表示のみ）
- 「Basic Information」で発行した App-Level Tokens を入力

### 3.5 OAuth Tokens 入力（必須）
- `xoxb-...` を入力（入力済み表示のみ）
- 「OAuth & Permissions」で発行した OAuth Tokens を入力

### 3.6 通知テスト & 到達確認（必須）
- 失敗時：
  - Token再入力
  - DM送信先見直し
  - 保存せず終了
- 送信後に「Slack通知は届きましたか？」を確認し、届いていない場合はログを表示

### 3.7 Codex / Claude 設定反映（推奨 / スキップ可）
- **既存の設定ファイルが見つかったCLIはデフォルトON**（ユーザーが最終確定）
- 必要なキーだけ更新（他は保持）
- 失敗は**即エラー**で明示（フォールバックしない）

### 3.8 Slack からの返信に対応します
- Slack からの返信を受け取るため `slacklocalvibe` コマンドが必要
- **必須**：`npm i -g slacklocalvibe` をウィザード内で実行（グローバル固定）

### 3.9 CLI完了時のSlack通知をテストします（返信対応）
- **Socket Mode / App-Level Tokens / Events / App Home** 設定済みをチェック
- **本番同等テスト（必須）**：
  - 有効化したCLIに**テストメッセージを新規送信**
  - hooksで **Slackに通知が届く**ことを確認
  - その通知スレッドに返信し、`resume` が動くことを確認

前提（必須）：
- **`slacklocalvibe daemon` はウィザードがバックグラウンド起動する**（失敗時は手動で起動）

テスト用プロンプト（固定）：
「【SlackLocalVibe 本番同等テスト】このメッセージはテスト実行です。」と言ってください

実行コマンド（有効化したCLIに応じて）：
- Codex: `codex exec "「【SlackLocalVibe 本番同等テスト】このメッセージはテスト実行です。」と言ってください"`
- Claude: `claude -p "「【SlackLocalVibe 本番同等テスト】このメッセージはテスト実行です。」と言ってください"`

### 3.10 Slack スレッドに返信してみよう
- 通知スレッドに返信して `resume` が動くことを確認する
- 例: 「あなたはなにができる？」
- 確認できたら「resume結果が新しいスレッドで届いた」を選択
- 届かない場合はログを表示できる

### 3.11 常駐（launchd）（推奨 / スキップ可）
- 返信対応は必須のため、このステップは常に表示
- 最初に「登録する / スキップ / 終了」を選択
- 登録を選んだ場合は **npm i -g で最新を反映**し、**一度 uninstall を試してから** launchd 登録を試みる
- 失敗時のみ「再試行 / スキップ / 終了」を提示
- daemon は待ち受け中心で、CPU/メモリ消費はごく小さい

---

## 4. CLI内で出る「必須 / 推奨」表示の目安

- **必須**
  - DM送信先設定
  - App-Level Tokens / OAuth Tokens 入力
  - 通知テスト & 到達確認（送信先ありの場合）

- **推奨（スキップ可）**
  - Codex / Claude 設定反映
  - launchd 常駐

---

## 5. ログの場所（問題を隠さない）

- `~/Library/Logs/slacklocalvibe/notify.log`
- `~/Library/Logs/slacklocalvibe/daemon.log`

トークンや本文の生ログは出さず、**成功/失敗**を必ず記録。

---

## 6. 迷ったらこれだけ覚える

- **コマンドは1つ**：`npx slacklocalvibe`
- Slackの画面操作は **OAuth / Socket / Events / App Home** を押さえる
- 必須は止まらない。推奨（launchd）は**スキップできる**が後で再実行可能
