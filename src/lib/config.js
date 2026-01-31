const fs = require("fs");
const path = require("path");
const { configPath, configDir } = require("./paths");

function loadConfig() {
  const filePath = configPath();
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (error) {
    const err = new Error(`設定ファイルのJSON解析に失敗しました: ${filePath}`);
    err.cause = error;
    throw err;
  }
}

function writeConfig(config) {
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true });
  const filePath = configPath();
  backupFileIfExists(filePath);
  fs.writeFileSync(filePath, JSON.stringify(config, null, 2), "utf8");
  try {
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    const err = new Error(`設定ファイルの権限変更に失敗しました: ${filePath}`);
    err.cause = error;
    throw err;
  }
}

function backupFileIfExists(filePath) {
  if (!fs.existsSync(filePath)) return;
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${filePath}.bak-${timestamp}`;
  fs.copyFileSync(filePath, backupPath);
}

function normalizeConfig(config) {
  const normalized = {
    slack: {
      bot_token: config?.slack?.bot_token || "",
      app_token: config?.slack?.app_token || "",
    },
    destinations: {
      dm: {
        enabled: Boolean(config?.destinations?.dm?.enabled),
        target_user_id: config?.destinations?.dm?.target_user_id || "",
      },
    },
    features: {
      reply_resume: Boolean(config?.features?.reply_resume),
      launchd_enabled: Boolean(config?.features?.launchd_enabled),
    },
  };

  if (!normalized.features.reply_resume) {
    normalized.features.launchd_enabled = false;
  }

  return normalized;
}

function assertNotifyConfig(config) {
  if (!config?.slack?.bot_token) {
    throw new Error("slack.bot_token が未設定です。");
  }
  const dmEnabled = Boolean(config?.destinations?.dm?.enabled);
  if (!dmEnabled) {
    throw new Error("destinations.dm.enabled が false のため通知できません。");
  }
  if (!config?.destinations?.dm?.target_user_id) {
    throw new Error("destinations.dm.target_user_id が未設定です。");
  }
}

function assertDaemonConfig(config) {
  if (!config?.slack?.bot_token) {
    throw new Error("slack.bot_token が未設定です。");
  }
  if (!config?.slack?.app_token) {
    throw new Error("slack.app_token が未設定です。");
  }
  if (!config?.features?.reply_resume) {
    throw new Error("features.reply_resume が false のため daemon を起動できません。");
  }
}

module.exports = {
  loadConfig,
  writeConfig,
  backupFileIfExists,
  normalizeConfig,
  assertNotifyConfig,
  assertDaemonConfig,
  configPath,
  configDir,
};
