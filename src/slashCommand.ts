import { AccountSwitcher } from "./manager";
import { formatWindow, scoreAccount } from "./rateLimits";
import {
  describeSettings,
  isAppServerRestartMode,
  isApprovalPolicy,
  isModelPreset,
  isReasoningEffort,
  isSandboxMode,
  isSpeedTier,
} from "./settings";
import {
  AccountSummary,
  AppServerRestartMode,
  ApprovalPolicy,
  ModelPreset,
  ReasoningEffort,
  SandboxMode,
  SpeedTier,
  SwitcherSettingsUpdate,
} from "./types";

export interface SlashCommandResult {
  action: string;
  message: string;
  result: unknown;
}

export async function runSwitchAccountSlashCommand(
  input: string,
  switcher: AccountSwitcher,
): Promise<SlashCommandResult> {
  const body = stripCommandName(input).trim();
  if (!body || isHelp(body)) {
    return {
      action: "help",
      message: slashHelpText(),
      result: { examples: slashExamples() },
    };
  }

  if (matchesAny(body, ["list", "ls", "账号", "列表", "列出", "余额", "查看余额", "列出 Codex 账号和余额"])) {
    const accounts = await switcher.list();
    return { action: "list", message: renderSlashList(accounts), result: accounts };
  }

  if (matchesAny(body, ["status", "current", "当前", "当前账号"])) {
    const status = await switcher.status();
    return {
      action: "status",
      message: status ? `当前账号：${status.label}` : "当前账号未保存在账号库中。",
      result: status,
    };
  }

  if (matchesAny(body, ["refresh", "刷新", "刷新余额", "刷新所有账号余额"])) {
    const accounts = await switcher.refreshLimits();
    return { action: "refresh-limits", message: renderSlashList(accounts), result: accounts };
  }

  if (matchesAny(body, ["best", "auto", "自动", "自动切换", "余额最多", "切换到余额最多", "切换到余额最多的账号", "切换到瓶颈余额最高", "切换到瓶颈余额最高的账号"])) {
    const result = await switcher.switchBest();
    return { action: "switch-best", message: result.message, result };
  }

  const importArgs = parseImport(body);
  if (importArgs) {
    const account = await switcher.importAuth(importArgs.path, importArgs.label);
    return { action: "import", message: `已导入账号：${account.label}`, result: account };
  }

  const saveLabel = parseSaveCurrent(body);
  if (saveLabel !== undefined) {
    const account = await switcher.addCurrent(saveLabel || undefined);
    return { action: "add-current", message: `已保存当前账号：${account.label}`, result: account };
  }

  const refreshRuntime = parseRuntimeRefresh(body);
  if (refreshRuntime) {
    const settings = await switcher.updateSettings({
      restartAppServerAfterSwitch: refreshRuntime.enabled,
      appServerRestartMode: refreshRuntime.mode,
    });
    return {
      action: "defaults-runtime-refresh",
      message: refreshRuntime.enabled
        ? `已开启切换后自动刷新运行态：${settings.appServerRestartMode}`
        : "已关闭切换后自动刷新运行态。",
      result: settings,
    };
  }

  const defaultsResult = await runDefaultsCommand(body, switcher);
  if (defaultsResult) {
    return defaultsResult;
  }

  const target = parseSwitchTarget(body);
  if (target) {
    const account = await findAccountByText(switcher, target);
    const result = await switcher.switchAccount(account.id);
    return { action: "switch", message: result.message, result };
  }

  throw new Error(`无法理解 /switch-account 命令：${body}\n${slashHelpText()}`);
}

export function stripCommandName(input: string): string {
  return input.replace(/^\/switch-account\b/i, "").trim();
}

function parseSwitchTarget(input: string): string | undefined {
  const normalized = normalize(input);
  const switchMatch = /^(switch|切换|切到|切换到|use|使用)\s+(.+)$/i.exec(normalized);
  if (switchMatch) {
    return cleanTargetText(switchMatch[2]);
  }
  if (!/\s/.test(normalized) && normalized.length > 0) {
    return cleanTargetText(normalized);
  }
  return undefined;
}

function parseSaveCurrent(input: string): string | undefined {
  const normalized = normalize(input);
  const natural =
    /^把?当前\s*Codex\s*登录保存(?:成|为)?\s*(.+)$/i.exec(normalized)
    || /^保存当前\s*Codex\s*登录(?:成|为)?\s*(.+)$/i.exec(normalized);
  if (natural) {
    return cleanLabel(natural[1] || "");
  }
  const match = /^(add-current|save-current|save|保存当前|保存当前账号)(?:\s+(.+))?$/i.exec(normalized);
  if (!match) {
    return undefined;
  }
  return cleanLabel(match[2] || "");
}

function parseImport(input: string): { path: string; label?: string } | undefined {
  const normalized = normalize(input);
  const chinese = /^从\s+(.+?)\s+导入(?:一个)?账号(?:\s*(?:叫|命名为|label)\s*(.+))?$/i.exec(normalized);
  if (chinese) {
    return { path: chinese[1].trim(), label: cleanLabel(chinese[2] || "") || undefined };
  }

  const parts = splitArgs(normalized);
  if (!["import", "导入"].includes(parts[0])) {
    return undefined;
  }
  const fromIndex = parts.findIndex((part) => part === "--from" || part === "from" || part === "从");
  const path = fromIndex >= 0 ? parts[fromIndex + 1] : parts[1];
  if (!path) {
    throw new Error("导入账号需要提供 auth.json 路径。");
  }
  const labelIndex = parts.findIndex((part) => part === "--label" || part === "label" || part === "叫" || part === "命名为");
  const label = labelIndex >= 0
    ? collectUntilFlag(parts, labelIndex + 1).join(" ")
    : collectUntilFlag(parts, fromIndex >= 0 ? fromIndex + 2 : 2).join(" ");
  return { path, label: cleanLabel(label) || undefined };
}

function parseRuntimeRefresh(input: string): { enabled: boolean; mode: "auto" | "daemon" | "codex-app" } | undefined {
  const normalized = normalize(input);
  if (/^(关闭|禁用|disable|off).*(运行态|app-server|刷新|重启)/i.test(normalized)) {
    return { enabled: false, mode: "auto" };
  }
  if (/^(auto-refresh|自动刷新运行态|切换后自动刷新|切换账号后自动刷新|自动重启|切换账号后自动重启)/i.test(normalized)) {
    const mode = normalized.includes("daemon") ? "daemon" : normalized.includes("codex-app") ? "codex-app" : "auto";
    return { enabled: true, mode };
  }
  return undefined;
}

async function runDefaultsCommand(input: string, switcher: AccountSwitcher): Promise<SlashCommandResult | undefined> {
  const normalized = normalize(input);
  const parts = splitArgs(normalized);
  const command = parts[0]?.toLowerCase();
  const hasDefaultsPrefix = command === "defaults" || parts[0] === "默认配置" || parts[0] === "默认运行配置";

  if (matchesAny(normalized, ["defaults", "defaults show", "默认", "默认配置", "默认运行配置", "查看默认配置"])) {
    const settings = await switcher.getSettings();
    return { action: "defaults-show", message: `默认运行配置：${describeSettings(settings)}`, result: settings };
  }

  if (matchesAny(normalized, ["defaults apply", "apply-defaults", "应用默认配置", "立即应用默认配置"])) {
    const applied = await switcher.applyDefaults();
    return { action: "defaults-apply", message: renderDefaultsApplyResult(applied), result: applied };
  }

  if (hasDefaultsPrefix) {
    const action = parts[1]?.toLowerCase() || "show";
    if (action === "show" || action === "查看") {
      const settings = await switcher.getSettings();
      return { action: "defaults-show", message: `默认运行配置：${describeSettings(settings)}`, result: settings };
    }
    if (action === "apply" || action === "应用" || action === "立即应用") {
      const applied = await switcher.applyDefaults();
      return { action: "defaults-apply", message: renderDefaultsApplyResult(applied), result: applied };
    }
    if (action === "preset" || action === "预设" || action === "模型预设") {
      const preset = normalizeModelPresetAlias(parts[2] || "");
      if (!preset) {
        throw new Error("请提供模型预设：speed、balanced、smart 或 custom。");
      }
      const settings = await switcher.updateSettings({ modelPreset: preset });
      return { action: "defaults-preset", message: `已保存模型预设：${describeSettings(settings)}`, result: settings };
    }
    if (action === "set" || action === "设置") {
      const { update, applyNow } = parseDefaultsUpdateParts(parts.slice(2));
      const settings = await switcher.updateSettings(update);
      const applied = applyNow ? await switcher.applyDefaults() : undefined;
      return {
        action: "defaults-set",
        message: `已保存默认运行配置：${describeSettings(settings)}${applied !== undefined ? `\n${renderDefaultsApplyResult(applied)}` : ""}`,
        result: applied !== undefined ? { settings, applied } : settings,
      };
    }
    throw new Error("defaults 支持 show、set、preset、apply。");
  }

  const natural = parseNaturalDefaults(normalized);
  if (!natural) {
    return undefined;
  }
  if (natural.action === "show") {
    const settings = await switcher.getSettings();
    return { action: "defaults-show", message: `默认运行配置：${describeSettings(settings)}`, result: settings };
  }
  if (natural.action === "apply") {
    const applied = await switcher.applyDefaults();
    return { action: "defaults-apply", message: renderDefaultsApplyResult(applied), result: applied };
  }
  const settings = await switcher.updateSettings(natural.update);
  const applied = natural.applyNow ? await switcher.applyDefaults() : undefined;
  return {
    action: "defaults-set",
    message: `已保存默认运行配置：${describeSettings(settings)}${applied !== undefined ? `\n${renderDefaultsApplyResult(applied)}` : ""}`,
    result: applied !== undefined ? { settings, applied } : settings,
  };
}

function parseDefaultsUpdateParts(parts: string[]): { update: SwitcherSettingsUpdate; applyNow: boolean } {
  const update: SwitcherSettingsUpdate = {};
  let applyNow = false;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const next = parts[index + 1];
    switch (part) {
      case "--sandbox":
      case "sandbox":
      case "权限":
      case "默认权限": {
        update.sandboxMode = requireSandbox(next);
        index++;
        break;
      }
      case "--approval":
      case "approval":
      case "审批":
      case "默认审批": {
        update.approvalPolicy = requireApproval(next);
        index++;
        break;
      }
      case "--preset":
      case "preset":
      case "预设":
      case "模型预设": {
        update.modelPreset = requireModelPreset(next);
        index++;
        break;
      }
      case "--model":
      case "model":
      case "模型": {
        if (!next) {
          throw new Error("请提供模型名。");
        }
        const preset = normalizeModelPresetAlias(next);
        if (preset) {
          update.modelPreset = preset;
        } else {
          update.modelPreset = update.modelPreset || "custom";
          update.model = next;
        }
        index++;
        break;
      }
      case "--effort":
      case "effort":
      case "reasoning":
      case "智能档":
      case "推理档": {
        update.modelReasoningEffort = requireReasoning(next);
        update.modelPreset = update.modelPreset || "custom";
        index++;
        break;
      }
      case "--speed":
      case "speed":
      case "速度":
      case "速度档": {
        update.speedTier = requireSpeed(next);
        index++;
        break;
      }
      case "--apply-after-switch":
      case "切换后应用": {
        update.applyAfterSwitch = parseBoolean(next);
        index++;
        break;
      }
      case "--no-apply-after-switch":
      case "关闭切换后应用": {
        update.applyAfterSwitch = false;
        break;
      }
      case "--restart-app-server-after-switch":
      case "运行态刷新": {
        update.restartAppServerAfterSwitch = parseBoolean(next);
        index++;
        break;
      }
      case "--no-restart-app-server-after-switch":
      case "关闭运行态刷新": {
        update.restartAppServerAfterSwitch = false;
        break;
      }
      case "--app-server-restart-mode":
      case "刷新模式": {
        update.appServerRestartMode = requireAppServerRestartMode(next);
        index++;
        break;
      }
      case "apply":
      case "应用":
      case "立即应用": {
        applyNow = true;
        break;
      }
      default: {
        const preset = normalizeModelPresetAlias(part);
        const sandbox = normalizeSandboxAlias(part);
        const approval = normalizeApprovalAlias(part);
        const speed = normalizeSpeedAlias(part);
        const effort = normalizeReasoningAlias(part);
        if (preset) {
          update.modelPreset = preset;
        } else if (sandbox) {
          update.sandboxMode = sandbox;
        } else if (approval) {
          update.approvalPolicy = approval;
        } else if (speed) {
          update.speedTier = speed;
        } else if (effort) {
          update.modelPreset = update.modelPreset || "custom";
          update.modelReasoningEffort = effort;
        } else {
          throw new Error(`无法理解默认配置参数：${part}`);
        }
      }
    }
  }
  if (Object.keys(update).length === 0 && !applyNow) {
    throw new Error("请提供要设置的默认运行配置。");
  }
  return { update, applyNow };
}

function parseNaturalDefaults(input: string):
  | { action: "show" }
  | { action: "apply" }
  | { action: "set"; update: SwitcherSettingsUpdate; applyNow: boolean }
  | undefined {
  const update: SwitcherSettingsUpdate = {};
  const applyNow = /立即应用|并应用|apply/i.test(input);

  if (/^(查看)?默认(运行)?配置$/.test(input)) {
    return { action: "show" };
  }
  if (/^(立即)?应用默认(运行)?配置$/.test(input)) {
    return { action: "apply" };
  }
  if (/(默认|权限|审批|模型|速度|智能档|推理档)/.test(input) === false) {
    return undefined;
  }

  const sandbox = findSandboxAlias(input);
  if (sandbox) {
    update.sandboxMode = sandbox;
  }
  const approval = findApprovalAlias(input);
  if (approval) {
    update.approvalPolicy = approval;
  }
  const preset = findModelPresetAlias(input);
  if (preset) {
    update.modelPreset = preset;
  }
  const model = /(?:默认)?模型\s+([a-zA-Z0-9._-]+)/.exec(input)?.[1];
  if (model && !normalizeModelPresetAlias(model)) {
    update.modelPreset = update.modelPreset || "custom";
    update.model = model;
  }
  const effort = findReasoningAlias(input);
  if (effort) {
    update.modelPreset = update.modelPreset || "custom";
    update.modelReasoningEffort = effort;
  }
  const speed = findSpeedAlias(input);
  if (speed) {
    update.speedTier = speed;
  }
  if (/关闭.*切换后.*应用/.test(input)) {
    update.applyAfterSwitch = false;
  } else if (/切换后.*应用|自动应用/.test(input)) {
    update.applyAfterSwitch = true;
  }

  return Object.keys(update).length > 0 ? { action: "set", update, applyNow } : undefined;
}

async function findAccountByText(switcher: AccountSwitcher, text: string): Promise<AccountSummary> {
  const accounts = await switcher.list();
  const normalized = normalize(text).toLowerCase();
  const account = accounts.find((entry) => entry.id === text)
    || accounts.find((entry) => normalize(entry.label).toLowerCase() === normalized)
    || accounts.find((entry) => entry.email?.toLowerCase() === normalized);
  if (account) {
    return account;
  }
  const partialMatches = accounts.filter((entry) => normalize(entry.label).toLowerCase().includes(normalized));
  if (partialMatches.length === 1) {
    return partialMatches[0];
  }
  if (partialMatches.length > 1) {
    throw new Error(`账号名不够精确：${text}。匹配到：${partialMatches.map((entry) => entry.label).join("、")}`);
  }
  const labels = accounts.map((entry) => entry.label).join("、") || "暂无账号";
  throw new Error(`没有找到账号：${text}。当前账号：${labels}`);
}

function renderSlashList(accounts: AccountSummary[]): string {
  if (accounts.length === 0) {
    return "暂无账号。可以使用 /switch-account 保存当前 主账号 或 /switch-account import ./auth.json 备用账号。";
  }
  return accounts
    .map((account) => {
      const five = account.windows.find((window) => window.kind === "5h");
      const seven = account.windows.find((window) => window.kind === "7d");
      const active = account.active ? "当前" : "可切换";
      return `${active}  ${account.label}  5小时 ${formatWindow(five)}  7天 ${formatWindow(seven)}  瓶颈 ${Math.max(0, Math.round(scoreAccount(account)))}%`;
    })
    .join("\n");
}

function matchesAny(input: string, commands: string[]): boolean {
  const normalized = normalize(input).toLowerCase();
  return commands.some((command) => normalized === command.toLowerCase());
}

function isHelp(input: string): boolean {
  return matchesAny(input, ["help", "-h", "--help", "帮助", "怎么用"]);
}

function slashHelpText(): string {
  return `用法：
/switch-account list
/switch-account refresh
/switch-account best
/switch-account switch <账号名>
/switch-account <账号名>
/switch-account status
/switch-account 保存当前 <名称>
/switch-account import <auth.json路径> <名称>
/switch-account auto-refresh
/switch-account 关闭自动刷新运行态
/switch-account defaults show
/switch-account defaults preset smart
/switch-account defaults set --sandbox workspace-write --approval on-request --speed fast
/switch-account defaults set --model gpt-5.5 --effort xhigh --speed fast
/switch-account defaults apply
/switch-account help`;
}

function slashExamples(): string[] {
  return [
    "/switch-account 保存当前 主账号",
    "/switch-account list",
    "/switch-account switch muka2",
    "/switch-account best",
    "/switch-account status",
    "/switch-account import ../codex-auths/backup.auth.json 备用账号",
    "/switch-account auto-refresh",
    "/switch-account 关闭自动刷新运行态",
    "/switch-account defaults preset smart",
    "/switch-account defaults set --sandbox workspace-write --approval on-request --speed fast",
    "/switch-account defaults set --model gpt-5.5 --effort xhigh --speed fast",
    "/switch-account defaults apply",
  ];
}

function normalize(input: string): string {
  return input
    .trim()
    .replace(/[，。；：]/g, " ")
    .replace(/\s+/g, " ");
}

function cleanTargetText(input: string): string {
  return normalize(input).replace(/^(到|账号)\s+/, "").replace(/\s+账号$/, "").trim();
}

function cleanLabel(input: string): string {
  return normalize(input).replace(/^(叫|命名为|label)\s+/i, "").trim();
}

function splitArgs(input: string): string[] {
  const result: string[] = [];
  let current = "";
  let quote: string | undefined;
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      if (current) {
        result.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) {
    result.push(current);
  }
  return result;
}

function collectUntilFlag(parts: string[], start: number): string[] {
  const result: string[] = [];
  for (let index = start; index < parts.length; index++) {
    if (parts[index].startsWith("--")) {
      break;
    }
    result.push(parts[index]);
  }
  return result;
}

function renderDefaultsApplyResult(result: Awaited<ReturnType<AccountSwitcher["applyDefaults"]>>): string {
  if (!result) {
    return "没有可应用的默认运行配置。";
  }
  if (result.changedKeys.length === 0) {
    return "默认运行配置已是最新。";
  }
  return `已应用默认运行配置：${result.changedKeys.join(", ")}。`;
}

function requireSandbox(value: string | undefined): SandboxMode {
  const normalized = normalizeSandboxAlias(value || "");
  if (!normalized) {
    throw new Error("权限只能是 read-only、workspace-write 或 danger-full-access。");
  }
  return normalized;
}

function requireApproval(value: string | undefined): ApprovalPolicy {
  const normalized = normalizeApprovalAlias(value || "");
  if (!normalized) {
    throw new Error("审批策略只能是 untrusted、on-request 或 never。");
  }
  return normalized;
}

function requireModelPreset(value: string | undefined): ModelPreset {
  const normalized = normalizeModelPresetAlias(value || "");
  if (!normalized) {
    throw new Error("模型预设只能是 speed、balanced、smart 或 custom。");
  }
  return normalized;
}

function requireReasoning(value: string | undefined): ReasoningEffort {
  const normalized = normalizeReasoningAlias(value || "");
  if (!normalized) {
    throw new Error("reasoning effort 只能是 minimal、low、medium、high 或 xhigh。");
  }
  return normalized;
}

function requireSpeed(value: string | undefined): SpeedTier {
  const normalized = normalizeSpeedAlias(value || "");
  if (!normalized) {
    throw new Error("速度档只能是 standard 或 fast。");
  }
  return normalized;
}

function requireAppServerRestartMode(value: string | undefined): AppServerRestartMode {
  if (isAppServerRestartMode(value)) {
    return value;
  }
  throw new Error("app-server 刷新模式只能是 auto、daemon 或 codex-app。");
}

function parseBoolean(value: string | undefined): boolean {
  if (value === undefined) {
    return true;
  }
  if (/^(1|true|yes|on|启用|开启)$/i.test(value)) {
    return true;
  }
  if (/^(0|false|no|off|禁用|关闭)$/i.test(value)) {
    return false;
  }
  throw new Error("布尔值只能是 true 或 false。");
}

function normalizeSandboxAlias(value: string): SandboxMode | undefined {
  if (isSandboxMode(value)) {
    return value;
  }
  if (/^(readonly|只读|只读权限)$/.test(value)) {
    return "read-only";
  }
  if (/^(workspace|workspace-write|工作区可写|工作区写入|工作区)$/.test(value)) {
    return "workspace-write";
  }
  if (/^(full|danger|danger-full-access|完全访问|完全权限|全权限)$/.test(value)) {
    return "danger-full-access";
  }
  return undefined;
}

function normalizeApprovalAlias(value: string): ApprovalPolicy | undefined {
  if (isApprovalPolicy(value)) {
    return value;
  }
  if (/^(严格|不信任)$/.test(value)) {
    return "untrusted";
  }
  if (/^(按需|需要时|请求时|onrequest)$/.test(value)) {
    return "on-request";
  }
  if (/^(不审批|不请求|永不|never)$/.test(value)) {
    return "never";
  }
  return undefined;
}

function normalizeModelPresetAlias(value: string): ModelPreset | undefined {
  if (isModelPreset(value)) {
    return value;
  }
  if (/^(速度优先|快速优先)$/.test(value)) {
    return "speed";
  }
  if (/^(均衡|平衡)$/.test(value)) {
    return "balanced";
  }
  if (/^(智能|智能优先|最聪明)$/.test(value)) {
    return "smart";
  }
  if (/^(自定义)$/.test(value)) {
    return "custom";
  }
  return undefined;
}

function normalizeReasoningAlias(value: string): ReasoningEffort | undefined {
  if (isReasoningEffort(value)) {
    return value;
  }
  if (/^(最低)$/.test(value)) {
    return "minimal";
  }
  if (/^(低)$/.test(value)) {
    return "low";
  }
  if (/^(中|中等)$/.test(value)) {
    return "medium";
  }
  if (/^(高)$/.test(value)) {
    return "high";
  }
  if (/^(最高|极高|超高)$/.test(value)) {
    return "xhigh";
  }
  return undefined;
}

function normalizeSpeedAlias(value: string): SpeedTier | undefined {
  if (isSpeedTier(value)) {
    return value;
  }
  if (/^(标准|普通)$/.test(value)) {
    return "standard";
  }
  if (/^(快速|priority)$/.test(value)) {
    return "fast";
  }
  return undefined;
}

function findSandboxAlias(input: string): SandboxMode | undefined {
  return ["danger-full-access", "workspace-write", "read-only", "完全访问", "完全权限", "工作区可写", "只读"]
    .map(normalizeSandboxAlias)
    .find((value, index) => value && input.includes(["danger-full-access", "workspace-write", "read-only", "完全访问", "完全权限", "工作区可写", "只读"][index]));
}

function findApprovalAlias(input: string): ApprovalPolicy | undefined {
  return ["untrusted", "on-request", "never", "严格", "不信任", "按需", "需要时", "不审批", "不请求"]
    .map(normalizeApprovalAlias)
    .find((value, index) => value && input.includes(["untrusted", "on-request", "never", "严格", "不信任", "按需", "需要时", "不审批", "不请求"][index]));
}

function findModelPresetAlias(input: string): ModelPreset | undefined {
  return ["speed", "balanced", "smart", "custom", "速度优先", "均衡", "平衡", "智能优先", "智能", "自定义"]
    .map(normalizeModelPresetAlias)
    .find((value, index) => value && input.includes(["speed", "balanced", "smart", "custom", "速度优先", "均衡", "平衡", "智能优先", "智能", "自定义"][index]));
}

function findReasoningAlias(input: string): ReasoningEffort | undefined {
  return ["minimal", "xhigh", "medium", "high", "low", "最高", "极高", "超高", "最低", "中等", "高", "低", "中"]
    .map(normalizeReasoningAlias)
    .find((value, index) => value && input.includes(["minimal", "xhigh", "medium", "high", "low", "最高", "极高", "超高", "最低", "中等", "高", "低", "中"][index]));
}

function findSpeedAlias(input: string): SpeedTier | undefined {
  return ["standard", "fast", "标准", "普通", "快速", "priority"]
    .map(normalizeSpeedAlias)
    .find((value, index) => value && input.includes(["standard", "fast", "标准", "普通", "快速", "priority"][index]));
}
