const { spawn } = require("child_process");
const { defaultPathEnv, resolveCommandPathStrict } = require("./paths");

function normalizeClaudePrompt(text) {
  const normalized = (text || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  return normalized.replace(/\n/g, "\\n");
}

function runCommand({ command, args, input, env, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, PATH: defaultPathEnv(), ...env },
      cwd,
    });
    let stdoutLen = 0;
    let stderrLen = 0;
    let stdoutHead = "";
    let stderrHead = "";
    const MAX_HEAD = 400;
    child.stdout.on("data", (chunk) => {
      stdoutLen += chunk.length;
      if (stdoutHead.length < MAX_HEAD) {
        stdoutHead += chunk.toString("utf8");
        if (stdoutHead.length > MAX_HEAD) {
          stdoutHead = stdoutHead.slice(0, MAX_HEAD);
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrLen += chunk.length;
      if (stderrHead.length < MAX_HEAD) {
        stderrHead += chunk.toString("utf8");
        if (stderrHead.length > MAX_HEAD) {
          stderrHead = stderrHead.slice(0, MAX_HEAD);
        }
      }
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code, signal) => {
      resolve({
        code,
        signal,
        stdoutLen,
        stderrLen,
        stdoutHead,
        stderrHead,
      });
    });
    if (input) {
      child.stdin.write(input);
    }
    child.stdin.end();
  });
}

async function runCodexResume({ sessionId, prompt, cwd }) {
  const codexPath = resolveCommandPathStrict("codex");
  const args = ["exec", "--skip-git-repo-check"];
  if (cwd) {
    args.push("--cd", cwd);
  }
  args.push("resume", sessionId, "-");
  return runCommand({
    command: codexPath,
    args,
    input: prompt || "",
    cwd: cwd || undefined,
  });
}

async function runClaudeResume({ sessionId, prompt, cwd }) {
  const normalized = normalizeClaudePrompt(prompt || "");
  const claudePath = resolveCommandPathStrict("claude");
  return runCommand({
    command: claudePath,
    args: ["-r", sessionId, normalized],
    cwd: cwd || undefined,
  });
}

module.exports = {
  runCodexResume,
  runClaudeResume,
  normalizeClaudePrompt,
};
