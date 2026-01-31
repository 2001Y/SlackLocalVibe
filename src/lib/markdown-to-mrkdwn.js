const { marked } = require("marked");
const htmlToMrkdwn = require("html-to-mrkdwn");

function markdownToMrkdwn(text) {
  if (!text) return "";
  const html = marked.parse(text);
  const result = htmlToMrkdwn(html);
  if (typeof result === "string") return result;
  if (result && typeof result.text === "string") return result.text;
  throw new Error("markdown_to_mrkdwn_invalid_output");
}

module.exports = {
  markdownToMrkdwn,
};
