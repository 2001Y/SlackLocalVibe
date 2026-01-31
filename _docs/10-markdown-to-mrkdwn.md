# Markdown -> mrkdwn 変換調査（marked + html-to-mrkdwn）

## 目的
Slack の mrkdwn へ変換するために Markdown -> HTML -> mrkdwn のパイプラインを採用する。

## 採用候補
- marked: Markdown -> HTML
- html-to-mrkdwn: HTML -> Slack mrkdwn

## 仕様メモ
- marked は `marked.parse(markdownString)` で HTML を生成する。
- marked は HTML をサニタイズしないため、必要なら別途 sanitize を行う。
- html-to-mrkdwn は HTML 文字列を渡すと `{ text, image }` を返す。

## 実装方針
- `marked.parse` の結果を `html-to-mrkdwn` に渡し、`text` を Slack 送信用本文に採用する。
- 変換失敗はエラーとして扱い、フォールバックしない。
