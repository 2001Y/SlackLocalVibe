# 調査メモ（一次情報/仕様確認）

更新日: 2026-01-28

## 1. Slack API（DM 送信 / ルーティング）

- DM 送信前に `conversations.open(users=<U...>)` で **DM channel ID（D...）** を取得する。  
- ルーティングは Slack metadata ではなく **ローカル route ストア（routes.jsonl）** を正とする。  

一次情報:
- conversations.open: https://api.slack.com/methods/conversations.open  

## 2. Slack Socket Mode（Node）

- Socket Mode クライアントは `SocketModeClient` を利用し、`on("message", ...)` などのイベントで受信できる。  
- イベントハンドラ内で `ack()` を返す例が公式 README にある。  

一次情報:
- @slack/socket-mode README（unpkg）: https://unpkg.com/@slack/socket-mode/README.md  

## 3. Codex CLI（notify / config）

- `notify` は外部コマンドを配列で指定でき、**最後の引数にJSONが渡される**。  
- `CODEX_HOME` が設定されている場合は `CODEX_HOME/config.toml` が優先される。  

一次情報:
- Codex advanced config（notify）: https://platform.openai.com/docs/codex/advanced-config  
- Codex config reference: https://platform.openai.com/docs/codex/config  

## 4. Claude Code（Hooks / CLI）

- `Stop` hook の入力に `stop_hook_active` が含まれる（無限ループ防止判定が必要）。  
- CLI の resume は `claude -r <SESSION_ID> [PROMPT]`。  

一次情報:
- Claude Code hooks: https://docs.anthropic.com/en/docs/claude-code/hooks  
- Claude Code CLI reference: https://docs.anthropic.com/en/docs/claude-code/cli-reference  

## 5. Context7

- `@slack/socket-mode` を resolve したが該当ライブラリが見つからず。  
  → 公式 README と Slack公式ドキュメントを一次情報として使用。  

## 6. o3MCP 相談サマリ（要点）

- ACK を **即時**に返し、重い処理は ACK 後に実行する。  
- route ストアの厳格検証（tool / session_id / thread_ts）。  
- `claude` の argv 長制限で失敗するため、**長文は明示エラー**扱い。  
- launchd は PATH が狭いので絶対パス/環境変数を明示。  
- ログは JSON で、トークン/本文を出さない（長さのみ）。
