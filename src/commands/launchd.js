const { createLogger, LEVELS, safeError } = require("../lib/logger");
const { daemonLogPath } = require("../lib/paths");
const {
  installLaunchd,
  uninstallLaunchd,
  statusLaunchd,
} = require("../lib/launchd");

async function runLaunchd(action) {
  const { log } = createLogger({ filePath: daemonLogPath(), scope: "launchd" });
  if (action === "install") {
    try {
      const result = installLaunchd();
      log(LEVELS.SUCCRSS, "launchd.install_ok", result);
    } catch (error) {
      log(LEVELS.ERROR, "launchd.install_failed", { error: safeError(error) });
      process.exitCode = 1;
    }
    return;
  }
  if (action === "uninstall") {
    try {
      const result = uninstallLaunchd();
      log(LEVELS.SUCCRSS, "launchd.uninstall_ok", result);
    } catch (error) {
      log(LEVELS.ERROR, "launchd.uninstall_failed", { error: safeError(error) });
      process.exitCode = 1;
    }
    return;
  }
  if (action === "status") {
    const result = statusLaunchd();
    if (result.status !== 0) {
      log(LEVELS.WARNING, "launchd.status_not_installed");
      process.exitCode = 1;
    } else {
      log(LEVELS.SUCCRSS, "launchd.status_ok");
    }
    return;
  }
  log(LEVELS.ERROR, "launchd.unknown_action", { action });
  process.exitCode = 1;
}
module.exports = {
  runLaunchd,
};
