#!/usr/bin/env node
const { Command } = require("commander");
const { runWizard } = require("./commands/wizard");
const { runNotify } = require("./commands/notify");
const { runDaemon } = require("./commands/daemon");
const { runLaunchd } = require("./commands/launchd");
const packageJson = require("../package.json");

const program = new Command();

program
  .name("slacklocalvibe")
  .description("SlackLocalVibe: Slack DM通知 + 返信resumeブリッジ")
  .version(packageJson.version);

program
  .command("notify")
  .argument("[payload]", "notify payload json")
  .requiredOption("--tool <tool>", "codex | claude")
  .action(async (_payload, options) => {
    await runNotify({ tool: options.tool });
  });

program.command("daemon").action(async () => {
  await runDaemon();
});

program
  .command("launchd")
  .argument("<action>", "install | uninstall | status")
  .action(async (action) => {
    await runLaunchd(action);
  });

program.action(async () => {
  await runWizard();
});

program.parseAsync(process.argv);
