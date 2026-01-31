# SlackLocalVibe セットアップ仕様（macOS / Socket Mode / 通知必須・返信推奨）

本書は `SlackLocalVibe` の対話型セットアップ仕様です（配布ターゲットはmacOS）。  
ユーザーが叩くコマンドは **`npx slacklocalvibe` のみ** とします（初回セットアップ起動）。  
ウィザード内で `npm i -g slacklocalvibe` を実行し、以降の返信/常駐はグローバルコマンドを使います。

本パッケージの主機能は以下です（送信者は常にBot）：

- **通知**：Codex CLI の `notify` / Claude Code の hook から `slacklocalvibe notify` を呼び出し、**ターン完了をSlackへ通知**する（必須）
- **返信→resume**：Slackの**通知スレッドへの返信（DM内）**を次の入力として扱い、対応CLIセッションへ `resume` 実行する（機能として必須、ウィザードでも必須）
- **起動方法の前提**：ウィザード起動は `npx slacklocalvibe`。`notify` / `daemon` / `launchd` は **グローバル固定**で起動する
- **チャンネルは対象外**：通知/受信ともに **DMのみ** を対象とする

## 前提と方針

- **対象OS**：macOS
- **Slack受信方式**：Socket Mode 前提（Events APIのHTTP公開はしない）
- **通知機能**：必須（ウィザードでスキップ不可、DM送信先は必須）
- **通知テスト**：必須（成功しない限り「完了」できない。ユーザーは「中断」できる）
- **返信対応（受信）**：必須（ウィザードで必ず設定する）
- **二重resume対策**：**本パッケージでは実装しない**（CLI側で解決）
- **常駐登録（launchd）**：推奨（スキップ可。返信対応を使う場合のみ提示）
  - 常駐しない場合、返信を使うときは毎回 `slacklocalvibe daemon` を手動起動が必要な旨を明記
  - daemonは待ち受け中心で、アイドル時の負荷は小さい旨を明記
- **UI**：すべて矢印選択（↑↓）で統一
  - Yes/Noも「有効にする / いまはしない」の選択式
- **OAuthログインで自動連携**はしない（代わりに取得導線を最短にする：URL提示＋Enterでブラウザ起動）
- **Slack App作成は manifest を推奨**（コピペで再現性を担保）

## Slack App 前提（最小構成 / DMのみ）

### 通知（必須）に必要なもの

- Bot User OAuth Token：`xoxb-...`（以下「OAuth Tokens」）
- OAuth Tokens Scopes（少なくとも）：
  - `chat:write`
  - `im:write`（DM開始のため `conversations.open` を使う）
  - `im:history`（返信スレッド親の取得に必要）

### 返信対応（必須）に必要なもの

- Socket Mode を有効化
- App-Level Tokens：`xapp-...`
  - Scope：`connections:write`, `authorizations:read`, `app_configurations:read`

### 返信イベント（DMのみ）

- 返信は「通知（親）メッセージの**スレッド返信**」のみを対象とする
- 返信本文の取得は **`text` のみ**とし、`blocks`/添付/ファイルは対象外とする
- 返信本文が空（空文字/空白のみ）の場合は**最優先で無視**する（他の判定より先）
- **グループDM（message.mpim）は対象外**

> NOTE: Slack管理画面の導線は UI 変更があり得るため、ウィザード内では「Slack Apps 新規作成を開く → manifest から作成 → 左メニューで該当項目へ」の最短手順を示す。

## Slack App 作成（From a manifest 推奨）

> **Socket Mode を使うため、公開HTTPの Request URL は不要**。  
> `Create New App → From a manifest` に貼り付けて作成する。

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

- manifest は **YAML** である

## ウィザードが開く（提示する）URL

ウィザードは必要に応じて、次のURLを「1発で開けるリンク」として提示し、Enterでブラウザを開ける。

- Slack Apps（新規作成ショートカット）：`https://api.slack.com/apps?new_app=1`

## `SlackLocalVibe` 対話フロー（固定シーケンス）

> 重要：本ウィザードは「開始したら最後まで流れる」構成とし、途中でスキップできるのは **任意機能のみ**。  
> 通知セットアップ（App-Level Tokens / OAuth Tokens 入力）はスキップ不可。

### 0. イントロ（開始）

- 目的を表示
- 既存設定があれば読み込んで「上書き/更新」になる旨を表示
- 途中で「終了」を選んだ場合は **保存せずに終了**する旨を明記
- 以降、選択UIの操作方法（↑↓ / Enter）を1画面で説明

### 1. 対応CLIの選択（必須）

- 対応したいCLI（Codex / Claude）を選択する
- デフォルトは両方選択
- 少なくとも1つ選択必須

### 2. DM送信先の設定（最初・必須）

- `TARGET_USER_ID (U...)`（DMの相手。通常はあなたのユーザーID）を入力  
  - **指定方法**：ユーザーID（`U...`）のみ保存し、送信時に `conversations.open(users=<U...>)` で DM チャンネルID（`D...`）を解決してから `chat.postMessage(channel=<D...>)` で投稿する（`channel=U...` 直指定は Slack 側の挙動差異があるため使わない）
  - **注意**：アプリを追加したユーザーIDを自動採用しない。DM送信先は明示的に指定する
（送信先は必須）

保存

- `destinations.dm.target_user_id`
- `destinations.dm.enabled` は **必須**（未設定は `false` 扱い）

### 3. Slack Apps 新規作成（manifest）

- manifest をクリップボードにコピーする
- Slack Apps 新規作成で「From a manifest（YAML）」を選び、貼り付けて作成する

### 4. App-Level Tokens 入力（必須）

- 画面上に「App-Level Tokens（xapp-...）」入力を要求（入力済み表示のみ）
- 入力ガイドとして「Basic Information → App-Level Tokens」を表示する

### 5. OAuth Tokens 入力（必須）

- 画面上に「OAuth Tokens（xoxb-...）」入力を要求（入力済み表示のみ）
- 入力ガイドとして「Slack Apps → 対象アプリ → OAuth & Permissions → OAuth Tokens」を表示する

### 6. 通知テスト & 到達確認（必須）

- **必須**（このステップはスキップできない）
- ウィザードは設定済みの送信先へテスト通知を送信する
- 送信後に「Slack通知は届きましたか？」を確認し、届いていない場合はログを表示できる
- 失敗した場合は、その場で原因候補を提示し、以下を選択できる（矢印選択）
  - OAuth Tokens を再入力する
  - 送信先設定（DM）を見直す
  - 終了する（※この時点では**保存せずに終了**する旨を明記）
- 典型エラー（invalid_auth など）のヒントを表示し、再入力へ戻れる

### 7. ユーザーレイヤー設定（通知直後に実施）

> 要望：Codex notify / Claude hooks を「貼り付け手順」ではなく、**ユーザー設定としてウィザードが反映**する。  
> プロジェクト単位（リポジトリ内）の設定はスコープ外とし、必要に応じてユーザーが手動対応する。

選択（カーソルでそれぞれ）

- Codex（ユーザー設定）を設定する / いまはしない
- Claude Code（ユーザー設定）を設定する / いまはしない

デフォルト（自動判定）

- **既存の設定ファイルが見つかったCLIはデフォルトON**（ユーザーが最終確定する）
  - Codex: `~/.codex/config.toml`（または `CODEX_HOME/config.toml`）
  - Claude: `~/.claude/settings.json`

実施内容（例：実装側で検出・バックアップを行う）

- Codex：`~/.codex/config.toml`（`CODEX_HOME` が設定されている場合は `CODEX_HOME/config.toml`）を読み取り、**該当キー（notify）だけ**を更新して、ターン完了で `slacklocalvibe notify --tool codex` を起動する  
  - 他の設定は保持する（全体上書きはしない）
- Claude Code：`~/.claude/settings.json` を読み取り、**該当箇所（Stop hook）だけ**を更新して、Stop hook で `slacklocalvibe notify --tool claude` を起動する  
  - 他の設定は保持する（全体上書きはしない）
- 設定ファイルの読込/更新に失敗した場合は**エラー扱い**（フォールバックせず、失敗を明示する）
  - その場で矢印選択により「再試行 / 終了（保存せず）」を提示する

表示（必ず）

- 「プロジェクト単位の設定（例：リポジトリ直下の設定）は対象外。必要なら手動で反映してください」
- 「Claude Code のプロジェクト設定は `.claude/settings.json` / `.claude/settings.local.json`（リポジトリ直下）で、ここは対象外」

### 8. Slack からの返信に対応します

- Slack からの返信を受け取るため `slacklocalvibe` コマンドが必要
- **必須**：`npm i -g slacklocalvibe` をウィザード内で実行

### 9. CLI完了時のSlack通知をテストします（返信対応）

> 返信対応は必須。Slackから返信して次の入力として実行する。

#### 9.1 事前チェックの説明（画面でチェックリスト）

- Slack App で Socket Mode が有効
- App-Level Tokens（xapp-...）を発行済み（ウィザードで入力済み）
- Event Subscriptions（bot events）で以下を購読し、**DM返信**を受け取れる状態になっている：
  - `message.im`
- App Home の Messages タブが有効になっている

（注）設定名や導線はSlackのUI変更で変わり得るため、ウィザードでは「該当設定へ到達するための最短導線」を優先して説明する。

#### 9.2 本番同等テスト（推奨 / 最終ステップ）

テストは **本番と同じ経路**で行う。  
有効化したCLIにテストメッセージを新規送信し、hooks経由でSlack通知が届くことを確認する。

- ウィザードが**有効化したCLIへテストプロンプトを送信**する
- hooksで **Slackに通知（親）が投稿**される
- ユーザーはその通知スレッドに返信し、`resume` が動くことを確認する
- 失敗時は原因候補（Socket Mode未ON / token違い / イベント購読未設定）を表示

前提（必須）

- **`slacklocalvibe daemon` はウィザードがバックグラウンド起動する**（失敗時は手動で起動）

**固定プロンプト（テスト実行用）**  
「あなたは誰？」

**実行コマンド（有効化したCLIに応じて）**

- Codex: `codex exec "あなたは誰？"`
- Claude: `claude -p "あなたは誰？"`

#### 9.3 通知の確認（必須）

- 「Slack通知は届きましたか？」を確認してから次へ進む
- 「届いていないのでログを表示する」を選んだ場合はログを表示する
  - `~/Library/Logs/slacklocalvibe/notify.log`
  - `~/Library/Logs/slacklocalvibe/daemon.log`
  - `~/Library/Logs/slacklocalvibe/wizard.log`

### 10. Slack スレッドに返信してみよう

- 通知スレッドに返信して `resume` が動くことを確認する
- 例: 「あなたはなにができる？」
- 確認できたら「resume結果が新しいスレッドで届いた」を選択
- 届かない場合はログを表示できる

### 11. 常駐登録（任意・推奨）

> **返信対応を「有効」にした場合にのみ実施する**（返信OFFなら本ステップ自体を出さない）。

最初に「登録する / スキップ / 終了」を選べる。登録を選んだ場合は **npm i -g で最新を反映**し、**一度 uninstall を試してから** launchd 登録を試みる。失敗時のみ以下を提示する：

- 再試行
- スキップして次へ進む
- 終了

登録時の動作：

- `~/Library/LaunchAgents/` に plist を生成し、`launchctl bootstrap` する（モダンmacOS前提）
- launchd/launchctl による管理である旨を表示
- 後からの削除（完全アンインストール）は `slacklocalvibe launchd uninstall` で行える旨を表示（モダンmacOS前提）

補足：

- daemonは通常は待ち受け中心で、アイドル時のCPU/メモリ消費は小さい（常駐コストは低い）

### 12. 完了サマリ

- 送信先：DM（値はマスクまたは末尾だけ表示）
- 通知：ON（OAuth Tokens設定済み）
- ユーザー設定：Codex / Claude の反映状況
- 返信：ON/OFF（OFFの場合でも、**推奨**である旨を表示）
- 常駐：ON/OFF
- 次にやること：
  - 通知が来ることを確認（Codex/Claudeで1ターン回す）
  - 返信ONの場合：Slackで返信してresumeが動くことを確認  
  - 重要注意：**CLIに戻って再開したい場合は、CLI側をいったん終了してからresumeし直す**（競合を避ける）

## 保存する設定（例）

保存先（例）

- `~/.config/slacklocalvibe/config.json`（パーミッション 600 推奨）

例（概略）

```json
{
  "slack": {
    "bot_token": "xoxb-***",
    "app_token": "xapp-***"
  },
  "destinations": {
    "dm": { "enabled": true, "target_user_id": "U..." }
  },
  "features": {
    "reply_resume": false,
    "launchd_enabled": false
  }
}
```

## 実装メモ（UI/挙動）

- 対話UI：`prompts` / `inquirer` / `@clack/prompts` 等の矢印選択UIを使用
- トークン入力は画面に表示するが、ログには残さない
- 設定ファイル更新は必ずバックアップ（上書き前に `*.bak`）
- Socket ModeはBolt等のSDKでWebSocket受信する
- Slack API 呼び出しは**最大2回までリトライ**する（失敗は明示する）
- 分割投稿で整形が崩れることは許容（本文の欠落回避を優先）

## 重要：notifyが投稿する親メッセージのルール（ウィザードから明記）

- 親メッセージ送信時に **route 情報をローカルに保存**する（`~/.config/slacklocalvibe/routes.jsonl`）
  - 保存項目：`channel`, `thread_ts`, `tool`, `session_id`, `turn_id?`, `ts`
  - daemon は返信イベントの `thread_ts` からローカル保存を検索して `resume` を実行する
- **親メッセージは当初のユーザーメッセージ**を投稿する（新規スレッドの親）。  
  - **AIの完了レスポンス本文は必ずスレッド返信へ分割投稿**する（切り捨てをしない。詳細は要件/設計書に従う）
