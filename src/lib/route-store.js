const fs = require("fs");
const path = require("path");
const { routesPath } = require("./paths");

const MAX_ROUTES_BYTES = 1024 * 1024;
const MAX_ROUTES_LINES = 2000;

function recordRoute({ channel, threadTs, tool, sessionId, turnId, cwd }) {
  const filePath = routesPath();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const entry = {
    ts: new Date().toISOString(),
    channel,
    thread_ts: threadTs,
    tool,
    session_id: sessionId,
    turn_id: turnId || "",
    cwd: cwd || "",
  };
  fs.appendFileSync(filePath, `${JSON.stringify(entry)}\n`, "utf8");
  pruneRoutesIfNeeded(filePath);
}

function findRoute({ channel, threadTs }) {
  const filePath = routesPath();
  if (!fs.existsSync(filePath)) return null;
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n").filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    try {
      const entry = JSON.parse(line);
      if (entry.channel === channel && entry.thread_ts === threadTs) {
        return entry;
      }
    } catch {
      // skip invalid line
    }
  }
  return null;
}

function pruneRoutesIfNeeded(filePath) {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size <= MAX_ROUTES_BYTES) return;
    const content = fs.readFileSync(filePath, "utf8");
    const lines = content.split("\n").filter(Boolean);
    const kept = lines.slice(-MAX_ROUTES_LINES);
    fs.writeFileSync(filePath, `${kept.join("\n")}\n`, "utf8");
  } catch {
    // ignore prune errors
  }
}

module.exports = {
  recordRoute,
  findRoute,
};
