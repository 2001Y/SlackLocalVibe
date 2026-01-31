const { SocketModeClient } = require("@slack/socket-mode");
const { randomUUID } = require("crypto");
const { loadConfig, normalizeConfig, assertDaemonConfig } = require("../lib/config");
const { createLogger, LEVELS, safeError } = require("../lib/logger");
const { daemonLogPath, notifyLogPath, wizardLogPath } = require("../lib/paths");
const { createWebClient, postThreadMessage } = require("../lib/slack");
const { findRoute } = require("../lib/route-store");
const {
  buildReplyReceivedMessage,
  REPLY_INVALID_MESSAGE,
  RESUME_FAILED_MESSAGE,
} = require("../lib/messages");
const { runCodexResume, runClaudeResume } = require("../lib/resume");

function formatErrorHead(text) {
  if (!text) return "";
  const trimmed = String(text).replace(/\s+$/g, "").trim();
  if (!trimmed) return "";
  const firstLine = trimmed.split(/\r?\n/)[0].trim();
  if (!firstLine) return "";
  if (firstLine.length > 200) {
    return `${firstLine.slice(0, 200)}...`;
  }
  return firstLine;
}

function buildResumeFailedMessage(result) {
  const detail = formatErrorHead(result?.stderrHead || result?.stdoutHead || "");
  if (detail) {
    return `${RESUME_FAILED_MESSAGE}\nエラー: ${detail}`;
  }
  if (result?.code !== undefined && result?.code !== null) {
    return `${RESUME_FAILED_MESSAGE}\nエラーコード: ${result.code}`;
  }
  return RESUME_FAILED_MESSAGE;
}

async function runDaemon() {
  const { log } = createLogger({ filePath: daemonLogPath(), scope: "daemon" });
  log(LEVELS.INFO, "daemon.start");
  log(LEVELS.INFO, "daemon.runtime", {
    argv: process.argv,
    exec_path: process.execPath,
    cwd: process.cwd(),
    node: process.version,
  });

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    log(LEVELS.ERROR, "daemon.config_parse_failed", { error: safeError(error) });
    process.exitCode = 1;
    return;
  }
  if (!config) {
    log(LEVELS.ERROR, "daemon.config_missing");
    process.exitCode = 1;
    return;
  }
  config = normalizeConfig(config);

  try {
    assertDaemonConfig(config);
  } catch (error) {
    log(LEVELS.ERROR, "daemon.config_invalid", { error: safeError(error) });
    process.exitCode = 1;
    return;
  }

  const webClient = createWebClient(config.slack.bot_token);
  const socketClient = new SocketModeClient({
    appToken: config.slack.app_token,
    client: webClient,
  });

  socketClient.on("error", (error) => {
    log(LEVELS.ERROR, "daemon.socket_error", { error: safeError(error) });
  });

  socketClient.on("connected", () => {
    log(LEVELS.SUCCRSS, "daemon.socket_connected");
  });

  socketClient.on("message", async ({ event, body, ack }) => {
    const correlationId = randomUUID();
    const startedAt = Date.now();

    try {
      await ack();
      log(LEVELS.SUCCRSS, "daemon.ack", {
        correlation_id: correlationId,
        envelope_id: body?.envelope_id,
      });
    } catch (error) {
      log(LEVELS.WARNING, "daemon.ack_failed", {
        correlation_id: correlationId,
        error: safeError(error),
      });
    }

    handleMessageEvent({
      event,
      body,
      log,
      config,
      webClient,
      correlationId,
      startedAt,
    }).catch((error) => {
      log(LEVELS.ERROR, "daemon.event_error", {
        correlation_id: correlationId,
        error: safeError(error),
      });
    });
  });

  await socketClient.start();
}

async function handleMessageEvent({
  event,
  body,
  log,
  config,
  webClient,
  correlationId,
  startedAt,
}) {
  const skipReason = shouldSkipEvent(event);
  if (skipReason) {
    log(LEVELS.DEBUG, "daemon.skip_event", {
      correlation_id: correlationId,
      reason: skipReason,
    });
    return;
  }

  const text = event.text || "";
  if (!text.trim()) {
    log(LEVELS.DEBUG, "daemon.skip_empty", { correlation_id: correlationId });
    return;
  }

  const routeEntry = findRoute({
    channel: event.channel,
    threadTs: event.thread_ts,
  });

  if (!routeEntry) {
    await safeThreadReply({
      log,
      webClient,
      channel: event.channel,
      threadTs: event.thread_ts,
      text: appendLogLocations(REPLY_INVALID_MESSAGE),
      correlationId,
      label: "daemon.reply_invalid",
    });
    log(LEVELS.WARNING, "daemon.route_invalid", {
      correlation_id: correlationId,
      reason: "route_missing",
    });
    return;
  }

  const replyMessage = buildReplyReceivedMessage({
    tool: routeEntry.tool,
    sessionId: routeEntry.session_id,
    cwd: routeEntry.cwd || "",
  });

  log(LEVELS.STATES, "daemon.reply_payload", {
    correlation_id: correlationId,
    tool: routeEntry.tool,
    session_id: routeEntry.session_id,
    cwd: routeEntry.cwd || "",
    text: replyMessage,
    text_len: replyMessage.length,
  });

  await safeThreadReply({
    log,
    webClient,
    channel: event.channel,
    threadTs: event.thread_ts,
    text: replyMessage,
    correlationId,
    label: "daemon.reply_received",
  });

  let result;
  if (routeEntry.tool === "codex") {
    result = await runCodexResume({
      sessionId: routeEntry.session_id,
      prompt: text,
      cwd: routeEntry.cwd || "",
    });
  } else {
    result = await runClaudeResume({
      sessionId: routeEntry.session_id,
      prompt: text,
      cwd: routeEntry.cwd || "",
    });
  }

  log(LEVELS.STATES, "daemon.resume_result", {
    correlation_id: correlationId,
    tool: routeEntry.tool,
    exit_code: result?.code,
    signal: result?.signal,
    stdout_len: result?.stdoutLen,
    stderr_len: result?.stderrLen,
    stdout_head: formatErrorHead(result?.stdoutHead),
    stderr_head: formatErrorHead(result?.stderrHead),
  });

  if (result?.code !== 0) {
    await safeThreadReply({
      log,
      webClient,
      channel: event.channel,
      threadTs: event.thread_ts,
      text: appendLogLocations(buildResumeFailedMessage(result)),
      correlationId,
      label: "daemon.reply_failed",
    });
  }

  log(LEVELS.SUCCRSS, "daemon.event_done", {
    correlation_id: correlationId,
    duration_ms: Date.now() - startedAt,
    input_len: text.length,
  });
}

function shouldSkipEvent(event) {
  if (!event) return "event_missing";
  if (event.subtype) return "subtype";
  if (event.bot_id || event.bot_profile) return "bot_message";
  if (event.channel_type && event.channel_type !== "im") return "not_im";
  if (!event.thread_ts) return "no_thread";
  if (event.thread_ts === event.ts) return "not_reply";
  return "";
}

function appendLogLocations(text) {
  return `${text}\n\n${buildLogLocationsMessage()}`;
}

function buildLogLocationsMessage() {
  return [
    "ログの場所:",
    `- notify: ${notifyLogPath()}`,
    `- daemon: ${daemonLogPath()}`,
    `- wizard: ${wizardLogPath()}`,
  ].join("\n");
}

async function safeThreadReply({
  log,
  webClient,
  channel,
  threadTs,
  text,
  correlationId,
  label,
}) {
  try {
    await postThreadMessage({
      client: webClient,
      log,
      channel,
      threadTs,
      text,
    });
    log(LEVELS.SUCCRSS, label, { correlation_id: correlationId });
  } catch (error) {
    log(LEVELS.ERROR, `${label}_failed`, {
      correlation_id: correlationId,
      error: safeError(error),
    });
    throw error;
  }
}

module.exports = {
  runDaemon,
};
