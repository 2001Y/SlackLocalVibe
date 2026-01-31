# 調査で見つかった追加要件候補

- npm レジストリ公開が前提（グローバル固定）のため、公開反映/更新運用を本番検証する。
- launchd 登録時の `status=5 / Input/output error` 自動リトライは暫定対応のため、原因特定と恒久対応が必要。
- **Slack親メッセージが内部プロンプトで汚染される問題**  
  - Codex: **rollout JSONL の `event_msg.user_message` 採用 + タイトル生成テンプレ文言のフィルタで抑止**  
    - ただし **文言変更が入ると再発する可能性がある**  
  - Claude: Stop + transcript 由来の「最後の user」が内部タスク文を拾う可能性あり（未解決）
  - 理想解は「入力時に prompt を確定保存する」方式（PromptLedger）
