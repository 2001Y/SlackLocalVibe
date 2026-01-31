const fs = require("fs");
const os = require("os");
const path = require("path");

const CODEX_INTERNAL_TITLE_PROMPT_PREFIX =
  "You are a helpful assistant. You will be presented with a user prompt";
const CODEX_INTERNAL_TITLE_PROMPT_LINES = [
  "Generate a concise UI title (18-36 characters) for this task.",
  "Return only the title. No quotes or trailing punctuation.",
  "Do not use markdown or formatting characters.",
  "If the task includes a ticket reference (e.g. ABC-123), include it verbatim.",
  "Generate a clear, informative task title based solely on the prompt provided. Follow the rules below to ensure consistency, readability, and usefulness.",
  "How to write a good title:",
  "Generate a single-line title that captures the question or core change requested. The title should be easy to scan and useful in changelogs or review queues.",
  "By following these conventions, your titles will be readable, changelog-friendly, and helpful to both users and downstream tools.",
  "Examples:",
];
const CODEX_INTERNAL_TITLE_PROMPT_MIN_MATCHES = 3;

function parseCodexNotify(rawJson) {
  const payload = JSON.parse(rawJson);
  if (payload?.type !== "agent-turn-complete") {
    return null;
  }
  const sessionId = String(payload["thread-id"] || "");
  const turnId = payload["turn-id"] ? String(payload["turn-id"]) : undefined;
  const inputMessages = payload["input-messages"];
  const meta = buildCodexInputMeta(inputMessages);
  const codexHomeInfo = resolveCodexHomeInfo();
  Object.assign(meta, codexHomeInfo.meta || {});
  const rolloutResult = readCodexUserMessageFromRollout(sessionId, codexHomeInfo.home);
  Object.assign(meta, rolloutResult.meta || {});
  const userText = rolloutResult.userText || "";
  const internalPromptCheck = matchCodexInternalTitlePrompt(userText);
  Object.assign(meta, {
    codex_internal_title_prompt_match: internalPromptCheck.match,
    codex_internal_title_prompt_hits: internalPromptCheck.hits,
    codex_internal_title_prompt_first_line: internalPromptCheck.firstLine,
  });
  if (internalPromptCheck.match) {
    return {
      tool: "codex",
      skip: true,
      skip_reason: "codex_internal_title_prompt",
      meta,
    };
  }
  const assistantText = extractAssistantText(payload["last-assistant-message"]);
  const cwd = payload?.cwd ? String(payload.cwd) : "";

  return {
    tool: "codex",
    session_id: sessionId,
    turn_id: turnId,
    cwd,
    user_text: userText || "（ユーザーメッセージ抽出失敗）",
    assistant_text: assistantText || "（本文抽出失敗）",
    meta,
  };
}

function buildCodexInputMeta(inputMessages) {
  const meta = {
    input_messages_type: Array.isArray(inputMessages) ? "array" : typeof inputMessages,
    input_messages_len: Array.isArray(inputMessages) ? inputMessages.length : 0,
    input_messages_has_content: hasNonEmptyInputMessages(inputMessages),
    input_messages_roles: [],
    input_messages_last_role: "",
    input_messages_last_type: "",
    input_messages_last_keys: [],
    input_messages_last_content_keys: [],
  };
  if (Array.isArray(inputMessages) && inputMessages.length > 0) {
    const roles = [];
    for (const message of inputMessages) {
      const role = message?.role;
      if (role && !roles.includes(role)) {
        roles.push(role);
      }
    }
    meta.input_messages_roles = roles;
    const lastMessage = inputMessages[inputMessages.length - 1];
    meta.input_messages_last_role = lastMessage?.role || "";
    meta.input_messages_last_type = Array.isArray(lastMessage)
      ? "array"
      : typeof lastMessage;
    if (lastMessage && typeof lastMessage === "object" && !Array.isArray(lastMessage)) {
      meta.input_messages_last_keys = Object.keys(lastMessage).slice(0, 20);
      const content = lastMessage.content;
      if (content && typeof content === "object" && !Array.isArray(content)) {
        meta.input_messages_last_content_keys = Object.keys(content).slice(0, 20);
      }
    }
  }
  return meta;
}

function extractAssistantText(content) {
  return normalizeContent(content);
}

function matchCodexInternalTitlePrompt(text) {
  const firstLine = firstNonEmptyLine(text);
  if (!firstLine.startsWith(CODEX_INTERNAL_TITLE_PROMPT_PREFIX)) {
    return { match: false, hits: 0, firstLine };
  }
  let hits = 0;
  for (const line of CODEX_INTERNAL_TITLE_PROMPT_LINES) {
    if (text.includes(line)) {
      hits += 1;
    }
  }
  return {
    match: hits >= CODEX_INTERNAL_TITLE_PROMPT_MIN_MATCHES,
    hits,
    firstLine,
  };
}

function firstNonEmptyLine(text) {
  if (!text) return "";
  const lines = String(text).split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function readCodexUserMessageFromRollout(sessionId, codexHome) {
  const meta = {
    codex_rollout_found: false,
    codex_rollout_source: "",
    codex_rollout_path: "",
    codex_rollout_mtime_ms: 0,
    codex_rollout_total: 0,
    codex_rollout_user_message_count: 0,
    codex_rollout_line_count: 0,
    codex_rollout_error: "",
  };
  const rolloutPath = findCodexRolloutPath(sessionId, meta, codexHome);
  if (!rolloutPath) {
    return { userText: "", meta };
  }
  try {
    const content = fs.readFileSync(rolloutPath, "utf8");
    const lines = content.split("\n").filter(Boolean);
    meta.codex_rollout_line_count = lines.length;
    let lastUser = "";
    let lastTs = "";
    let count = 0;
    for (const line of lines) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (record?.type !== "event_msg") continue;
      const payload = record?.payload;
      if (payload?.type !== "user_message") continue;
      const text = extractCodexUserMessage(payload);
      if (text) {
        lastUser = text;
        lastTs = record?.timestamp || "";
      }
      count += 1;
    }
    meta.codex_rollout_user_message_count = count;
    if (lastTs) {
      meta.codex_rollout_last_user_ts = lastTs;
    }
    return { userText: lastUser, meta };
  } catch (error) {
    meta.codex_rollout_error = error?.message || "rollout_read_failed";
    return { userText: "", meta };
  }
}

function extractCodexUserMessage(payload) {
  if (!payload || typeof payload !== "object") return "";
  const content =
    payload.message ||
    payload.text ||
    payload.prompt ||
    payload.input ||
    payload.content;
  return normalizeContent(content);
}

function findCodexRolloutPath(sessionId, meta, codexHome) {
  if (!sessionId) {
    meta.codex_rollout_error = "session_id_missing";
    return "";
  }
  const baseHome = codexHome || path.join(os.homedir(), ".codex");
  const sessionsDir = path.join(baseHome, "sessions");
  meta.codex_sessions_dir = sessionsDir;
  if (!fs.existsSync(sessionsDir)) {
    meta.codex_rollout_error = "sessions_dir_missing";
    return "";
  }

  const files = collectRolloutFiles(sessionsDir);
  meta.codex_rollout_total = files.length;
  const byName = files.filter((item) => item.name.includes(sessionId));
  if (byName.length > 0) {
    const best = pickLatestFile(byName);
    if (best) {
      meta.codex_rollout_found = true;
      meta.codex_rollout_source = "filename";
      meta.codex_rollout_path = best.path;
      meta.codex_rollout_mtime_ms = best.mtimeMs;
      return best.path;
    }
  }

  const byContent = findRolloutByContent(files, sessionId, meta);
  if (byContent) {
    meta.codex_rollout_found = true;
    meta.codex_rollout_source = "content";
    meta.codex_rollout_path = byContent.path;
    meta.codex_rollout_mtime_ms = byContent.mtimeMs;
    return byContent.path;
  }

  meta.codex_rollout_error = meta.codex_rollout_error || "rollout_not_found";
  return "";
}

function collectRolloutFiles(rootDir) {
  const results = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.startsWith("rollout-") || !entry.name.endsWith(".jsonl")) {
        continue;
      }
      let stat;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }
      results.push({
        path: fullPath,
        name: entry.name,
        mtimeMs: stat.mtimeMs || 0,
      });
    }
  }
  return results;
}

function pickLatestFile(files) {
  if (!files || files.length === 0) return null;
  let best = files[0];
  for (const item of files) {
    if (item.mtimeMs > best.mtimeMs) {
      best = item;
    }
  }
  return best;
}

function findRolloutByContent(files, sessionId, meta) {
  if (!files || files.length === 0) {
    meta.codex_rollout_error = "rollout_files_empty";
    return null;
  }
  const sorted = [...files].sort((a, b) => b.mtimeMs - a.mtimeMs);
  const limit = 30;
  for (let i = 0; i < sorted.length && i < limit; i += 1) {
    const file = sorted[i];
    let content = "";
    try {
      content = fs.readFileSync(file.path, "utf8");
    } catch {
      continue;
    }
    if (content.includes(sessionId)) {
      return file;
    }
  }
  meta.codex_rollout_error = "rollout_not_matched_in_recent_files";
  return null;
}

function resolveCodexHomeInfo() {
  const defaultHome = path.join(os.homedir(), ".codex");
  const defaultResolved = path.resolve(defaultHome);
  const envHome = process.env.CODEX_HOME;
  if (!envHome) {
    return {
      home: defaultResolved,
      isDefault: true,
      isSet: false,
      meta: {
        codex_home: defaultResolved,
        codex_home_default: defaultResolved,
        codex_home_is_default: true,
        codex_home_set: false,
      },
    };
  }
  const resolved = path.resolve(envHome);
  const isDefault = resolved === defaultResolved;
  return {
    home: resolved,
    isDefault,
    isSet: true,
    meta: {
      codex_home: resolved,
      codex_home_default: defaultResolved,
      codex_home_is_default: isDefault,
      codex_home_set: true,
    },
  };
}

function extractTextDeep(value, depth = 0) {
  if (depth > 6) return "";
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    return value.map((item) => extractTextDeep(item, depth + 1)).join("");
  }
  if (typeof value === "object") {
    const preferredKeys = [
      "text",
      "content",
      "message",
      "input",
      "prompt",
      "input_text",
      "inputText",
      "value",
    ];
    for (const key of preferredKeys) {
      if (value[key] !== undefined) {
        const text = extractTextDeep(value[key], depth + 1);
        if (text) return text;
      }
    }
    return Object.values(value)
      .map((item) => extractTextDeep(item, depth + 1))
      .join("");
  }
  return "";
}

function normalizeContent(content) {
  return extractTextDeep(content);
}

function hasNonEmptyInputMessages(inputMessages) {
  if (!Array.isArray(inputMessages) || inputMessages.length === 0) return false;
  for (const message of inputMessages) {
    const text = normalizeContent(message);
    if (text && String(text).trim()) return true;
  }
  return false;
}

function parseClaudeHook(rawJson) {
  const payload = JSON.parse(rawJson);
  if (payload?.hook_event_name !== "Stop") {
    return null;
  }
  if (payload?.stop_hook_active === true) {
    return null;
  }

  const sessionId = String(payload?.session_id || "");
  const transcriptPath = payload?.transcript_path;
  const cwd = payload?.cwd ? String(payload.cwd) : "";
  let userText = "";
  let assistantText = "";
  let transcriptError = "";

  if (transcriptPath) {
    try {
      const { lastUser, lastAssistant } = readTranscript(transcriptPath);
      userText = lastUser || "";
      assistantText = lastAssistant || "";
    } catch (error) {
      transcriptError = error?.message || "transcript_read_failed";
    }
  } else {
    transcriptError = "transcript_path_missing";
  }

  return {
    tool: "claude",
    session_id: sessionId,
    cwd,
    user_text: userText || "（ユーザーメッセージ抽出失敗）",
    assistant_text: assistantText || `（本文抽出エラー: ${transcriptError || "unknown"}）`,
  };
}

function readTranscript(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split("\n").filter(Boolean);
  let lastUser = "";
  let lastAssistant = "";

  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const { role, text } = extractRoleAndText(record);
    if (!role || !text) continue;
    if (role === "user") lastUser = text;
    if (role === "assistant") lastAssistant = text;
  }

  return { lastUser, lastAssistant };
}

function extractRoleAndText(record) {
  if (!record || typeof record !== "object") return {};

  let role = record.role || record.message?.role || record.data?.role || "";
  if (!role) {
    if (record.type === "assistant") role = "assistant";
    if (record.type === "user") role = "user";
  }

  const content =
    record.content ||
    record.message?.content ||
    record.data?.content ||
    record.text ||
    record.message?.text;

  const text = normalizeContent(content);
  return { role, text };
}

module.exports = {
  parseCodexNotify,
  parseClaudeHook,
  normalizeContent,
};
