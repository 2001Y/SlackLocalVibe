const fs = require("fs");
const path = require("path");

const LEVELS = {
  INFO: "INFO",
  DEBUG: "DEBUG",
  STATES: "STATES",
  SUCCRSS: "SUCCRSS",
  WARNING: "WARNING",
  ERROR: "ERROR",
};

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function createLogger({ filePath, scope }) {
  ensureDir(path.dirname(filePath));

  function log(level, message, data = {}) {
    const payload = {
      ts: new Date().toISOString(),
      level,
      scope,
      message,
      ...data,
    };
    fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
  }

  return {
    log,
    LEVELS,
  };
}

async function withTiming(log, label, fn, data = {}) {
  const start = Date.now();
  try {
    const result = await fn();
    log(LEVELS.SUCCRSS, label, { ...data, duration_ms: Date.now() - start });
    return result;
  } catch (error) {
    log(LEVELS.ERROR, label, {
      ...data,
      duration_ms: Date.now() - start,
      error: safeError(error),
    });
    throw error;
  }
}

function safeError(error) {
  if (!error) return undefined;
  return {
    name: error.name,
    message: error.message,
    code: error.code,
  };
}

module.exports = {
  createLogger,
  withTiming,
  LEVELS,
  safeError,
};
