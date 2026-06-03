#!/usr/bin/env node
import { AccountSwitcher } from "./manager";
import { formatWindow, scoreAccount } from "./rateLimits";
import { sanitizeError } from "./auth";
import { ManagerOptions } from "./types";

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
    default:
      printHelp();
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

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { command: argv[0], values: [], flags: {} };
  for (let index = 1; index < argv.length; index++) {
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
      parsed.values.push(part);
    }
  }
  return parsed;
}

function stringFlag(args: ParsedArgs, key: string): string | undefined {
  const value = args.flags[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
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
  codex-account-switcher doctor [--json]

通用参数:
  --codex-home <path>   指定目标 CODEX_HOME
  --store <path>        指定账号库路径
  --codex-cli <path>    指定 codex CLI 路径
`);
}

main().catch((error) => {
  process.stderr.write(`${sanitizeError(error)}\n`);
  process.exitCode = 1;
});
