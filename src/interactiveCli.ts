import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { AccountSwitcher } from "./manager";
import { formatWindow, scoreAccount } from "./rateLimits";
import { AccountSummary } from "./types";

export interface InteractiveCliOptions {
  input?: NodeJS.ReadableStream;
  output?: NodeJS.WritableStream;
  clearScreen?: boolean;
}

export async function runInteractiveCli(
  switcher: AccountSwitcher,
  options: InteractiveCliOptions = {},
): Promise<void> {
  const inputStream = options.input || stdin;
  const outputStream = options.output || stdout;
  const rl = readline.createInterface({ input: inputStream, output: outputStream });
  let accounts = await switcher.list();

  try {
    while (true) {
      if (options.clearScreen !== false && Boolean((outputStream as { isTTY?: boolean }).isTTY)) {
        outputStream.write("\x1b[2J\x1b[H");
      }
      outputStream.write(`${renderInteractiveDashboard(accounts)}\n`);
      const answer = (await readAnswer(rl, "选择账号编号 / 标签，b 最佳，r 刷新，q 退出 > ")).trim();
      if (!answer || /^q(uit)?$/i.test(answer) || answer === "退出") {
        return;
      }
      if (/^r(efresh)?$/i.test(answer) || answer === "刷新") {
        outputStream.write("正在刷新余额...\n");
        accounts = await switcher.refreshLimits();
        continue;
      }
      if (/^b(est)?$/i.test(answer) || answer === "最佳") {
        outputStream.write("正在选择瓶颈余额最高的账号...\n");
        const result = await switcher.switchBest();
        outputStream.write(`${result.message}\n`);
        accounts = await switcher.list();
        continue;
      }

      const target = readTarget(answer, accounts);
      if (!target) {
        outputStream.write(`无法识别选择：${answer}\n`);
        continue;
      }
      const result = await switcher.switchAccount(target);
      outputStream.write(`${result.message}\n`);
      accounts = await switcher.list();
    }
  } finally {
    rl.close();
  }
}

async function readAnswer(rl: readline.Interface, prompt: string): Promise<string> {
  try {
    return await rl.question(prompt);
  } catch (error) {
    if (String((error as Error).message || error).includes("readline was closed")) {
      return "q";
    }
    throw error;
  }
}

export function renderInteractiveDashboard(accounts: AccountSummary[]): string {
  const lines = [
    "Codex 账号切换器",
    "",
    "编号  状态    账号                         5小时        7天          瓶颈",
    "---   ----    --------------------------   ----------   ----------   ----",
  ];
  if (accounts.length === 0) {
    lines.push("暂无账号。可以先运行 codex-account-switcher import <auth.json路径> <名称>。");
  } else {
    accounts.forEach((account, index) => {
      const five = account.windows.find((window) => window.kind === "5h");
      const seven = account.windows.find((window) => window.kind === "7d");
      const status = account.active ? "当前" : "可切换";
      lines.push(
        `${pad(index + 1, 3)}   ${pad(status, 6)}  ${pad(account.label, 26)}   ${pad(formatWindow(five), 10)}   ${pad(formatWindow(seven), 10)}   ${Math.max(0, Math.round(scoreAccount(account)))}%`,
      );
      if (account.error) {
        lines.push(`      错误    ${account.label}: ${account.error}`);
      }
    });
  }
  lines.push("");
  lines.push("操作：输入编号或账号标签切换；b 自动切到瓶颈余额最高；r 刷新余额；q 退出。");
  return lines.join("\n");
}

function readTarget(answer: string, accounts: AccountSummary[]): string | undefined {
  const index = Number(answer);
  if (Number.isInteger(index) && index >= 1 && index <= accounts.length) {
    return accounts[index - 1].id;
  }
  return answer;
}

function pad(value: string | number, width: number): string {
  const text = String(value);
  const visibleWidth = Array.from(text).reduce((total, char) => total + (char.charCodeAt(0) > 127 ? 2 : 1), 0);
  return visibleWidth >= width ? text : `${text}${" ".repeat(width - visibleWidth)}`;
}
