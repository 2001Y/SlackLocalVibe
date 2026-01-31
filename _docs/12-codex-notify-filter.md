# Codex notify フィルタ設計（rollout JSONL）

更新日: 2026-01-31

## 目的

Codex CLI の `notify` が **内部タスクの完了**まで拾ってしまう問題に対し、  
**CLIで確実に「人間が入力したプロンプト」を拾うための設計**を示す。

## 公式前提

`notify` が受け取れるのは `agent-turn-complete` の payload のみ。  
payload には `input-messages` / `thread-id` / `turn-id` などが含まれる。

一方、Codex CLI は **ローカルに rollout JSONL を保存**しており、  
そこには `event_msg` → `user_message` が記録される。

対象パス: `~/.codex/sessions/**/rollout-*.jsonl`

## 経緯（なぜこの実装になったか）

1) 旧実装は `input-messages` の最後を親本文に採用  
2) 内部タスク（タイトル生成など）が **同一セッションで実行される**ようになり、  
   `input-messages` に内部プロンプトが混入  
3) `input-messages` が空の場合のみ skip しても **内部プロンプトは除外できない**  
4) `notify.log` で Slack 親本文が **タイトル生成プロンプトになっている**ことを確認  
5) rollout JSONL の `event_msg.user_message` に **内部タスクのタイトル生成プロンプトも混入**することを確認  

→ よって、**`input-messages` ではなく rollout JSONL を正とする**実装へ切替  
　ただし **内部タスクは文言フィルタで除外**する

## フィルタ方針（決定版）

**rollout JSONL の `event_msg` → `user_message` を親本文の正とする。**
さらに、**内部タスク（タイトル生成プロンプト）の文言に一致する場合は通知しない**。

理由:
- `input-messages` は内部タスク混入の回避ができない
- `event_msg.user_message` は **実際にユーザーが入力した行**のみが記録される
- CLI notify だけで完結できる（別プロセスやDB不要）

## 実装要点

- `thread-id` から rollout JSONL を検索（ファイル名一致 → 内容一致の順）
- `event_msg` → `user_message` の **最新**を採用
- 内部タスクのテンプレ文言（JSONL 実測）に一致した場合は **SKIP**
- `input-messages` は **メタ情報のみ**としてログに残す
- rollout 未取得時は **`notify.user_text_missing` をエラー記録して通知しない**
- **重複抑止は行わない**（要望により）

## 内部タスク除外（タイトル生成プロンプト）

JSONL 実測で確認できた **タイトル生成テンプレート**をシグネチャ化し、  
下記条件を満たした場合は `codex_internal_title_prompt` として SKIP する。

- 先頭行が  
  `You are a helpful assistant. You will be presented with a user prompt`  
  で始まる
- さらに、以下の実測行のうち **3行以上**が含まれる
  - `Generate a concise UI title (18-36 characters) for this task.`
  - `Return only the title. No quotes or trailing punctuation.`
  - `Do not use markdown or formatting characters.`
  - `If the task includes a ticket reference (e.g. ABC-123), include it verbatim.`
  - `Generate a clear, informative task title based solely on the prompt provided. Follow the rules below to ensure consistency, readability, and usefulness.`
  - `How to write a good title:`
  - `Generate a single-line title that captures the question or core change requested. The title should be easy to scan and useful in changelogs or review queues.`
  - `By following these conventions, your titles will be readable, changelog-friendly, and helpful to both users and downstream tools.`
  - `Examples:`

## ログ指針（必須）

ログに残すべき項目:

- `codex_rollout_found` / `codex_rollout_source` / `codex_rollout_path`
- `codex_rollout_user_message_count` / `codex_rollout_line_count`
- `input-messages` の長さ / 内容有無
- 失敗時は `codex_rollout_error`
