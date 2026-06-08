#!/usr/bin/env node
import { AccountSwitcher } from "./manager";
import { formatWindow, scoreAccount } from "./rateLimits";
import { sanitizeError } from "./auth";
import { runInteractiveCli } from "./interactiveCli";
import { runSwitchAccountSlashCommand } from "./slashCommand";
import {
  describeSettings,
  isAppServerRestartMode,
  isApprovalPolicy,
  isModelPreset,
  isReasoningEffort,
  isSandboxMode,
  isSpeedTier,
} from "./settings";
import { AppliedCodexConfig, ManagerOptions, SwitcherSettingsUpdate } from "./types";

interface ParsedArgs {
  command?: string;
  values: string[];
  flags: Record<string, string | true>;
}

async function main(): Promise<void> {
  const rawArgv = process.argv.slice(2);
  const rawSlash = readRawSlashCommand(rawArgv);
  const args = parseArgs(rawArgv);
  const options: ManagerOptions = {
    codexHome: stringFlag(args, "codex-home"),
    accountLibraryPath: stringFlag(args, "store"),
    codexCliPath: stringFlag(args, "codex-cli"),
  };
  const switcher = new AccountSwitcher(options);

  if (rawSlash) {
    const result = await runSwitchAccountSlashCommand(rawSlash.text, switcher);
    output({ ...args, flags: { ...args.flags, json: rawSlash.json || args.flags.json } }, result, result.message);
    return;
  }

  switch (args.command) {
    case undefined:
    case "help":
    case "-h":
    case "--help": {
      printHelp(args);
      return;
    }
    case "add-current": {
      const account = await switcher.addCurrent(stringFlag(args, "label"));
      output(args, account, `已保存当前账号：${account.label}`);
      return;
    }
    case "import": {
      const fromFlag = stringFlag(args, "from");
      const from = fromFlag || args.values[0];
      if (!from) {
        throw new Error("请提供 --from <path>。");
      }
      const positionalLabel = fromFlag ? args.values.join(" ") : args.values.slice(1).join(" ");
      const account = await switcher.importAuth(from, stringFlag(args, "label") || positionalLabel || undefined);
      output(args, account, `已导入账号：${account.label}`);
      return;
    }
    case "list": {
      const accounts = await switcher.list();
      output(args, accounts, renderList(accounts));
      return;
    }
    case "ui":
    case "menu":
    case "interactive": {
      await runInteractiveCli(switcher);
      return;
    }
    case "refresh-limits": {
      const accounts = await switcher.refreshLimits(booleanFlag(args, "all") ? undefined : args.values[0]);
      output(args, accounts, renderList(accounts));
      return;
    }
    case "switch": {
      const result = booleanFlag(args, "best") ? await switcher.switchBest() : await switcher.switchAccount(args.values[0]);
      output(args, result, result.message);
      return;
    }
    case "slash": {
      const result = await runSwitchAccountSlashCommand(readLegacySlashText(rawArgv), switcher);
      output(args, result, result.message);
      return;
    }
    case "status": {
      const status = await switcher.status();
      output(args, status, status ? `当前账号：${status.label}` : "当前账号未保存在账号库中。");
      return;
    }
    case "doctor": {
      const report = await switcher.doctor();
      output(args, report, JSON.stringify(report, null, 2));
      return;
    }
    case "defaults": {
      await handleDefaults(args, switcher);
      return;
    }
    default:
      throw new Error(`未知命令：${args.command}。请使用 /switch-account help 查看用法。`);
  }
}

async function handleDefaults(args: ParsedArgs, switcher: AccountSwitcher): Promise<void> {
  const action = args.values[0] || "show";
  switch (action) {
    case "show": {
      const settings = await switcher.getSettings();
      output(args, settings, renderSettings(settings));
      return;
    }
    case "set": {
      const update = readSettingsUpdate(args);
      if (Object.keys(update).length === 0) {
        throw new Error("请提供要设置的默认运行配置。");
      }
      const settings = await switcher.updateSettings(update);
      output(args, settings, `已保存默认运行配置：${describeSettings(settings)}`);
      return;
    }
    case "preset": {
      const preset = args.values[1];
      if (!isModelPreset(preset)) {
        throw new Error("请提供模型预设：speed、balanced、smart 或 custom。");
      }
      const settings = await switcher.updateSettings({ ...readSettingsUpdate(args), modelPreset: preset });
      output(args, settings, `已保存模型预设：${describeSettings(settings)}`);
      return;
    }
    case "apply": {
      const result = await switcher.applyDefaults();
      output(args, result, renderApplyResult(result));
      return;
    }
    default:
      throw new Error("defaults 支持 show、set、preset、apply。");
  }
}

function renderList(accounts: Awaited<ReturnType<AccountSwitcher["list"]>>): string {
  if (accounts.length === 0) {
    return "暂无账号。可以运行 /switch-account 保存当前 <名称> 或 /switch-account import <auth.json路径> <名称>。";
  }
  return accounts
    .map((account) => {
      const five = account.windows.find((window) => window.kind === "5h");
      const seven = account.windows.find((window) => window.kind === "7d");
      const active = account.active ? "当前" : "    ";
      const error = account.error ? `  余额读取失败：${account.error}` : "";
      return `${active}  ${account.label}  5小时 ${formatWindow(five)}  7天 ${formatWindow(seven)}  瓶颈 ${formatScore(account)}${error}`;
    })
    .join("\n");
}

function formatScore(account: Awaited<ReturnType<AccountSwitcher["list"]>>[number]): string {
  const score = scoreAccount(account);
  return score < 0 ? "未知" : `${Math.max(0, Math.round(score))}%`;
}

function output(args: ParsedArgs, value: unknown, text: string): void {
  if (jsonFlag(args)) {
    process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  } else {
    process.stdout.write(`${text}\n`);
  }
}

function readSettingsUpdate(args: ParsedArgs): SwitcherSettingsUpdate {
  const update: SwitcherSettingsUpdate = {};
  const applyAfterSwitch = booleanFlag(args, "apply-after-switch");
  if (applyAfterSwitch !== undefined) {
    update.applyAfterSwitch = applyAfterSwitch;
  }
  if (args.flags["no-apply-after-switch"]) {
    update.applyAfterSwitch = false;
  }
  const restartAfterSwitch = booleanFlag(args, "restart-app-server-after-switch");
  if (restartAfterSwitch !== undefined) {
    update.restartAppServerAfterSwitch = restartAfterSwitch;
  }
  if (args.flags["no-restart-app-server-after-switch"]) {
    update.restartAppServerAfterSwitch = false;
  }
  const appServerRestartMode = stringFlag(args, "app-server-restart-mode");
  if (appServerRestartMode) {
    if (!isAppServerRestartMode(appServerRestartMode)) {
      throw new Error("app-server 刷新模式只能是 auto、daemon 或 codex-app。");
    }
    update.appServerRestartMode = appServerRestartMode;
  }
  const sandboxMode = stringFlag(args, "sandbox");
  if (sandboxMode) {
    if (!isSandboxMode(sandboxMode)) {
      throw new Error("权限只能是 read-only、workspace-write 或 danger-full-access。");
    }
    update.sandboxMode = sandboxMode;
  }
  const approvalPolicy = stringFlag(args, "approval");
  if (approvalPolicy) {
    if (!isApprovalPolicy(approvalPolicy)) {
      throw new Error("审批策略只能是 untrusted、on-request 或 never。");
    }
    update.approvalPolicy = approvalPolicy;
  }
  const modelPreset = stringFlag(args, "preset");
  if (modelPreset) {
    if (!isModelPreset(modelPreset)) {
      throw new Error("模型预设只能是 speed、balanced、smart 或 custom。");
    }
    update.modelPreset = modelPreset;
  }
  const model = stringFlag(args, "model");
  if (model) {
    update.modelPreset = update.modelPreset || "custom";
    update.model = model;
  }
  const effort = stringFlag(args, "effort");
  if (effort) {
    if (!isReasoningEffort(effort)) {
      throw new Error("reasoning effort 只能是 minimal、low、medium、high 或 xhigh。");
    }
    update.modelPreset = update.modelPreset || "custom";
    update.modelReasoningEffort = effort;
  }
  const speed = stringFlag(args, "speed");
  if (speed) {
    if (!isSpeedTier(speed)) {
      throw new Error("速度档只能是 standard 或 fast。");
    }
    update.speedTier = speed;
  }
  return update;
}

function renderSettings(settings: Awaited<ReturnType<AccountSwitcher["getSettings"]>>): string {
  return `默认运行配置：${describeSettings(settings)}

可用预设：
  speed    速度优先：gpt-5.4-mini / low / standard
  balanced 均衡：gpt-5.5 / medium / standard
  smart    智能优先：gpt-5.5 / xhigh / fast
  custom   自定义模型名和 reasoning effort

运行态：
  --restart-app-server-after-switch true   切换后自动刷新 app-server 运行态
  --app-server-restart-mode auto           auto: daemon 失败时刷新 Codex App app-server
  --app-server-restart-mode daemon         只重启 standalone/远程 daemon
  --app-server-restart-mode codex-app      只刷新 macOS Codex App app-server
  --no-restart-app-server-after-switch     切换后不刷新 app-server`;
}

function renderApplyResult(result: AppliedCodexConfig | null): string {
  if (!result) {
    return "没有可应用的默认运行配置。";
  }
  if (result.changedKeys.length === 0) {
    return "默认运行配置已是最新。";
  }
  return `已应用默认运行配置：${result.changedKeys.join(", ")}。`;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { values: [], flags: {} };
  for (let index = 0; index < argv.length; index++) {
    const part = argv[index];
    if (part.startsWith("--")) {
      const [rawKey, rawValue] = part.slice(2).split("=", 2);
      if (rawValue != null) {
        parsed.flags[rawKey] = rawValue;
      } else if (BOOLEAN_FLAGS.has(rawKey)) {
        parsed.flags[rawKey] = true;
      } else if (OPTIONAL_BOOLEAN_FLAGS.has(rawKey)) {
        if (argv[index + 1] && isBooleanLiteral(argv[index + 1])) {
          parsed.flags[rawKey] = argv[++index];
        } else {
          parsed.flags[rawKey] = true;
        }
      } else if (VALUE_FLAGS.has(rawKey) && argv[index + 1] && !argv[index + 1].startsWith("--")) {
        parsed.flags[rawKey] = argv[++index];
      } else {
        parsed.flags[rawKey] = true;
      }
    } else {
      if (!parsed.command) {
        parsed.command = part;
      } else {
        parsed.values.push(part);
      }
    }
  }
  return parsed;
}

function readRawSlashCommand(argv: string[]): { text: string; json: boolean } | undefined {
  const commandIndex = argv.findIndex((part) => part === "/switch-account" || /^\/switch-account\s+/i.test(part));
  if (commandIndex < 0) {
    return undefined;
  }
  const json = argv.includes("--json");
  return {
    text: stripSlashGlobalArgs(argv.slice(commandIndex)).join(" "),
    json,
  };
}

function readLegacySlashText(argv: string[]): string {
  const commandIndex = findCommandIndex(argv, "slash");
  if (commandIndex < 0) {
    return "";
  }
  return stripSlashGlobalArgs(argv.slice(commandIndex + 1)).join(" ");
}

const VALUE_FLAGS = new Set([
  "codex-home",
  "store",
  "codex-cli",
  "label",
  "from",
  "sandbox",
  "approval",
  "preset",
  "model",
  "effort",
  "speed",
  "app-server-restart-mode",
]);

const BOOLEAN_FLAGS = new Set([
  "best",
  "all",
  "no-apply-after-switch",
  "no-restart-app-server-after-switch",
]);

const OPTIONAL_BOOLEAN_FLAGS = new Set([
  "json",
  "apply-after-switch",
  "restart-app-server-after-switch",
]);

function findCommandIndex(argv: string[], command: string): number {
  for (let index = 0; index < argv.length; index++) {
    const part = argv[index];
    if (part.startsWith("--")) {
      const [key, rawValue] = part.slice(2).split("=", 2);
      if (rawValue != null || BOOLEAN_FLAGS.has(key)) {
        continue;
      }
      if (OPTIONAL_BOOLEAN_FLAGS.has(key)) {
        if (argv[index + 1] && isBooleanLiteral(argv[index + 1])) {
          index++;
        }
        continue;
      }
      if (VALUE_FLAGS.has(key) && argv[index + 1] && !argv[index + 1].startsWith("--")) {
        index++;
      }
      continue;
    }
    return part === command ? index : -1;
  }
  return -1;
}

function stripSlashGlobalArgs(argv: string[]): string[] {
  const output: string[] = [];
  const globalFlagsWithValue = new Set(["--codex-home", "--store", "--codex-cli"]);
  for (let index = 0; index < argv.length; index++) {
    const part = argv[index];
    const [key] = part.split("=", 1);
    if (key === "--json") {
      if (!part.includes("=") && argv[index + 1] && isBooleanLiteral(argv[index + 1])) {
        index++;
      }
      continue;
    }
    if (globalFlagsWithValue.has(key)) {
      if (!part.includes("=")) {
        index++;
      }
      continue;
    }
    output.push(part);
  }
  return output;
}

function isBooleanLiteral(value: string): boolean {
  return /^(1|0|true|false|yes|no|on|off|启用|开启|禁用|关闭)$/i.test(value);
}

function stringFlag(args: ParsedArgs, key: string): string | undefined {
  const value = args.flags[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function jsonFlag(args: ParsedArgs): boolean {
  const value = args.flags.json;
  if (value === undefined) {
    return false;
  }
  if (value === true) {
    return true;
  }
  if (/^(1|true|yes|on|启用|开启)$/i.test(value)) {
    return true;
  }
  if (/^(0|false|no|off|禁用|关闭)$/i.test(value)) {
    return false;
  }
  return true;
}

function booleanFlag(args: ParsedArgs, key: string): boolean | undefined {
  const value = args.flags[key];
  if (value === undefined) {
    return undefined;
  }
  if (value === true) {
    return true;
  }
  if (/^(1|true|yes|on|启用|开启)$/i.test(value)) {
    return true;
  }
  if (/^(0|false|no|off|禁用|关闭)$/i.test(value)) {
    return false;
  }
  throw new Error(`--${key} 只能是 true 或 false。`);
}

function printHelp(args: ParsedArgs): void {
  const text = helpText();
  output(args, { action: "help", message: text, result: { examples: HELP_EXAMPLES } }, text);
}

function helpText(): string {
  return `Codex 账号切换器

在 Codex App 对话里发送:
${HELP_EXAMPLES.map((example) => `  ${example}`).join("\n")}

开发者说明:
  底层 CLI 仍支持脚本调用和 JSON 输出，但面向用户的复制命令统一使用 /switch-account ...。

CLI 交互界面:
  codex-account-switcher ui      打开账号余额和切换菜单
  菜单内输入编号或账号标签切换，输入 b 自动切最佳账号，输入 r 刷新余额

通用参数:
  --codex-home <path>   指定目标 CODEX_HOME，支持 ~ 和相对路径
  --store <path>        指定账号库路径，支持 ~ 和相对路径
  --codex-cli <path>    指定 codex CLI 路径；裸命令走 PATH，路径支持 ~ 和相对路径
`;
}

const HELP_EXAMPLES = [
  "/switch-account 保存当前 主账号",
  "/switch-account import ../codex-auths/backup.auth.json 备用账号",
  "/switch-account list",
  "/switch-account refresh",
  "/switch-account switch muka2",
  "/switch-account best",
  "/switch-account status",
  "/switch-account auto-refresh",
  "/switch-account 关闭自动刷新运行态",
  "/switch-account defaults show",
  "/switch-account defaults preset smart",
  "/switch-account defaults set --sandbox workspace-write --approval on-request --speed fast",
  "/switch-account defaults set --model gpt-5.5 --effort xhigh --speed fast",
  "/switch-account defaults apply",
  "/switch-account help",
];

main().catch((error) => {
  const message = sanitizeError(error);
  const args = parseArgs(process.argv.slice(2));
  if (jsonFlag(args)) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
  } else {
    process.stderr.write(`${message}\n`);
  }
  process.exitCode = 1;
});
