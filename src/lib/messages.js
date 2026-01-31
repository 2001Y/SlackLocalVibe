function quoteShell(value) {
  const text = String(value ?? "");
  if (!text) return "''";
  if (/^[A-Za-z0-9_./:-]+$/.test(text)) return text;
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function buildResumeCommand({ tool, sessionId, cwd }) {
  const safeSession = quoteShell(sessionId || "");
  if (tool === "codex") {
    const parts = [
      "codex",
      "exec",
      "--skip-git-repo-check",
      "resume",
      safeSession,
      "-",
    ];
    const command = parts.join(" ");
    if (cwd) {
      return `cd ${quoteShell(cwd)} && ${command}`;
    }
    return command;
  }
  const command = `claude -r ${safeSession}`;
  if (cwd) {
    return `cd ${quoteShell(cwd)} && ${command}`;
  }
  return command;
}

function buildReplyReceivedMessage({ tool, sessionId, cwd }) {
  const resumeCommand = buildResumeCommand({ tool, sessionId, cwd });
  return [
    "返信を受領しました。",
    "これを `resume` として実行しました。結果は新規スレッドが作成されます。",
    `CLI再開：\`${resumeCommand}\``,
    "VSCode拡張機能など：ウィンドウ再読込など",
  ].join("\n");
}

const REPLY_INVALID_MESSAGE =
  "この返信は `SlackLocalVibe` の通知スレッドとして認識できませんでした（route 情報が見つからない/不正）。\n" +
  "**通知（親）メッセージ**に対してスレッド返信してください。\n" +
  "（補足：このスレッドでは `resume` は実行しません）";

const RESUME_FAILED_MESSAGE =
  "`resume` の実行に失敗しました。\n" +
  "詳細はCLIログをご確認ください。";

const TEST_PROMPT = "あなたは誰？";

module.exports = {
  buildReplyReceivedMessage,
  REPLY_INVALID_MESSAGE,
  RESUME_FAILED_MESSAGE,
  TEST_PROMPT,
};
