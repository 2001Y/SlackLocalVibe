const { WebClient } = require("@slack/web-api");
const { withTiming, LEVELS, safeError } = require("./logger");

const MAX_RETRIES = 2;

function createWebClient(token) {
  return new WebClient(token);
}

async function slackApiCall(log, label, fn) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      log(LEVELS.DEBUG, `${label}:call`, { attempt });
      const result = await fn();
      if (result?.ok === false) {
        const err = new Error(result.error || "Slack API error");
        err.code = result.error;
        throw err;
      }
      log(LEVELS.SUCCRSS, `${label}:ok`, { attempt });
      return result;
    } catch (error) {
      lastError = error;
      log(LEVELS.WARNING, `${label}:retry`, {
        attempt,
        error: safeError(error),
      });
    }
  }
  throw lastError;
}

async function openDmChannel({ client, userId, log }) {
  return withTiming(log, "slack.conversations.open", async () => {
    const response = await slackApiCall(log, "conversations.open", () =>
      client.conversations.open({ users: userId })
    );
    return response.channel?.id;
  });
}

function logSlackMessage(log, label, payload) {
  log(LEVELS.STATES, label, payload);
}

async function postParentMessage({ client, log, channel, text, metadata }) {
  logSlackMessage(log, "slack.chat.postMessage.parent.request", {
    channel,
    text,
    text_len: text?.length || 0,
    has_metadata: Boolean(metadata),
  });
  return withTiming(log, "slack.chat.postMessage.parent", async () => {
    const payload = {
      channel,
      text,
    };
    if (metadata) {
      payload.metadata = metadata;
    }
    const response = await slackApiCall(log, "chat.postMessage.parent", () =>
      client.chat.postMessage(payload)
    );
    logSlackMessage(log, "slack.chat.postMessage.parent.response", {
      channel,
      ts: response.ts,
    });
    return response.ts;
  });
}

async function postMessage({ client, log, channel, text }) {
  logSlackMessage(log, "slack.chat.postMessage.simple.request", {
    channel,
    text,
    text_len: text?.length || 0,
  });
  return withTiming(log, "slack.chat.postMessage.simple", async () => {
    const response = await slackApiCall(log, "chat.postMessage.simple", () =>
      client.chat.postMessage({
        channel,
        text,
      })
    );
    logSlackMessage(log, "slack.chat.postMessage.simple.response", {
      channel,
      ts: response.ts,
    });
    return response.ts;
  });
}

async function postThreadMessage({ client, log, channel, threadTs, text }) {
  logSlackMessage(log, "slack.chat.postMessage.thread.request", {
    channel,
    thread_ts: threadTs,
    text,
    text_len: text?.length || 0,
  });
  return withTiming(log, "slack.chat.postMessage.thread", async () => {
    const response = await slackApiCall(log, "chat.postMessage.thread", () =>
      client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text,
      })
    );
    logSlackMessage(log, "slack.chat.postMessage.thread.response", {
      channel,
      thread_ts: threadTs,
      ts: response.ts,
    });
    return response.ts;
  });
}

async function fetchParentMessage({ client, log, channel, threadTs }) {
  return withTiming(log, "slack.conversations.history", async () => {
    const response = await slackApiCall(log, "conversations.history", () =>
      client.conversations.history({
        channel,
        latest: threadTs,
        inclusive: true,
        limit: 1,
        include_all_metadata: true,
      })
    );
    return response.messages?.[0];
  });
}

module.exports = {
  createWebClient,
  openDmChannel,
  postMessage,
  postParentMessage,
  postThreadMessage,
  fetchParentMessage,
};
