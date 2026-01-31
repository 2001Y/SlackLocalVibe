const path = require("path");
const { loadConfig, normalizeConfig, assertNotifyConfig } = require("../lib/config");
const { createLogger, LEVELS, safeError } = require("../lib/logger");
const { notifyLogPath, daemonLogPath, wizardLogPath } = require("../lib/paths");
const {
  createWebClient,
  openDmChannel,
  postParentMessage,
  postThreadMessage,
  postMessage,
} = require("../lib/slack");
const { splitText } = require("../lib/text");
const { parseCodexNotify, parseClaudeHook } = require("../lib/notify-input");
const { markdownToMrkdwn } = require("../lib/markdown-to-mrkdwn");
const { recordRoute } = require("../lib/route-store");

async function runNotify({ tool }) {
  const { log } = createLogger({ filePath: notifyLogPath(), scope: "notify" });
  const startedAt = Date.now();
  log(LEVELS.INFO, "notify.start", { tool });

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    log(LEVELS.ERROR, "notify.config_parse_failed", { error: safeError(error) });
    process.exitCode = 1;
    throw error;
  }
  if (!config) {
    log(LEVELS.ERROR, "notify.config_missing");
    process.exitCode = 1;
    throw new Error("設定ファイルが見つかりません。");
  }

  config = normalizeConfig(config);

  try {
    assertNotifyConfig(config);
  } catch (error) {
    log(LEVELS.ERROR, "notify.config_invalid", { error: safeError(error) });
    process.exitCode = 1;
    throw error;
  }

  const client = createWebClient(config.slack.bot_token);
  const logLocationsText = buildLogLocationsMessage();
  let channel = "";

  let input;
  try {
    input = await readInput(tool);
  } catch (error) {
    log(LEVELS.ERROR, "notify.input_invalid", { error: safeError(error) });
    await tryPostLogLocations({
      log,
      client,
      config,
      logLocationsText,
      channel,
    });
    process.exitCode = 1;
    throw error;
  }

  if (!input) {
    log(LEVELS.ERROR, "notify.skip.not_target_event");
    process.exitCode = 1;
    throw new Error("通知対象のイベントではありません。");
  }
  if (input.skip) {
    const reason = input.skip_reason || "unknown";
    log(LEVELS.WARNING, `notify.skip.${reason}`, {
      meta: input.meta || {},
      duration_ms: Date.now() - startedAt,
    });
    return;
  }
  if (input.tool === "codex") {
    const meta = input.meta || {};
    log(LEVELS.INFO, "notify.codex_prompt_source", {
      rollout_found: meta.codex_rollout_found,
      rollout_source: meta.codex_rollout_source,
      rollout_path: meta.codex_rollout_path,
      rollout_user_messages: meta.codex_rollout_user_message_count,
      rollout_line_count: meta.codex_rollout_line_count,
      input_messages_len: meta.input_messages_len,
      input_messages_has_content: meta.input_messages_has_content,
      rollout_error: meta.codex_rollout_error,
    });
  }

  if (!input.session_id) {
    log(LEVELS.ERROR, "notify.session_missing");
    await tryPostLogLocations({
      log,
      client,
      config,
      logLocationsText,
      channel,
    });
    process.exitCode = 1;
    throw new Error("セッションIDが取得できません。");
  }
  const userTextMissing = input.user_text === "（ユーザーメッセージ抽出失敗）";
  const assistantTextMissing =
    input.assistant_text === "（本文抽出失敗）" ||
    String(input.assistant_text || "").startsWith("（本文抽出エラー:");

  if (userTextMissing) {
    log(LEVELS.ERROR, "notify.user_text_missing", {
      tool: input.tool,
      meta: input.meta || {},
      duration_ms: Date.now() - startedAt,
    });
    process.exitCode = 1;
    return;
  }
  if (assistantTextMissing) {
    log(LEVELS.WARNING, "notify.assistant_text_missing", { tool: input.tool });
  }

  let userText = "";
  let assistantText = "";
  try {
    channel = await openDmChannel({
      client,
      userId: config.destinations.dm.target_user_id,
      log,
    });
    if (!channel) {
      log(LEVELS.ERROR, "notify.dm_channel_missing");
      await tryPostLogLocations({
        log,
        client,
        config,
        logLocationsText,
        channel,
      });
      return;
    }

    try {
      userText = markdownToMrkdwn(input.user_text);
      assistantText = markdownToMrkdwn(input.assistant_text);
    } catch (error) {
      log(LEVELS.ERROR, "notify.markdown_convert_failed", {
        error: safeError(error),
      });
      await tryPostLogLocations({
        log,
        client,
        config,
        logLocationsText,
        channel,
      });
      return;
    }

    const userChunks = splitText(userText);
    const toolLabel = input.tool === "codex" ? "Codex" : "Claude";
    const projectName = extractProjectName(input.cwd);
    const userHeader = `[ ${toolLabel} | ${projectName} ]`;
    const parentText =
      userChunks[0] ? `${userHeader}\n${userChunks[0]}` : userHeader;

    const parentTs = await postParentMessage({
      client,
      log,
      channel,
      text: parentText,
    });
    try {
      recordRoute({
        channel,
        threadTs: parentTs,
        tool: input.tool,
        sessionId: input.session_id,
        turnId: input.turn_id,
        cwd: input.cwd || "",
      });
      log(LEVELS.SUCCRSS, "notify.route_recorded", {
        tool: input.tool,
        thread_ts: parentTs,
      });
    } catch (error) {
      log(LEVELS.ERROR, "notify.route_record_failed", {
        error: safeError(error),
      });
    }

    const extraUserChunks = userChunks.slice(1);
    for (const chunk of extraUserChunks) {
      if (!chunk) continue;
      await postThreadMessage({
        client,
        log,
        channel,
        threadTs: parentTs,
        text: chunk,
      });
    }

    const assistantChunks = splitText(assistantText);
    for (const chunk of assistantChunks) {
      if (!chunk) continue;
      await postThreadMessage({
        client,
        log,
        channel,
        threadTs: parentTs,
        text: chunk,
      });
    }

    if (userTextMissing || assistantTextMissing) {
      await postThreadMessage({
        client,
        log,
        channel,
        threadTs: parentTs,
        text: logLocationsText,
      });
    }

    log(LEVELS.SUCCRSS, "notify.done", {
      duration_ms: Date.now() - startedAt,
      user_len: input.user_text?.length || 0,
      assistant_len: input.assistant_text?.length || 0,
    });
  } catch (error) {
    log(LEVELS.ERROR, "notify.slack_error", {
      error: safeError(error),
      duration_ms: Date.now() - startedAt,
    });
    await tryPostLogLocations({
      log,
      client,
      config,
      logLocationsText,
      channel,
    });
  }
}

async function readInput(tool) {
  if (tool === "codex") {
    const raw = process.argv[process.argv.length - 1];
    return parseCodexNotify(raw);
  }
  if (tool === "claude") {
    const raw = await readStdin();
    if (!raw) return null;
    return parseClaudeHook(raw);
  }
  throw new Error(`Unsupported tool: ${tool}`);
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", (err) => reject(err));
  });
}

function buildLogLocationsMessage() {
  return [
    "ログの場所:",
    `- notify: ${notifyLogPath()}`,
    `- daemon: ${daemonLogPath()}`,
    `- wizard: ${wizardLogPath()}`,
  ].join("\n");
}

async function tryPostLogLocations({
  log,
  client,
  config,
  logLocationsText,
  channel,
  threadTs,
}) {
  try {
    if (!client || !config?.destinations?.dm?.target_user_id) {
      log(LEVELS.ERROR, "notify.log_locations_unavailable");
      process.exitCode = 1;
      return;
    }
    let targetChannel = channel;
    if (!targetChannel) {
      targetChannel = await openDmChannel({
        client,
        userId: config.destinations.dm.target_user_id,
        log,
      });
    }
    if (!targetChannel) {
      log(LEVELS.ERROR, "notify.log_locations_channel_missing");
      process.exitCode = 1;
      return;
    }
    if (threadTs) {
      await postThreadMessage({
        client,
        log,
        channel: targetChannel,
        threadTs,
        text: logLocationsText,
      });
      return;
    }
    await postMessage({
      client,
      log,
      channel: targetChannel,
      text: logLocationsText,
    });
  } catch (error) {
    log(LEVELS.ERROR, "notify.log_locations_failed", { error: safeError(error) });
    process.exitCode = 1;
  }
}

function extractProjectName(cwd) {
  if (!cwd || typeof cwd !== "string") return "unknown";
  const normalized = cwd.endsWith(path.sep) ? cwd.slice(0, -1) : cwd;
  const base = path.basename(normalized);
  return base || "unknown";
}

module.exports = {
  runNotify,
};
