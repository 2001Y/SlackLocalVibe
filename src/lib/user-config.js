const fs = require("fs");
const path = require("path");
const toml = require("@iarna/toml");
const { backupFileIfExists } = require("./config");
const { homeDir } = require("./paths");

const CODEX_NOTIFY_COMMAND = [
  "slacklocalvibe",
  "notify",
  "--tool",
  "codex",
];

const CLAUDE_NOTIFY_COMMAND = "slacklocalvibe notify --tool claude";

function codexConfigPath() {
  const base = process.env.CODEX_HOME || path.join(homeDir(), ".codex");
  return path.join(base, "config.toml");
}

function claudeSettingsPath() {
  return path.join(homeDir(), ".claude", "settings.json");
}

function updateCodexNotify() {
  const filePath = codexConfigPath();
  if (!fs.existsSync(filePath)) {
    throw new Error(`Codex設定ファイルが見つかりません: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = toml.parse(raw);
  parsed.notify = CODEX_NOTIFY_COMMAND;
  backupFileIfExists(filePath);
  fs.writeFileSync(filePath, toml.stringify(parsed), "utf8");
}

function updateClaudeStopHook() {
  const filePath = claudeSettingsPath();
  if (!fs.existsSync(filePath)) {
    throw new Error(`Claude設定ファイルが見つかりません: ${filePath}`);
  }
  const raw = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(raw);
  if (parsed.hooks && typeof parsed.hooks !== "object") {
    throw new Error("Claude settings.json の hooks が不正な型です。");
  }
  parsed.hooks = parsed.hooks || {};

  const stopHooks = parsed.hooks.Stop;
  if (stopHooks && !Array.isArray(stopHooks)) {
    throw new Error("Claude settings.json の hooks.Stop が配列ではありません。");
  }

  const newHook = { type: "command", command: CLAUDE_NOTIFY_COMMAND };

  if (!Array.isArray(parsed.hooks.Stop) || parsed.hooks.Stop.length === 0) {
    parsed.hooks.Stop = [{ hooks: [newHook] }];
  } else {
    let inserted = false;
    for (const pipeline of parsed.hooks.Stop) {
      if (!pipeline || typeof pipeline !== "object") continue;
      if (!Array.isArray(pipeline.hooks)) {
        pipeline.hooks = [];
      }
      const exists = pipeline.hooks.some(
        (hook) => hook?.type === "command" && hook?.command === CLAUDE_NOTIFY_COMMAND
      );
      if (!exists) {
        pipeline.hooks.push(newHook);
      }
      inserted = true;
      break;
    }
    if (!inserted) {
      parsed.hooks.Stop.push({ hooks: [newHook] });
    }
  }

  backupFileIfExists(filePath);
  fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), "utf8");
}

module.exports = {
  CODEX_NOTIFY_COMMAND,
  CLAUDE_NOTIFY_COMMAND,
  codexConfigPath,
  claudeSettingsPath,
  updateCodexNotify,
  updateClaudeStopHook,
};
