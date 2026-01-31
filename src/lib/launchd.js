const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const {
  launchAgentsDir,
  launchdPlistPath,
  daemonLogPath,
  resolveCommandPathStrict,
} = require("./paths");

function buildDaemonPathEnv() {
  const parts = [];
  const add = (value) => {
    if (!value) return;
    const dir = value.trim();
    if (!dir) return;
    if (parts.includes(dir)) return;
    parts.push(dir);
  };
  add(path.dirname(process.execPath));
  const codexPath = resolveCommandPathStrict("codex", { optional: true });
  const claudePath = resolveCommandPathStrict("claude", { optional: true });
  add(codexPath ? path.dirname(codexPath) : "");
  add(claudePath ? path.dirname(claudePath) : "");
  return parts.join(":");
}

function installLaunchd({ cliPath } = {}) {
  const binaryPath = cliPath || resolveBinaryPath();
  if (!binaryPath) {
    throw new Error("slacklocalvibe の実行ファイルが見つかりません。");
  }

  uninstallLaunchd({ allowMissing: true });

  const plistPath = launchdPlistPath();
  fs.mkdirSync(launchAgentsDir(), { recursive: true });
  fs.writeFileSync(plistPath, buildPlist(binaryPath), "utf8");

  const uid = process.getuid();
  const label = "dev.slacklocalvibe.daemon";
  const launchctlPath = resolveCommandPathStrict("launchctl");
  let result = spawnSync(launchctlPath, ["bootstrap", `gui/${uid}`, plistPath], {
    stdio: "pipe",
    env: process.env,
  });

  if (result.status !== 0) {
    const stderrText = (result.stderr || "").toString("utf8").trim();
    const stdoutText = (result.stdout || "").toString("utf8").trim();
    const detail = stderrText || stdoutText || "";
    const shouldRetry =
      result.status === 5 ||
      /input\/output error/i.test(detail);
    if (shouldRetry) {
      spawnSync(launchctlPath, ["bootout", `gui/${uid}/${label}`], {
        stdio: "pipe",
        env: process.env,
      });
      const sleepPath = resolveCommandPathStrict("sleep");
      spawnSync(sleepPath, ["0.2"], { stdio: "ignore", env: process.env });
      result = spawnSync(launchctlPath, ["bootstrap", `gui/${uid}`, plistPath], {
        stdio: "pipe",
        env: process.env,
      });
    }
  }

  if (result.status !== 0) {
    const err = new Error("launchctl bootstrap に失敗しました。");
    err.code = result.status;
    err.stderrLen = result.stderr?.length || 0;
    err.stderrText = (result.stderr || "").toString("utf8").trim();
    err.stdoutText = (result.stdout || "").toString("utf8").trim();
    err.detail = err.stderrText || err.stdoutText || "";
    throw err;
  }

  return { plistPath };
}

function uninstallLaunchd({ allowMissing = false } = {}) {
  const uid = process.getuid();
  const label = "dev.slacklocalvibe.daemon";
  const launchctlPath = resolveCommandPathStrict("launchctl");
  const statusResult = spawnSync(launchctlPath, ["print", `gui/${uid}/${label}`], {
    stdio: "pipe",
    env: process.env,
  });
  const plistPath = launchdPlistPath();
  const hasPlist = fs.existsSync(plistPath);

  if (statusResult.status !== 0 && !hasPlist) {
    if (allowMissing) {
      return { installed: false, bootoutStatus: statusResult.status };
    }
    const err = new Error("launchd が未登録のためアンインストールできません。");
    err.code = statusResult.status;
    throw err;
  }

  let result = statusResult;
  if (statusResult.status === 0) {
    result = spawnSync(launchctlPath, ["bootout", `gui/${uid}/${label}`], {
      stdio: "pipe",
      env: process.env,
    });
    if (result.status !== 0) {
      const stderrText = (result.stderr || "").toString("utf8").trim();
      const stdoutText = (result.stdout || "").toString("utf8").trim();
      const detail = stderrText || stdoutText || "";
      const err = new Error("launchctl bootout に失敗しました。");
      err.code = result.status;
      err.detail = detail;
      throw err;
    }
  }

  if (hasPlist) {
    fs.unlinkSync(plistPath);
  }

  return {
    installed: statusResult.status === 0 || hasPlist,
    bootoutStatus: result.status,
    bootoutStderrLen: result.stderr?.length || 0,
  };
}

function statusLaunchd() {
  const uid = process.getuid();
  const label = "dev.slacklocalvibe.daemon";
  const launchctlPath = resolveCommandPathStrict("launchctl");
  const result = spawnSync(launchctlPath, ["print", `gui/${uid}/${label}`], {
    stdio: "pipe",
    env: process.env,
  });
  return { status: result.status };
}

function resolveNpmBinDir() {
  const npmPath = resolveCommandPathStrict("npm");
  const npmResult = spawnSync(npmPath, ["bin", "-g"], {
    encoding: "utf8",
    shell: false,
    env: process.env,
  });
  if (npmResult.status === 0) {
    const binDir = npmResult.stdout.trim();
    if (binDir) return binDir;
  }
  return "";
}

function resolveNpmPrefix() {
  const npmPath = resolveCommandPathStrict("npm");
  const prefixResult = spawnSync(npmPath, ["prefix", "-g"], {
    encoding: "utf8",
    shell: false,
    env: process.env,
  });
  if (prefixResult.status === 0) {
    const prefix = prefixResult.stdout.trim();
    if (prefix) return prefix;
  }
  const configResult = spawnSync(npmPath, ["config", "get", "prefix"], {
    encoding: "utf8",
    shell: false,
    env: process.env,
  });
  if (configResult.status === 0) {
    const prefix = configResult.stdout.trim();
    if (prefix) return prefix;
  }
  return "";
}

function resolveBinaryPath() {
  const npmBinDir = resolveNpmBinDir();
  if (npmBinDir) {
    const candidate = path.join(npmBinDir, "slacklocalvibe");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const npmPrefix = resolveNpmPrefix();
  if (npmPrefix) {
    const candidate = path.join(npmPrefix, "bin", "slacklocalvibe");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  throw new Error("slacklocalvibe のグローバル実行ファイルが見つかりません。");
}

function buildPlist(cliPath) {
  const logPath = daemonLogPath();
  const envPath = buildDaemonPathEnv();
  const nodePath = process.execPath;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>dev.slacklocalvibe.daemon</string>
  <key>ProgramArguments</key>
  <array>
    <string>${nodePath}</string>
    <string>${cliPath}</string>
    <string>daemon</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${logPath}</string>
  <key>StandardErrorPath</key>
  <string>${logPath}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${envPath}</string>
  </dict>
</dict>
</plist>`;
}

module.exports = {
  installLaunchd,
  uninstallLaunchd,
  statusLaunchd,
  resolveBinaryPath,
};
