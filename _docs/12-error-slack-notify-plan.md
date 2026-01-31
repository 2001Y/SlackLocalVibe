# エラー時Slack通知対応計画

更新日: 2026-01-31

## 目的
- エラー時に「ログの場所」をSlackへ通知する（可能な範囲で必須）。
- 失敗は隠さずエラーで顕在化し、完全ログ主義を守る。

## 対象範囲
- `notify` / `daemon` / `wizard` / `launchd` / `resume` / `config` / `route-store` / Slack API
- DMのみ（Socket Mode）

## 前提
- Slack APIは最大2回までリトライ。
- トークン/本文はログに出さない。
- 失敗時フォールバックで成功扱いにしない。

## 通知先のルール（最小）
1. **文脈あり**（daemonが受けたスレッド返信）: そのスレッドへ返信
2. **文脈なし**（起動失敗/設定不備/内部例外）: `destinations.dm` のDMへ通知
3. **Slack通知不可**（トークン不備/ネットワーク断/Slack API失敗）: ログに理由を必ず記録

## エラー面の洗い出し（phase）
- config: 設定ファイルの存在/JSON解析/必須キー不足
- input/parse: notify入力JSON/daemonイベントの欠落
- slack-api: conversations.open/chat.postMessage失敗
- route: routes.jsonl の未検出/不正
- resume: CLI実行失敗/exit非0/長文引数制限
- daemon-start: Socket Mode起動失敗/接続エラー
- log-io: ログファイル作成/書込失敗
- internal: 想定外例外

## Slack通知の共通要素（本文に含める最小情報）
- 相関ID（cid）
- phase
- duration_ms
- log paths（notify/daemon/wizard）
- 安全なメタ情報（tool/session_id/turn_id 等。本文は出さない）

## 実装ステップ（計画）
1. **現状のエラー経路を棚卸し**
   - `src/commands/notify.js` / `src/commands/daemon.js` を中心にエラー経路を列挙し、phaseにマッピング。
2. **通知メッセージの形式を統一**
   - `buildErrorNotice({cid, phase, duration_ms, logPaths, meta})` を `src/lib/messages.js` などに追加（抽象は最小）。
3. **notify側のエラー通知強化**
   - config/parse/Slack API失敗の全経路で「ログの場所」投稿を試行。
   - DMチャネル解決不可やtoken不備の場合はログに明記して終了。
4. **daemon側のエラー通知強化**
   - 既存のスレッド返信エラー文面に `cid/phase/log` を追加。
   - 返信失敗（Slack API失敗）の場合はDMへ通知を試行し、失敗理由をログ化。
5. **起動時・致命例外の扱い**
   - `uncaughtException` / `unhandledRejection` をハンドリングし、可能ならDMへ通知した上で非ゼロ終了。
6. **ログ粒度の補強**
   - phase/cid/durationを必須化し、入力/分岐/外部I/O/出力を追跡可能にする。
7. **テスト/検証**
   - 失敗系ケース（invalid_auth / target_user_id未設定 / routes欠落 / resume失敗 / Socket Mode失敗）を手動検証。

## 「全てのエラーに対応できるか」
**100%は不可。**
- Slack自体の障害/ネットワーク断/トークン不備/設定破損/プロセスの即時クラッシュは通知できない。
- その場合はログに必ず理由を残し、エラーとして終了させる。

