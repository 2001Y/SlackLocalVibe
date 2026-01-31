const fs = require("fs");
const path = require("path");
const readline = require("readline");
const prompts = require("prompts");
const { spawn, spawnSync } = require("child_process");
const { createLogger, LEVELS, safeError } = require("../lib/logger");
const {
  wizardLogPath,
  notifyLogPath,
  daemonLogPath,
  defaultPathEnv,
  routesPath,
  resolveCommandPathStrict,
} = require("../lib/paths");
const {
  loadConfig,
  normalizeConfig,
  writeConfig,
  configPath,
} = require("../lib/config");
const { createWebClient, openDmChannel, postMessage } = require("../lib/slack");
const {
  updateCodexNotify,
  updateClaudeStopHook,
  codexConfigPath,
  claudeSettingsPath,
} = require("../lib/user-config");
const { TEST_PROMPT } = require("../lib/messages");
const { installLaunchd, resolveBinaryPath } = require("../lib/launchd");

class UserExit extends Error {}

const TOTAL_STEPS = 12;
const USE_COLOR = Boolean(process.stdout.isTTY);
const ANSI = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
};
const SLACK_NEW_APP_URL = "https://api.slack.com/apps?new_app=1";
const SLACK_MANIFEST = `_metadata:
  major_version: 1

display_information:
  name: LocalVibe
  description: DMで通知と返信を扱うブリッジ
  background_color: "#0a0a0a"

features:
  bot_user:
    display_name: LocalVibe
    always_online: false
  app_home:
    home_tab_enabled: false
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false

oauth_config:
  scopes:
    bot:
      - chat:write
      - im:write
      - im:history

settings:
  socket_mode_enabled: true
  is_hosted: false
  token_rotation_enabled: false
  event_subscriptions:
    bot_events:
      - message.im
  org_deploy_enabled: false
`;

async function runWizard() {
  const { log } = createLogger({ filePath: wizardLogPath(), scope: "wizard" });
  log(LEVELS.INFO, "wizard.start");

  const configSnapshot = captureConfigSnapshot();
  let stagedConfigWritten = false;
  let didSaveFinal = false;

  let existingConfig = null;
  let startFromTest = false;
  try {
    existingConfig = loadConfig();
  } catch (error) {
    log(LEVELS.ERROR, "wizard.config_parse_failed", { error: safeError(error) });
    console.log("設定ファイルの読み取りに失敗しました。内容を確認してください。");
    throw error;
  }
  const normalized = existingConfig ? normalizeConfig(existingConfig) : null;
  printBanner();
  console.log("CLI 公式機能活用：CLI に限らず VSCode 拡張機能などでも動作");
  console.log(
    "Slack返信対応：通知スレッドに返信すると resume コマンドを用いて CLI にメッセージを送信が可能"
  );
  console.log("");
  console.log("SlackLocalVibe セットアップを開始します。");
  if (normalized) {
    console.log("既存設定が見つかりました。開始方法を選んでください。");
    while (true) {
      const choice = await promptSelect({
        message: "どこから始めますか？",
        choices: [
          { title: "アップデートを確認する", value: "update" },
          { title: "テストから始める", value: "test" },
          { title: "リセットして最初からセットアップ", value: "reset" },
          { title: "終了", value: "exit" },
        ],
        initial: 0,
      });
      if (choice === "update") {
        log(LEVELS.INFO, "wizard.update_check_start");
        const versionInfo = await fetchUpdateVersions({ log });
        log(LEVELS.INFO, "wizard.update_versions", {
          installed: versionInfo.installedVersion || "unknown",
          latest: versionInfo.latestVersion || "unknown",
        });
        console.log(formatInfo(`現在: ${formatVersionLabel(versionInfo.installedVersion)}`));
        console.log(formatInfo(`最新: ${formatVersionLabel(versionInfo.latestVersion)}`));
        if (
          versionInfo.installedVersion &&
          versionInfo.latestVersion &&
          versionInfo.installedVersion === versionInfo.latestVersion
        ) {
          log(LEVELS.SUCCRSS, "wizard.update_latest_confirmed");
          console.log(formatSuccess("最新バージョンです。"));
          continue;
        }

        const updateChoice = await promptSelect({
          message: "アップデートしますか？",
          choices: [
            { title: "アップデートする", value: "update" },
            { title: "戻る", value: "back" },
            { title: "終了", value: "exit" },
          ],
          initial: 0,
        });
        if (updateChoice === "back") {
          log(LEVELS.INFO, "wizard.update_skipped");
          continue;
        }
        if (updateChoice === "exit") {
          throw new UserExit();
        }

        await ensureGlobalInstall({ log });
        const postUpdate = await fetchUpdateVersions({ log });
        log(LEVELS.SUCCRSS, "wizard.update_applied", {
          installed: postUpdate.installedVersion || "unknown",
          latest: postUpdate.latestVersion || "unknown",
        });
        console.log(formatSuccess("アップデートが完了しました。"));
        console.log(formatInfo(`現在: ${formatVersionLabel(postUpdate.installedVersion)}`));
        console.log(formatInfo(`最新: ${formatVersionLabel(postUpdate.latestVersion)}`));

        const launchdRecommended = Boolean(normalized?.features?.launchd_enabled);
        await promptLaunchdReinstall({ log, recommended: launchdRecommended });
        continue;
      }
      if (choice === "reset") {
        resetStoredConfig({ log });
        break;
      }
      if (choice === "test") {
        startFromTest = true;
        console.log("既存設定を使って通知テストから開始します。");
        break;
      }
      throw new UserExit();
    }
  }
  console.log("途中で「終了」を選んだ場合は保存せずに終了します。");
  console.log("OAuthログインでの自動連携は行いません。");
  console.log("操作方法: ↑↓ で選択 / Enter で決定");

  try {
    let dmConfig = null;
    let botToken = "";
    let appToken = "";
    if (startFromTest) {
      const dmTarget = normalized?.destinations?.dm?.target_user_id || "";
      const dmEnabled = Boolean(normalized?.destinations?.dm?.enabled);
      botToken = normalized?.slack?.bot_token || "";
      appToken = normalized?.slack?.app_token || "";
      dmConfig = { enabled: dmEnabled, targetUserId: dmTarget };

      const missing = [];
      if (!botToken) missing.push("Bot Token");
      if (!appToken) missing.push("App-Level Token");
      if (!dmTarget) missing.push("DM送信先");
      if (missing.length > 0) {
        console.log(
          formatError(`既存設定が不完全です（${missing.join(" / ")}）。`)
        );
        const next = await promptSelect({
          message: "次の操作を選んでください",
          choices: [
            { title: "リセットして最初から", value: "reset" },
            { title: "終了", value: "exit" },
          ],
        });
        if (next === "reset") {
          resetStoredConfig({ log });
          startFromTest = false;
        } else {
          throw new UserExit();
        }
      }
    }

    const selectedTools = startFromTest ? ["codex", "claude"] : await stepSelectTools({ log });
    const useCodex = selectedTools.includes("codex");
    const useClaude = selectedTools.includes("claude");

    if (!startFromTest) {
      printStep(2, "あなたのユーザーIDを教えてください");
      dmConfig = await stepDmDestination({ log });
      printStep(3, "Slack Apps 新規作成用の manifest をコピーしました");
      await offerSlackAppLinks({ log });
      printStep(4, "App-Level Tokens を入力してください");
      appToken = await stepAppLevelToken();
      log(LEVELS.SUCCRSS, "wizard.app_token_set");
      printStep(5, "OAuth Tokens を入力してください");
      botToken = await stepOAuthToken();
      log(LEVELS.SUCCRSS, "wizard.bot_token_set");
    }

    printStep(6, "Slack に通知が来ましたか？");
    const testResult = await stepNotifyTest({ log, botToken, dmConfig });
    botToken = testResult.botToken;
    dmConfig = testResult.dmConfig;
    await stepDeliveryConfirmation({ log, stage: "notify" });

    let codexEnabled = false;
    let claudeEnabled = false;
    if (!startFromTest) {
      printStep(7, "Codex/Claude の設定を行います");
      console.log(
        "SlackLocalVibeはSlackでスレッド返信することで、resumeコマンドを用いて各種CLIツールにメッセージを送信することができます。"
      );
      console.log(
        "ユーザー設定ではなくプロジェクト毎の設定などを行いたい場合は手動で設定してください。"
      );
      if (useCodex) {
        console.log("- Codex: notify に `slacklocalvibe notify --tool codex` を追加");
      }
      if (useClaude) {
        console.log("- Claude: Stop hook に `slacklocalvibe notify --tool claude` を追加");
      }

      codexEnabled = useCodex ? await stepCodexConfig({ log }) : false;
      claudeEnabled = useClaude ? await stepClaudeConfig({ log }) : false;

      printStep(8, "Slack からの返信に対応します");
      await stepReplySetup({ log });
    } else {
      codexEnabled = fs.existsSync(codexConfigPath());
      claudeEnabled = fs.existsSync(claudeSettingsPath());
    }

    printStep(9, "CLI完了時のSlack通知をテストします");
    console.log("テスト通知のために設定を一時保存します。終了した場合は元に戻します。");
    stageConfigForTests({
      log,
      config: {
        slack: {
          bot_token: botToken,
          app_token: appToken,
        },
        destinations: {
          dm: {
            enabled: dmConfig.enabled,
            target_user_id: dmConfig.targetUserId,
          },
        },
        features: {
          reply_resume: true,
          launchd_enabled: false,
        },
      },
    });
    stagedConfigWritten = true;
    await stepReplyTest({ log, targets: selectedTools });
    await stepDeliveryConfirmation({ log, stage: "reply" });

    printStep(10, "Slack スレッドに返信してみよう");
    await stepReplyThreadConfirmation({ log });
    const replyConfig = {
      enabled: true,
      appToken,
    };

    let launchdEnabled = false;
    if (replyConfig.enabled) {
      printStep(11, "launchd の自動起動を設定します");
      launchdEnabled = await stepLaunchd({ log });
    }

    const finalConfig = {
      slack: {
        bot_token: botToken,
        app_token: replyConfig.enabled ? replyConfig.appToken : "",
      },
      destinations: {
        dm: {
          enabled: dmConfig.enabled,
          target_user_id: dmConfig.targetUserId,
        },
      },
      features: {
        reply_resume: replyConfig.enabled,
        launchd_enabled: replyConfig.enabled ? launchdEnabled : false,
      },
    };

    writeConfig(finalConfig);
    didSaveFinal = true;
    log(LEVELS.SUCCRSS, "wizard.config_saved");

    printStep(12, "完了サマリ");
    printSummary({
      dmConfig,
      botToken,
      codexEnabled,
      claudeEnabled,
      replyConfig,
      launchdEnabled,
    });
  } catch (error) {
    if (error instanceof UserExit) {
      log(LEVELS.WARNING, "wizard.exit_without_save");
      if (stagedConfigWritten && !didSaveFinal) {
        try {
          restoreConfigSnapshot(configSnapshot);
          log(LEVELS.INFO, "wizard.config_restored");
        } catch (restoreError) {
          log(LEVELS.ERROR, "wizard.config_restore_failed", {
            error: safeError(restoreError),
          });
          throw restoreError;
        }
      }
      console.log("保存せずに終了しました。");
      return;
    }
    log(LEVELS.ERROR, "wizard.failed", { error: safeError(error) });
    if (stagedConfigWritten && !didSaveFinal) {
      try {
        restoreConfigSnapshot(configSnapshot);
        log(LEVELS.INFO, "wizard.config_restored");
      } catch (restoreError) {
        log(LEVELS.ERROR, "wizard.config_restore_failed", {
          error: safeError(restoreError),
        });
        throw restoreError;
      }
    }
    console.log(formatError("エラーが発生しました。詳細はログを確認してください。"));
    process.exitCode = 1;
  }
}

async function stepDmDestination({ log }) {
  console.log("Slackプロフィールで「メンバーIDをコピー」を押し、U... を取得してください。");
  const targetUserId = await promptText({
    message: "DM送信先のユーザーID（U...）を入力してください",
    validate: (value) =>
      value && value.startsWith("U") ? true : "U... 形式のユーザーIDを入力してください",
  });

  log(LEVELS.SUCCRSS, "wizard.dm_set");
  return { enabled: true, targetUserId };
}

async function stepSelectTools({ log }) {
  while (true) {
    printStep(1, "対応するCLIを選択してください");
    const selected = await promptMultiSelect({
      message: "対応するCLIを選択してください",
      choices: [
        { title: "Codex", value: "codex", selected: true },
        { title: "Claude", value: "claude", selected: true },
      ],
    });
    if (selected.length === 0) {
      console.log(formatError("少なくとも1つ選択してください。"));
      continue;
    }
    log(LEVELS.SUCCRSS, "wizard.tools_selected", { tools: selected });
    return selected;
  }
}

async function stepReplySetup({ log }) {
  console.log("Slack からの返信を受け取るには slacklocalvibe コマンドが必要です。");
  while (true) {
    const choice = await promptSelect({
      message: "次の操作を選んでください",
      choices: [
        { title: "npm i -g slacklocalvibe で登録する（必須）", value: "install" },
        { title: "終了", value: "exit" },
      ],
      initial: 0,
    });
    if (choice === "install") {
      await ensureGlobalInstall({ log });
      return;
    }
    throw new UserExit();
  }
}

async function stepAppLevelToken() {
  console.log("アプリ作成後に表示される「Basic Information」ページの少し下に");
  console.log("「App-Level Tokens」があります。そこで App-Level Tokens を発行してください。");
  console.log("スコープは次の3つをすべて選択してください:");
  console.log("connections:write / authorizations:read / app_configurations:read");
  const token = await promptToken({
    message: "App-Level Tokens（xapp-...）を入力してください",
    validate: (value) => {
      const cleaned = value.trim().replace(/\s+/g, "");
      return cleaned && cleaned.startsWith("xapp-")
        ? true
        : "xapp- で始まるトークンを入力してください";
    },
  });
  return token.trim().replace(/\s+/g, "");
}

async function stepOAuthToken() {
  console.log("左メニューの「Features > OAuth & Permissions」を開きます。");
  console.log("「Install to Workspace（または Reinstall）」を実行して OAuth Tokens を発行します。");
  console.log("発行された「Bot User OAuth Token（xoxb-...）」をコピーして入力します。");
  const token = await promptToken({
    message: "OAuth Tokens（xoxb-...）を入力してください",
    validate: (value) => {
      const cleaned = value.trim().replace(/\s+/g, "");
      return cleaned && cleaned.startsWith("xoxb-")
        ? true
        : "xoxb- で始まるトークンを入力してください";
    },
  });
  return token.trim().replace(/\s+/g, "");
}

async function stepNotifyTest({ log, botToken, dmConfig }) {
  while (true) {
    try {
      await sendTestNotification({ log, botToken, dmConfig });
      console.log(formatSuccess("通知テストに成功しました。"));
      log(LEVELS.SUCCRSS, "wizard.notify_test_ok");
      return { botToken, dmConfig };
    } catch (error) {
      log(LEVELS.ERROR, "wizard.notify_test_failed", { error: safeError(error) });
      const errorCode = error?.code || error?.data?.error || error?.message || "unknown";
      console.log(
        formatError(`通知テストに失敗しました。エラーコード: ${errorCode}`)
      );
      const choice = await promptSelect({
        message: "次の操作を選んでください",
        choices: [
          { title: "Bot Token を再入力する", value: "retry_token" },
          { title: "送信先（DM）を見直す", value: "retry_dm" },
          { title: "終了", value: "exit" },
        ],
      });
      if (choice === "retry_token") {
        botToken = await stepOAuthToken();
        log(LEVELS.SUCCRSS, "wizard.bot_token_set");
        continue;
      }
      if (choice === "retry_dm") {
        dmConfig = await stepDmDestination({ log });
        continue;
      }
      throw new UserExit();
    }
  }
}

async function sendTestNotification({ log, botToken, dmConfig }) {
  const client = createWebClient(botToken);
  const channel = await openDmChannel({
    client,
    log,
    userId: dmConfig.targetUserId,
  });
  if (!channel) {
    throw new Error("DM channel を取得できませんでした。");
  }
  await postMessage({
    client,
    log,
    channel,
    text: "SlackLocalVibe 通知テスト: OK",
  });
}

async function stepCodexConfig({ log }) {
  const exists = fs.existsSync(codexConfigPath());
  const choice = await promptSelect({
    message: "Codex（ユーザー設定）を更新しますか？",
    choices: [
      { title: "有効にする", value: "enable" },
      { title: "いまはしない", value: "disable" },
    ],
    initial: exists ? 0 : 1,
  });
  if (choice === "disable") {
    log(LEVELS.INFO, "wizard.codex_disabled");
    return false;
  }
  while (true) {
    try {
      updateCodexNotify();
      log(LEVELS.SUCCRSS, "wizard.codex_updated");
      return true;
    } catch (error) {
      log(LEVELS.ERROR, "wizard.codex_update_failed", { error: safeError(error) });
      const next = await promptSelect({
        message: "Codex設定の更新に失敗しました。次の操作を選んでください",
        choices: [
          { title: "再試行", value: "retry" },
          { title: "終了", value: "exit" },
        ],
      });
      if (next === "retry") continue;
      throw new UserExit();
    }
  }
}

async function stepClaudeConfig({ log }) {
  const exists = fs.existsSync(claudeSettingsPath());
  const choice = await promptSelect({
    message: "Claude Code（ユーザー設定）を更新しますか？",
    choices: [
      { title: "有効にする", value: "enable" },
      { title: "いまはしない", value: "disable" },
    ],
    initial: exists ? 0 : 1,
  });
  if (choice === "disable") {
    log(LEVELS.INFO, "wizard.claude_disabled");
    return false;
  }
  while (true) {
    try {
      updateClaudeStopHook();
      log(LEVELS.SUCCRSS, "wizard.claude_updated");
      return true;
    } catch (error) {
      log(LEVELS.ERROR, "wizard.claude_update_failed", { error: safeError(error) });
      const next = await promptSelect({
        message: "Claude設定の更新に失敗しました。次の操作を選んでください",
        choices: [
          { title: "再試行", value: "retry" },
          { title: "終了", value: "exit" },
        ],
      });
      if (next === "retry") continue;
      throw new UserExit();
    }
  }
}

async function stepReplyTest({ log, targets }) {
  if (!targets || targets.length === 0) {
    throw new Error("テスト対象のCLIがないため返信テストを実行できません。");
  }

  await ensureDaemonStarted({ log });

  for (const tool of targets) {
    await runTestCommand({ log, tool });
  }
}

async function stepDeliveryConfirmation({ log, stage }) {
  const isNotify = stage === "notify";
  const okLog = isNotify
    ? "wizard.notify_delivery_confirmed"
    : "wizard.reply_test_confirmed";
  const logsLog = isNotify
    ? "wizard.notify_delivery_logs_requested"
    : "wizard.reply_test_logs_requested";
  while (true) {
    const choice = await promptSelect({
      message: "Slack通知は届きましたか？",
      choices: [
        { title: "届いたので次へ進む", value: "ok" },
        { title: "届いていないのでログを表示する", value: "logs" },
        { title: "終了", value: "exit" },
      ],
    });
    if (choice === "ok") {
      log(LEVELS.SUCCRSS, okLog);
      return;
    }
    if (choice === "logs") {
      log(LEVELS.INFO, logsLog);
      showLogFiles();
      continue;
    }
    throw new UserExit();
  }
}

async function stepReplyThreadConfirmation({ log }) {
  console.log("Slack の通知スレッドに返信して resume が動くことを確認します。");
  console.log("例: あなたはなにができる？");
  while (true) {
    const choice = await promptSelect({
      message: "次の操作を選んでください",
      choices: [
        { title: "resume結果が新しいスレッドで届いた", value: "ok" },
        { title: "届かなかった。ログ表示", value: "logs" },
        { title: "終了", value: "exit" },
      ],
    });
    if (choice === "ok") {
      log(LEVELS.SUCCRSS, "wizard.reply_thread_confirmed");
      return;
    }
    if (choice === "logs") {
      log(LEVELS.INFO, "wizard.reply_thread_logs_requested");
      showLogFiles();
      continue;
    }
    throw new UserExit();
  }
}

function startDaemonInBackground({ log }) {
  try {
    const binaryPath = resolveBinaryPath();
    const ok = spawnDetached({
      command: binaryPath,
      args: ["daemon"],
      cwd: process.cwd(),
      log,
      label: "wizard.daemon_autostart_failed",
    });
    if (ok) {
      log(LEVELS.SUCCRSS, "wizard.daemon_autostarted", { mode: "global" });
      return true;
    }
  } catch (error) {
    log(LEVELS.ERROR, "wizard.daemon_autostart_failed", { error: safeError(error) });
  }

  log(LEVELS.ERROR, "wizard.daemon_autostart_unavailable");
  return false;
}

async function ensureDaemonStarted({ log }) {
  const started = startDaemonInBackground({ log });
  if (started) return;
  log(LEVELS.ERROR, "wizard.daemon_autostart_required");
  console.log(formatError("daemon の自動起動に失敗しました。"));
  throw new Error("daemon の自動起動に失敗しました。");
}

async function runTestCommand({ log, tool }) {
  while (true) {
    try {
      const toolLabel = tool === "codex" ? "Codex" : "Claude";
      const commandPath = resolveCommandPathStrict(tool === "codex" ? "codex" : "claude");
      console.log(formatInfo(`${toolLabel} にテストコマンドを送信中...`));
      console.log(`テストプロンプト：${TEST_PROMPT}`);
      const result = await spawnCommand({
        command: commandPath,
        args:
          tool === "codex"
            ? ["exec", "--skip-git-repo-check", TEST_PROMPT]
            : ["-p", TEST_PROMPT],
        cwd: process.cwd(),
      });
      if (result.code !== 0) {
        const detail = result.stderrText || result.stdoutText || "";
        const err = new Error(`${toolLabel} テストコマンドに失敗しました。`);
        err.detail = detail.trim();
        err.code = result.code;
        throw err;
      }
      log(LEVELS.SUCCRSS, "wizard.reply_test_ok", {
        tool,
        stdout_len: result.stdoutLen,
        stderr_len: result.stderrLen,
      });
      console.log(
        formatSuccess(
          `${toolLabel} のテストコマンドを送信しました。Slack通知を確認してください。`
        )
      );
      return;
    } catch (error) {
      log(LEVELS.ERROR, "wizard.reply_test_failed", { tool, error: safeError(error) });
      const detail = error?.detail || error?.message || "unknown";
      console.log(formatError(`${toolLabel} のテストに失敗しました。`));
      console.log(formatError(`詳細: ${detail}`));
      const next = await promptSelect({
        message: "次の操作を選んでください",
        choices: [
          { title: "再試行", value: "retry" },
          { title: "終了", value: "exit" },
        ],
      });
      if (next === "retry") continue;
      throw new UserExit();
    }
  }
}

async function stepLaunchd({ log }) {
  console.log("daemon は待ち受け中心で、CPU/メモリ消費はごく小さいです。");
  console.log("launchd に登録してログイン時に自動起動します。");

  const firstChoice = await promptSelect({
    message: "次の操作を選んでください",
    choices: [
      { title: "launchd に登録する（推奨）", value: "install" },
      { title: "スキップして次へ進む", value: "skip" },
      { title: "終了", value: "exit" },
    ],
    initial: 0,
  });
  if (firstChoice === "skip") {
    log(LEVELS.INFO, "wizard.launchd_skipped");
    return false;
  }
  if (firstChoice === "exit") {
    throw new UserExit();
  }

  await ensureGlobalInstall({ log });

  while (true) {
    try {
      installLaunchd();
      log(LEVELS.SUCCRSS, "wizard.launchd_installed");
      return true;
    } catch (error) {
      log(LEVELS.ERROR, "wizard.launchd_failed", { error: safeError(error) });
      console.log(formatError("launchd 登録に失敗しました。"));
      const detail =
        error?.detail ||
        error?.stderrText ||
        error?.stdoutText ||
        error?.message ||
        "unknown";
      if (detail) {
        console.log(formatError(detail));
      }
      const next = await promptSelect({
        message: "次の操作を選んでください",
        choices: [
          { title: "再試行", value: "retry" },
          { title: "スキップして次へ進む", value: "skip" },
          { title: "終了", value: "exit" },
        ],
      });
      if (next === "retry") continue;
      if (next === "skip") {
        log(LEVELS.WARNING, "wizard.launchd_skipped_after_error");
        return false;
      }
      throw new UserExit();
    }
  }
}

function printSummary({
  dmConfig,
  botToken,
  codexEnabled,
  claudeEnabled,
  replyConfig,
  launchdEnabled,
}) {
  console.log("\n完了サマリ");
  console.log(`- 設定ファイル: ${configPath()}`);
  console.log(`- 送信先: DM (${mask(dmConfig.targetUserId)})`);
  console.log(`- 通知: ${botToken ? "ON" : "OFF"}`);
  console.log(`- Codex設定: ${codexEnabled ? "反映済み" : "未反映"}`);
  console.log(`- Claude設定: ${claudeEnabled ? "反映済み" : "未反映"}`);
  console.log(`- 返信: ${replyConfig.enabled ? "ON" : "OFF"}`);
  console.log(`- 常駐: ${launchdEnabled ? "ON" : "OFF"}`);
  console.log("\nでは、CodexやClaudeに依頼をしてみましょう。");
  console.log(
    "Slackに通知が来て、返信すればそこから会話を続けることができます。"
  );
  console.log(`\n${bannerLines().join("\n")}\n`);
}

function mask(value) {
  if (!value) return "";
  if (value.length <= 6) return `${value.slice(0, 2)}***`;
  return `${value.slice(0, 4)}...${value.slice(-2)}`;
}

async function offerSlackAppLinks({ log }) {
  await copyManifestToClipboard({ log });
  console.log("Slack Apps 新規作成で「From a manifest（YAML）」を選び、貼り付けて作成してください。");

  const choice = await promptSelect({
    message: "次へ進む",
    choices: [{ title: "Slack Apps 新規作成を開く", value: "new" }],
  });
  if (choice === "new") {
    openUrl(SLACK_NEW_APP_URL);
  }
}

function openUrl(url) {
  const openPath = resolveCommandPathStrict("open");
  const result = spawnSync(openPath, [url], {
    stdio: "pipe",
    env: process.env,
  });
  if (result.status !== 0) {
    const stderrText = (result.stderr || "").toString("utf8").trim();
    const stdoutText = (result.stdout || "").toString("utf8").trim();
    const detail = stderrText || stdoutText || "";
    const err = new Error("URL を開けませんでした。");
    err.detail = detail;
    throw err;
  }
}

function bannerLines() {
  return [
    "   _____ _            _    _                    ___      ___ _          ",
    " / ____| |          | |  | |                  | \\ \\    / (_) |         ",
    "| (___ | | __ _  ___| | _| |     ___   ___ __ _| |\\ \\  / / _| |__   ___ ",
    " \\___ \\| |/ _` |/ __| |/ / |    / _ \\ / __/ _` | | \\ \\/ / | | '_ \\ / _ \\",
    " ____) | | (_| | (__|   <| |___| (_) | (_| (_| | |  \\  /  | | |_) |  __/",
    "|_____/|_|\\__,_|\\___|_|\\_\\_____/\\___/ \\___\\__,_|_|   \\/   |_|_.__/ \\___|",
  ];
}

function printBanner() {
  console.log(`\n\n\n${bannerLines().join("\n")}\n\n\n`);
}

function printStep(step, title) {
  console.log("\n----------------------------------------");
  console.log(formatStepTitle(`[STEP ${step}/${TOTAL_STEPS}] ${title}`));
}

async function promptSelect({ message, choices, initial = 0 }) {
  const response = await prompts(
    {
      type: "select",
      name: "value",
      message,
      choices,
      initial,
      instructions: false,
    },
    { onCancel: () => { throw new UserExit(); } }
  );
  return response.value;
}

async function promptMultiSelect({ message, choices }) {
  console.log("操作方法: ↑/↓ で選択、space で切替、Enter で確定");
  const response = await prompts(
    {
      type: "multiselect",
      name: "value",
      message,
      choices,
      instructions: false,
    },
    { onCancel: () => { throw new UserExit(); } }
  );
  return response.value || [];
}

async function promptText({ message, validate }) {
  return promptLine({
    message,
    validate,
    normalize: (value) => value.trim(),
  });
}

async function promptToken({ message, validate }) {
  return promptLine({
    message,
    validate,
    normalize: (value) => value.trim().replace(/\s+/g, ""),
  });
}

// promptPassword uses readline to echo input and avoid multi-line paste artifacts.

function spawnCommand({ command, args, cwd }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, PATH: defaultPathEnv() },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdoutLen = 0;
    let stderrLen = 0;
    let stdoutText = "";
    let stderrText = "";
    const limit = 4000;
    child.stdout.on("data", (chunk) => {
      stdoutLen += chunk.length;
      if (stdoutText.length < limit) {
        stdoutText += chunk.toString("utf8").slice(0, limit - stdoutText.length);
      }
    });
    child.stderr.on("data", (chunk) => {
      stderrLen += chunk.length;
      if (stderrText.length < limit) {
        stderrText += chunk.toString("utf8").slice(0, limit - stderrText.length);
      }
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) =>
      resolve({ code, stdoutLen, stderrLen, stdoutText, stderrText })
    );
  });
}

function spawnDetached({ command, args, cwd, log, label }) {
  try {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, PATH: defaultPathEnv() },
      stdio: "ignore",
      detached: true,
    });
    child.on("error", (error) => {
      log(LEVELS.ERROR, label, { error: safeError(error) });
    });
    child.unref();
    return true;
  } catch (error) {
    log(LEVELS.ERROR, label, { error: safeError(error) });
    return false;
  }
}

async function copyManifestToClipboard({ log }) {
  while (true) {
    try {
      const pbcopyPath = resolveCommandPathStrict("pbcopy");
      const result = await spawnCommandWithInput({
        command: pbcopyPath,
        args: [],
        cwd: process.cwd(),
        input: SLACK_MANIFEST,
      });
      if (result.code !== 0) {
        throw new Error("pbcopy に失敗しました。");
      }
      log(LEVELS.SUCCRSS, "wizard.manifest_copied");
      return;
    } catch (error) {
      log(LEVELS.ERROR, "wizard.manifest_copy_failed", { error: safeError(error) });
      console.log("manifest のコピーに失敗しました。");
      const next = await promptSelect({
        message: "次の操作を選んでください",
        choices: [
          { title: "再試行", value: "retry" },
          { title: "終了", value: "exit" },
        ],
      });
      if (next === "retry") continue;
      throw new UserExit();
    }
  }
}

function spawnCommandWithInput({ command, args, cwd, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, PATH: defaultPathEnv() },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdoutLen = 0;
    let stderrLen = 0;
    child.stdout.on("data", (chunk) => {
      stdoutLen += chunk.length;
    });
    child.stderr.on("data", (chunk) => {
      stderrLen += chunk.length;
    });
    child.on("error", (error) => reject(error));
    child.on("close", (code) => resolve({ code, stdoutLen, stderrLen }));
    child.stdin.write(input || "");
    child.stdin.end();
  });
}

function captureConfigSnapshot() {
  const filePath = configPath();
  if (!fs.existsSync(filePath)) {
    return { filePath, raw: null };
  }
  return { filePath, raw: fs.readFileSync(filePath, "utf8") };
}

function restoreConfigSnapshot(snapshot) {
  if (!snapshot) return;
  const dir = path.dirname(snapshot.filePath);
  fs.mkdirSync(dir, { recursive: true });
  if (snapshot.raw === null) {
    if (fs.existsSync(snapshot.filePath)) {
      fs.unlinkSync(snapshot.filePath);
    }
    return;
  }
  fs.writeFileSync(snapshot.filePath, snapshot.raw, "utf8");
  try {
    fs.chmodSync(snapshot.filePath, 0o600);
  } catch (error) {
    const err = new Error(
      `設定ファイルの権限変更に失敗しました: ${snapshot.filePath}`
    );
    err.cause = error;
    throw err;
  }
}

function stageConfigForTests({ config, log }) {
  writeConfig(config);
  log(LEVELS.SUCCRSS, "wizard.config_staged");
}

function resetStoredConfig({ log }) {
  const configFile = configPath();
  const routesFile = routesPath();
  const beforeConfig = fs.existsSync(configFile);
  const beforeRoutes = fs.existsSync(routesFile);
  if (beforeConfig) {
    fs.unlinkSync(configFile);
  }
  if (beforeRoutes) {
    fs.unlinkSync(routesFile);
  }
  log(LEVELS.SUCCRSS, "wizard.config_reset", {
    config_removed: beforeConfig,
    routes_removed: beforeRoutes,
  });
  console.log(formatSuccess("既存設定をリセットしました。"));
}

function showLogFiles() {
  const targets = [
    { label: "notify", path: notifyLogPath() },
    { label: "daemon", path: daemonLogPath() },
    { label: "wizard", path: wizardLogPath() },
  ];
  console.log(formatInfo("ログの場所:"));
  for (const target of targets) {
    console.log(`- ${target.label}: ${target.path}`);
  }
  for (const target of targets) {
    console.log(formatInfo(`----- ${target.label} (${target.path}) -----`));
    if (!fs.existsSync(target.path)) {
      console.log(formatError("ログが見つかりません。"));
      continue;
    }
    const content = fs.readFileSync(target.path, "utf8");
    if (!content.trim()) {
      console.log("（空）");
      continue;
    }
    console.log(content);
  }
}

async function ensureGlobalInstall({ log }) {
  while (true) {
    try {
      const installTarget = "slacklocalvibe";
      log(LEVELS.INFO, "wizard.npm_global_target", {
        target: "registry",
      });
      const npmPath = resolveCommandPathStrict("npm");
      const result = await spawnCommand({
        command: npmPath,
        args: ["install", "-g", installTarget],
        cwd: process.cwd(),
      });
      if (result.code !== 0) {
        const detail = result.stderrText || result.stdoutText || "";
        const err = new Error("npm install -g slacklocalvibe に失敗しました。");
        err.detail = detail.trim();
        throw err;
      }
      log(LEVELS.SUCCRSS, "wizard.npm_global_ok", {
        stdout_len: result.stdoutLen,
        stderr_len: result.stderrLen,
      });
      return;
    } catch (error) {
      log(LEVELS.ERROR, "wizard.npm_global_failed", { error: safeError(error) });
      const detail = error?.detail || error?.message || "unknown";
      console.log(formatError("npm -g インストールに失敗しました。"));
      console.log(formatError(`詳細: ${detail}`));
      const next = await promptSelect({
        message: "次の操作を選んでください",
        choices: [
          { title: "再試行", value: "retry" },
          { title: "終了", value: "exit" },
        ],
      });
      if (next === "retry") continue;
      throw new UserExit();
    }
  }
}

async function fetchUpdateVersions({ log }) {
  const [installedVersion, latestVersion] = await Promise.all([
    fetchInstalledVersion({ log }),
    fetchRegistryVersion({ log }),
  ]);
  return { installedVersion, latestVersion };
}

async function fetchInstalledVersion({ log }) {
  try {
    const binaryPath = resolveBinaryPath();
    const result = await spawnCommand({
      command: binaryPath,
      args: ["--version"],
      cwd: process.cwd(),
    });
    if (result.code === 0) {
      const version = (result.stdoutText || "").trim().split(/\s+/)[0];
      if (version) return version;
    }
    log(LEVELS.WARNING, "wizard.update_installed_version_empty", {
      stdout_len: result.stdoutLen,
      stderr_len: result.stderrLen,
    });
  } catch (error) {
    log(LEVELS.WARNING, "wizard.update_installed_version_failed", {
      error: safeError(error),
    });
  }
  return "";
}

async function fetchRegistryVersion({ log }) {
  try {
    const npmPath = resolveCommandPathStrict("npm");
    const result = await spawnCommand({
      command: npmPath,
      args: ["view", "slacklocalvibe", "version"],
      cwd: process.cwd(),
    });
    if (result.code === 0) {
      const version = (result.stdoutText || "").trim().split(/\s+/)[0];
      if (version) return version;
    }
    log(LEVELS.WARNING, "wizard.update_registry_version_empty", {
      stdout_len: result.stdoutLen,
      stderr_len: result.stderrLen,
    });
  } catch (error) {
    log(LEVELS.WARNING, "wizard.update_registry_version_failed", {
      error: safeError(error),
    });
  }
  return "";
}

function formatVersionLabel(version) {
  return version ? version : "不明";
}

async function promptLaunchdReinstall({ log, recommended }) {
  const title = recommended
    ? "launchd を再登録する（推奨）"
    : "launchd を再登録する";
  while (true) {
    const choice = await promptSelect({
      message: "更新後に launchd を再登録します",
      choices: [
        { title, value: "install" },
        { title: "あとでやる", value: "skip" },
        { title: "終了", value: "exit" },
      ],
      initial: 0,
    });
    if (choice === "skip") {
      log(LEVELS.INFO, "wizard.launchd_reinstall_skipped");
      return;
    }
    if (choice === "exit") {
      throw new UserExit();
    }
    try {
      installLaunchd();
      log(LEVELS.SUCCRSS, "wizard.launchd_reinstalled");
      console.log(formatSuccess("launchd を再登録しました。"));
      return;
    } catch (error) {
      log(LEVELS.ERROR, "wizard.launchd_reinstall_failed", {
        error: safeError(error),
      });
      console.log(formatError("launchd の再登録に失敗しました。"));
      const detail =
        error?.detail ||
        error?.stderrText ||
        error?.stdoutText ||
        error?.message ||
        "unknown";
      if (detail) {
        console.log(formatError(detail));
      }
      const next = await promptSelect({
        message: "次の操作を選んでください",
        choices: [
          { title: "再試行", value: "retry" },
          { title: "あとでやる", value: "skip" },
          { title: "終了", value: "exit" },
        ],
      });
      if (next === "retry") continue;
      if (next === "skip") {
        log(LEVELS.WARNING, "wizard.launchd_reinstall_skipped_after_error");
        return;
      }
      throw new UserExit();
    }
  }
}

async function promptPassword({ message, validate }) {
  while (true) {
    const value = await promptVisible({ message });
    const cleaned = value.trim().replace(/\s+/g, "");
    const result = validate ? validate(cleaned) : true;
    if (result === true) {
      return cleaned;
    }
    console.log(typeof result === "string" ? result : "入力が不正です。");
  }
}

async function promptLine({ message, validate, normalize }) {
  while (true) {
    const value = await promptVisible({ message });
    const normalized = normalize ? normalize(value) : value;
    const cleaned = String(normalized ?? "").trim();
    const result = validate ? validate(cleaned) : true;
    if (result === true) {
      return cleaned;
    }
    console.log(typeof result === "string" ? result : "入力が不正です。");
  }
}

function promptVisible({ message }) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    rl.question(`${message} `, (answer) => {
      rl.history = rl.history.slice(1);
      rl.close();
      resolve(answer || "");
    });
    rl.on("SIGINT", () => {
      rl.close();
      reject(new UserExit());
    });
  });
}

function styleText(text, { color = "", bold = false } = {}) {
  if (!USE_COLOR) return text;
  const codes = [];
  if (bold) codes.push(ANSI.bold);
  if (color) codes.push(color);
  return `${codes.join("")}${text}${ANSI.reset}`;
}

function formatStepTitle(text) {
  return styleText(text, { color: ANSI.cyan, bold: true });
}

function formatSuccess(text) {
  return styleText(text, { color: ANSI.green, bold: true });
}

function formatError(text) {
  return styleText(text, { color: ANSI.red, bold: true });
}

function formatInfo(text) {
  return styleText(text, { color: ANSI.yellow, bold: true });
}

module.exports = {
  runWizard,
};
