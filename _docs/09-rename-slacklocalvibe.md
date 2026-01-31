# SlackLocalVibe リネーム完了チェックリスト

## 目的
旧名称から `SlackLocalVibe` へ統一した後の**確認用チェックリスト**と、既存ユーザー向けの**移行ポイント**をまとめる。

## 統一ルール（最終形）
- CLI/ファイルシステム向け: `slacklocalvibe`（小文字）
- ユーザー向け表示: `SlackLocalVibe`（CamelCase）

## 変更済みであるべき対象
**パッケージ & npm メタデータ**
- `package.json` / `package-lock.json`
  - `name: slacklocalvibe`
  - `bin: { slacklocalvibe: "src/cli.js" }`

**CLI 実装**
- `src/cli.js`: `.name("slacklocalvibe")` と `SlackLocalVibe` 表記
- `src/commands/wizard.js`: manifest / 表示文 / コマンド例が新名称
- `src/lib/messages.js`: 通知スレッド名が `SlackLocalVibe`
- `src/lib/paths.js`: 設定/ログ/launchd のパスが `slacklocalvibe`
- `src/lib/user-config.js`: Codex/Claude のコマンドが `slacklocalvibe ...`
- `src/lib/launchd.js`: binary/label が `slacklocalvibe`

**ドキュメント**
- `_docs/01-specification.md` ～ `_docs/08-test-plan.md` の表記が新名称
- `_docs/09-rename-slacklocalvibe.md` に本チェックリストを維持

## 既存ユーザー向け移行ポイント（手動）
- 旧設定ディレクトリを新名称へ移行
- 旧ログディレクトリを新名称へ移行
- 旧 launchd 登録を解除し、新名称で再登録

## 最終確認（必須）
- `rg -n "slacklocalvibe"` で一貫性を目視確認
- `rg -n "SlackLocalVibe"` で表示名が統一されていることを確認
- 旧名称がリポジトリ内に残っていないことを確認
