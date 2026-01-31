const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync } = require("child_process");

function homeDir() {
  return os.homedir();
}

function configDir() {
  return path.join(homeDir(), ".config", "slacklocalvibe");
}

function configPath() {
  return path.join(configDir(), "config.json");
}

function routesPath() {
  return path.join(configDir(), "routes.jsonl");
}

function logsDir() {
  return path.join(homeDir(), "Library", "Logs", "slacklocalvibe");
}

function notifyLogPath() {
  return path.join(logsDir(), "notify.log");
}

function daemonLogPath() {
  return path.join(logsDir(), "daemon.log");
}

function wizardLogPath() {
  return path.join(logsDir(), "wizard.log");
}

function launchAgentsDir() {
  return path.join(homeDir(), "Library", "LaunchAgents");
}

function launchdPlistPath() {
  return path.join(launchAgentsDir(), "dev.slacklocalvibe.daemon.plist");
}

function defaultPathEnv() {
  return process.env.PATH || "";
}

module.exports = {
  homeDir,
  configDir,
  configPath,
  routesPath,
  logsDir,
  notifyLogPath,
  daemonLogPath,
  wizardLogPath,
  launchAgentsDir,
  launchdPlistPath,
  defaultPathEnv,
  resolveCommandPathStrict,
};

function resolveCommandPathStrict(command, { allowNpx = false, optional = false } = {}) {
  const pathEnv = process.env.PATH || "";
  const result = spawnSync("command", ["-v", command], {
    encoding: "utf8",
    shell: false,
    env: { ...process.env, PATH: pathEnv },
  });
  if (result.status !== 0) {
    if (optional) return "";
    const err = new Error(`コマンドが見つかりません: ${command}`);
    err.detail = (result.stderr || "").toString("utf8").trim();
    throw err;
  }
  const resolved = (result.stdout || "").toString("utf8").trim();
  if (!resolved) {
    if (optional) return "";
    throw new Error(`コマンドのパス解決に失敗しました: ${command}`);
  }
  if (!allowNpx && resolved.includes("/.npm/_npx/")) {
    if (optional) return "";
    throw new Error(`npx 由来のパスは許可しません: ${resolved}`);
  }
  return resolved;
}
