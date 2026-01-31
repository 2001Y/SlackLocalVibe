# 実装ポリシー（SlackLocalVibe）

本書は、`SlackLocalVibe` の実装が満たすべき「約束（ポリシー）」を高レベルに定義します。  
仕様詳細は `01-specification.md` / `03-requirements.md` / `04-design.md` を参照し、本書はそれらに矛盾しない形で実装判断の優先順位を与えます。

## 1. 目的

- Codex CLI / Claude Code のターン完了をSlackへ通知する
- 通知スレッドへの返信を、対応CLIセッションへの次入力として `resume` 実行する

## 2. 非目的（やらないこと）

- Slackの新規投稿をトリガーにした「新規セッション開始」
- 永続DB（RDB/Redis/SQLite）前提の状態管理
- 競合（同時実行・順序逆転・重複実行）の**完全防止**
- Events API（HTTP受信のRequest URL公開）前提の運用
- **チャンネル通知/受信**（DMのみを対象）

## 3. コマンド体系と責務（仕様書ベース）

- `slacklocalvibe`
  - 対話型セットアップ（**ユーザーが叩く唯一のコマンド**）
  - **通知は必須**、**返信も必須**
- `slacklocalvibe notify`
  - Codex/Claudeのhookから **`slacklocalvibe`** で呼ばれる想定
  - Slackへ **必ず新規親メッセージ**を投稿する
- `slacklocalvibe daemon`
  - Socket ModeでSlackイベントを受信し、通知スレッド返信を拾って `resume` を実行する
  - 返信（受信）は **npm（グローバル導入）** を前提にしてよい（常駐化はlaunchd等のmac依存で実装してよい）

## 4. 守るべき“安全ルール”（必須）

- **対象スレッド制限**：Bridgeが作成した通知スレッド以外の返信では `resume` を実行しない
- **ルーティング情報**：通知（親）送信時に `routes.jsonl` へ `channel` / `thread_ts` / `tool` / `session_id` を保存し、daemon が `thread_ts` で復元する
- **注意文は必須**：返信を受け付けて `resume` を実行する際、スレッドに必ず注意文（CLI終了→resumeし直し）を返す
- **受領は先に送る**：`resume` 実行前に受領メッセージを送り、`resume` 失敗時も受領後に失敗文言を返す
- **返信本文は text のみ**：`blocks`/添付/ファイルは無視し、subtype付きイベント（`message_changed`/`message_deleted` 等）は対象外
- **トークン秘匿**：xoxb/xappはログ・例外メッセージに出さない（入力は画面に表示されるが、保存・ログには残さない）
- **失敗は“連携だけ”に閉じる**：
  - notifyがSlack投稿に失敗しても、CLI本体を落とさない（exit 0など）
  - daemonが停止しても、CLIは通常利用できる（連携のみ影響）
  - notify/daemon の成功・失敗は、macOSのユーザーログへ必ず記録する（例：`~/Library/Logs/slacklocalvibe/notify.log` / `~/Library/Logs/slacklocalvibe/daemon.log`）
  - 送信先未設定はエラーとしてログに記録する
  - 受領/対象外/失敗の固定文言送信が失敗した場合も必ずログに残す
- **Claude resume の改行対応**：改行は `\n` に正規化して **単一引数**で渡す（切り捨て禁止）

## 5. 可用性・信頼性（best-effort）

Slackは重複配信し得るため、「完全防止」はしない／できない。その前提で事故率を下げる。

- **ACK最優先**：Slackへの応答（ACK）を遅らせない（再送を誘発しない）
- **重複排除/ロック**：同時実行対策（プロセス間ロック等）による完全防止はCLI側に任せ、本パッケージでは実装しない  
  - Slack Events の再送による重複対策も同様にCLI側で解決する

## 6. 文字数制限（統一ルール）

- Slack投稿は `MAX_TEXT=3800` を上限目安として扱う
- **AI本文は常にスレッド**に投稿し、超過時は **切り捨てず**、親メッセージのスレッドに分割投稿する（親は当初ユーザー入力）

## 7. mac依存範囲（明確化）

- **mac依存**：launchd/LaunchAgentsによるdaemon常駐化
- **それ以外**（通知/返信の中核ロジック）は、可能な限りOS依存を避ける（ただしmac以外の動作保証はしない）

## 8. 設定管理（統一）

- 原則すべて設定ファイル（例：`~/.config/slacklocalvibe/config.json`）で管理する
- 環境変数を前提にしない（ユーザー体験と再現性を優先）

## 9. 対象外スレッドへの挙動（統一）

- Bridge対象外（route 情報が見つからない）では `resume` を実行しない
- ただし、無反応でユーザーが迷わないよう **固定文言で説明を返信**する（設計書の固定文言に従う）
