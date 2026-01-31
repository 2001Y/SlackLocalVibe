# Prompt取得の正・誤（Slack親メッセージ問題）

更新日: 2026-01-30

## 結論（ベストプラクティス）

- **「ユーザーの本当の入力」は、入力された瞬間に取得して保存するのが唯一の正解。**
- **transcript / notify payload から逆算してはいけない。**
  - 内部タスクや補助プロンプトが混ざるため、決定的に判別できない。

この原則を Codex / Claude の両方に適用して「最小差分」で統一する。

## 現状の設計（本リポジトリ）

- Claude: Stop hook + transcript_path から「最後の user」を抽出
- Codex: **rollout JSONL の `event_msg.user_message` を採用**（`input-messages` はメタのみ）  
  - ただし **内部タスク混入のため文言フィルタで除外**する

## 一次情報メモ（公式ドキュメント）

- Claude Code hooks:
  - `UserPromptSubmit` はユーザーがプロンプトを送信したタイミングのイベント
  - `Stop` はターン終了イベントで、`stop_hook_active` を含む
  - 公式: https://docs.anthropic.com/en/docs/claude-code/hooks
- Codex CLI notify:
  - `agent-turn-complete` の notify payload には `input-messages` / `last-assistant-message` などが含まれる
  - 公式: https://platform.openai.com/docs/codex/config-advanced
- Codex App Server:
  - `turn/start` の input を送るため、**入力時に正しい prompt を確定保存できる**
  - 公式: https://platform.openai.com/docs/codex/app-server

## ベストプラクティス（理想解）

**PromptLedger（共通コンポーネント）を導入する。**

- 保存キー
  - Claude: `session_id`
  - Codex: `thread-id`（notify payload の thread id）
- 保存内容
  - `prompt`（ユーザーが送信した瞬間の文字列のみ）
  - `ts` / `seq` / `source`（任意）

### Claude（決定版）

- `UserPromptSubmit` の `prompt` を **PromptLedger に保存**
- `Stop` では **PromptLedger から 1 件だけ pop して親メッセージに使用**
- transcript の参照は不要（廃止）

### Codex（理想解）

Codex CLI notify には **ユーザー入力のみを保証するフィールドが存在しない**ため、  
Slack親メッセージを「notify payloadだけで抽出する」設計は決定的に破綻する。

**正解は「入力時に prompt を確定保存できる実行経路」へ移行すること。**

- 推奨: Codex App Server / SDK で **turn/start の input を自前で保存**
- どうしても CLI notify を使う場合:
  - internal タスクの実行経路を分離し、SlackLocalVibe の notify が走らないようにする
  - （ただしこれは運用対策であり、データとしての“正”は App Server/SDK のほう）

## 現実解（CLI内で完結する実装）

PromptLedger を導入できない運用条件のため、**rollout JSONL の `event_msg.user_message` を正として採用**する。  
`input-messages` は内部タスク混入が避けられないため、本文抽出には使わない。  
さらに **タイトル生成テンプレート文言に一致する場合は SKIP** する。

## 「一時期動作していた」理由の可能性

- 以前は内部タスク（タイトル生成等）を同一セッションで走らせていなかった
- CLI / hooks の運用が変わり、内部タスクが notify / Stop の対象になった

## 次にやるべきこと

1) Claude: UserPromptSubmit の保存実装に切替（Stop は ledger 利用のみ）
2) Codex: App Server / SDK への移行を検討し、Slack親メッセージの正を確保
