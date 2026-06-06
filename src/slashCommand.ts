import { AccountSwitcher } from "./manager";
import { formatWindow, scoreAccount } from "./rateLimits";
import { AccountSummary } from "./types";

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

  if (matchesAny(body, ["list", "ls", "账号", "列表", "列出", "余额", "查看余额"])) {
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

  if (matchesAny(body, ["best", "auto", "自动", "自动切换", "余额最多", "切换到余额最多"])) {
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
  const label = labelIndex >= 0 ? parts.slice(labelIndex + 1).join(" ") : parts.slice(fromIndex >= 0 ? fromIndex + 2 : 2).join(" ");
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

async function findAccountByText(switcher: AccountSwitcher, text: string): Promise<AccountSummary> {
  const accounts = await switcher.list();
  const normalized = normalize(text).toLowerCase();
  const account = accounts.find((entry) => entry.id === text)
    || accounts.find((entry) => normalize(entry.label).toLowerCase() === normalized)
    || accounts.find((entry) => entry.email?.toLowerCase() === normalized)
    || accounts.find((entry) => normalize(entry.label).toLowerCase().includes(normalized));
  if (!account) {
    const labels = accounts.map((entry) => entry.label).join("、") || "暂无账号";
    throw new Error(`没有找到账号：${text}。当前账号：${labels}`);
  }
  return account;
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
/switch-account help`;
}

function slashExamples(): string[] {
  return [
    "/switch-account 保存当前 主账号",
    "/switch-account list",
    "/switch-account switch muka2",
    "/switch-account best",
    "/switch-account status",
    "/switch-account import ./accounts/backup.auth.json 备用账号",
    "/switch-account auto-refresh",
    "/switch-account 关闭自动刷新运行态",
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
