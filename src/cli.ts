#!/usr/bin/env node
import { AccountSwitcher } from "./manager";
import { formatWindow, scoreAccount } from "./rateLimits";
import { sanitizeError } from "./auth";
import { describeSettings, isApprovalPolicy, isModelPreset, isReasoningEffort, isSandboxMode, isSpeedTier } from "./settings";
import { AppliedCodexConfig, ManagerOptions, SwitcherSettingsUpdate } from "./types";

interface ParsedArgs {
  command?: string;
  values: string[];
  flags: Record<string, string | true>;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const options: ManagerOptions = {
    codexHome: stringFlag(args, "codex-home"),
    accountLibraryPath: stringFlag(args, "store"),
    codexCliPath: stringFlag(args, "codex-cli"),
  };
  const switcher = new AccountSwitcher(options);

  switch (args.command) {
    case "add-current": {
      const account = await switcher.addCurrent(stringFlag(args, "label"));
      output(args, account, `已保存当前账号：${account.label}`);
      return;
    }
    case "import": {
      const from = stringFlag(args, "from") || args.values[0];
      if (!from) {
        throw new Error("请提供 --from <path>。");
      }
      const account = await switcher.importAuth(from, stringFlag(args, "label"));
      output(args, account, `已导入账号：${account.label}`);
      return;
    }
    case "list": {
      const accounts = await switcher.list();
      output(args, accounts, renderList(accounts));
      return;
    }
    case "refresh-limits": {
      const accounts = await switcher.refreshLimits(args.flags.all ? undefined : args.values[0]);
      output(args, accounts, renderList(accounts));
      return;
    }
    case "switch": {
      const result = args.flags.best ? await switcher.switchBest() : await switcher.switchAccount(args.values[0]);
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
      printHelp();
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
      const settings = await switcher.updateSettings(readSettingsUpdate(args));
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
    return "暂无账号。可以运行 add-current 或 import --from <path>。";
  }
  return accounts
    .map((account) => {
      const five = account.windows.find((window) => window.kind === "5h");
      const seven = account.windows.find((window) => window.kind === "7d");
      const active = account.active ? "当前" : "    ";
      const error = account.error ? `  余额读取失败：${account.error}` : "";
      return `${active}  ${account.label}  5小时 ${formatWindow(five)}  7天 ${formatWindow(seven)}  瓶颈 ${Math.max(0, Math.round(scoreAccount(account)))}%${error}`;
    })
    .join("\n");
}

function output(args: ParsedArgs, value: unknown, text: string): void {
  if (args.flags.json) {
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
  --restart-app-server-after-switch true   切换后尝试重启 app-server daemon
  --no-restart-app-server-after-switch     切换后不重启 app-server daemon`;
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
      } else if (argv[index + 1] && !argv[index + 1].startsWith("--")) {
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

function stringFlag(args: ParsedArgs, key: string): string | undefined {
  const value = args.flags[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
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

function printHelp(): void {
  process.stdout.write(`Codex 账号切换器

用法:
  codex-account-switcher add-current [--label 名称]
  codex-account-switcher import --from /path/to/auth.json [--label 名称]
  codex-account-switcher list [--json]
  codex-account-switcher refresh-limits --all [--json]
  codex-account-switcher switch <account-id> [--json]
  codex-account-switcher switch --best [--json]
  codex-account-switcher status [--json]
  codex-account-switcher defaults show [--json]
  codex-account-switcher defaults set [--sandbox read-only|workspace-write|danger-full-access] [--approval untrusted|on-request|never] [--preset speed|balanced|smart|custom] [--model 模型名] [--effort minimal|low|medium|high|xhigh] [--speed standard|fast] [--restart-app-server-after-switch true|false]
  codex-account-switcher defaults preset speed|balanced|smart|custom
  codex-account-switcher defaults apply [--json]
  codex-account-switcher doctor [--json]

通用参数:
  --codex-home <path>   指定目标 CODEX_HOME，支持 ~ 和相对路径
  --store <path>        指定账号库路径，支持 ~ 和相对路径
  --codex-cli <path>    指定 codex CLI 路径；裸命令走 PATH，路径支持 ~ 和相对路径
`);
}

main().catch((error) => {
  process.stderr.write(`${sanitizeError(error)}\n`);
  process.exitCode = 1;
});
