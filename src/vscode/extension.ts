import * as vscode from "vscode";
import { AccountSwitcher } from "../manager";
import { scoreAccount } from "../rateLimits";
import { AccountSummary, ManagerOptions } from "../types";
import { sanitizeError } from "../auth";

let provider: AccountsViewProvider;
let statusBar: vscode.StatusBarItem;

export function activate(context: vscode.ExtensionContext): void {
  provider = new AccountsViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("codexAccountSwitcher.accountsView", provider),
  );

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 80);
  statusBar.command = "codexAccountSwitcher.refresh";
  context.subscriptions.push(statusBar);

  context.subscriptions.push(vscode.commands.registerCommand("codexAccountSwitcher.refresh", () => provider.refresh(true)));
  context.subscriptions.push(vscode.commands.registerCommand("codexAccountSwitcher.addCurrent", () => provider.addCurrent()));
  context.subscriptions.push(vscode.commands.registerCommand("codexAccountSwitcher.importAuth", () => provider.importAuth()));
  context.subscriptions.push(vscode.commands.registerCommand("codexAccountSwitcher.switchBest", () => provider.switchBest()));

  provider.refresh(false).catch(() => undefined);
}

export function deactivate(): void {}

class AccountsViewProvider implements vscode.WebviewViewProvider {
  private view?: vscode.WebviewView;
  private accounts: AccountSummary[] = [];

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.render();
    view.webview.onDidReceiveMessage((message) => this.handleMessage(message));
    this.refresh(false).catch(() => undefined);
  }

  async refresh(showMessage: boolean): Promise<void> {
    try {
      this.accounts = await this.switcher().list();
      this.update();
      if (showMessage) {
        vscode.window.showInformationMessage("账号列表已刷新。");
      }
    } catch (error) {
      vscode.window.showErrorMessage(`刷新失败：${sanitizeError(error)}`);
    }
  }

  async addCurrent(): Promise<void> {
    const label = await vscode.window.showInputBox({ prompt: "给当前 Codex 账号起一个名称", placeHolder: "例如：主账号" });
    if (label === undefined) {
      return;
    }
    try {
      await this.switcher().addCurrent(label);
      await this.refresh(false);
      vscode.window.showInformationMessage("已保存当前账号。");
    } catch (error) {
      vscode.window.showErrorMessage(`保存失败：${sanitizeError(error)}`);
    }
  }

  async importAuth(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      openLabel: "导入 auth.json",
      filters: { "auth.json": ["json"] },
    });
    let filePath = picked?.[0]?.fsPath;
    if (!filePath) {
      filePath = await vscode.window.showInputBox({ prompt: "输入 auth.json 路径", placeHolder: "/path/to/auth.json" });
    }
    if (!filePath) {
      return;
    }
    const label = await vscode.window.showInputBox({ prompt: "给导入账号起一个名称", placeHolder: "例如：服务器账号 A" });
    try {
      await this.switcher().importAuth(filePath, label);
      await this.refresh(false);
      vscode.window.showInformationMessage("已导入账号。");
    } catch (error) {
      vscode.window.showErrorMessage(`导入失败：${sanitizeError(error)}`);
    }
  }

  async switchBest(): Promise<void> {
    try {
      const result = await this.switcher().switchBest();
      await this.refresh(false);
      vscode.window.showInformationMessage(`${result.message} 新请求会使用新账号。`);
    } catch (error) {
      vscode.window.showErrorMessage(`自动切换失败：${sanitizeError(error)}`);
    }
  }

  private async switchAccount(accountId: string): Promise<void> {
    const account = this.accounts.find((entry) => entry.id === accountId);
    const ok = await vscode.window.showWarningMessage(
      `确认切换到“${account?.label || accountId}”？正在运行的 Codex 可能需要重新加载。`,
      { modal: true },
      "切换",
    );
    if (ok !== "切换") {
      return;
    }
    try {
      const result = await this.switcher().switchAccount(accountId);
      await this.refresh(false);
      vscode.window.showInformationMessage(`${result.message} 新请求会使用新账号。`);
    } catch (error) {
      vscode.window.showErrorMessage(`切换失败：${sanitizeError(error)}`);
    }
  }

  private async refreshLimits(): Promise<void> {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "正在刷新 Codex 余额" }, async () => {
      await this.switcher().refreshLimits();
      await this.refresh(false);
    });
  }

  private handleMessage(message: { command: string; accountId?: string }): void {
    if (message.command === "refresh") {
      this.refresh(true).catch(() => undefined);
    } else if (message.command === "refreshLimits") {
      this.refreshLimits().catch((error) => vscode.window.showErrorMessage(`刷新余额失败：${sanitizeError(error)}`));
    } else if (message.command === "addCurrent") {
      this.addCurrent().catch(() => undefined);
    } else if (message.command === "importAuth") {
      this.importAuth().catch(() => undefined);
    } else if (message.command === "switchBest") {
      this.switchBest().catch(() => undefined);
    } else if (message.command === "switch" && message.accountId) {
      this.switchAccount(message.accountId).catch(() => undefined);
    }
  }

  private switcher(): AccountSwitcher {
    const config = vscode.workspace.getConfiguration("codexAccountSwitcher");
    const options: ManagerOptions = {
      accountLibraryPath: config.get<string>("accountLibraryPath") || undefined,
      codexCliPath: config.get<string>("codexCliPath") || undefined,
    };
    return new AccountSwitcher(options);
  }

  private update(): void {
    if (this.view) {
      this.view.webview.html = this.render();
    }
    const active = this.accounts.find((account) => account.active);
    statusBar.text = active ? `$(account) Codex: ${active.label}` : "$(account) Codex: 未保存账号";
    statusBar.tooltip = "打开 Codex 账号切换器";
    statusBar.show();
  }

  private render(): string {
    const nonce = String(Date.now());
    const rows = this.accounts.length
      ? this.accounts.map((account) => renderAccount(account)).join("")
      : `<div class="empty">
          <div class="empty-title">暂无账号</div>
          <div class="empty-text">保存当前账号，或从已有 auth.json 导入。</div>
        </div>`;
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; padding: 14px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); }
    .toolbar { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px; }
    button { border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border-radius: 6px; padding: 7px 8px; cursor: pointer; font-size: 12px; }
    button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .accounts { display: flex; flex-direction: column; gap: 8px; }
    .account { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 10px; background: var(--vscode-editor-background); }
    .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
    .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .meta { color: var(--vscode-descriptionForeground); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; }
    .badge { border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 2px 7px; font-size: 11px; color: var(--vscode-descriptionForeground); flex: none; }
    .badge.active { color: var(--vscode-testing-iconPassed); border-color: var(--vscode-testing-iconPassed); }
    .bars { display: grid; gap: 7px; }
    .bar-row { display: grid; grid-template-columns: 44px 1fr 42px; gap: 8px; align-items: center; font-size: 11px; }
    .track { height: 5px; border-radius: 999px; background: var(--vscode-input-background); overflow: hidden; }
    .fill { height: 100%; background: var(--vscode-charts-green); }
    .fill.warn { background: var(--vscode-charts-yellow); }
    .fill.danger { background: var(--vscode-charts-red); }
    .actions { display: flex; justify-content: flex-end; margin-top: 9px; }
    .actions button { padding: 5px 10px; }
    .error { color: var(--vscode-errorForeground); font-size: 11px; margin-top: 7px; }
    .empty { border: 1px dashed var(--vscode-panel-border); border-radius: 8px; padding: 18px 12px; text-align: center; }
    .empty-title { font-weight: 600; margin-bottom: 5px; }
    .empty-text { color: var(--vscode-descriptionForeground); font-size: 12px; }
  </style>
</head>
<body>
  <div class="toolbar">
    <button class="primary" data-command="switchBest">自动切换</button>
    <button data-command="refreshLimits">刷新余额</button>
    <button data-command="addCurrent">保存当前</button>
    <button data-command="importAuth">导入 auth</button>
  </div>
  <div class="accounts">${rows}</div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      vscode.postMessage({ command: button.dataset.command, accountId: button.dataset.accountId });
    });
  </script>
</body>
</html>`;
  }
}

function renderAccount(account: AccountSummary): string {
  const five = account.windows.find((window) => window.kind === "5h");
  const seven = account.windows.find((window) => window.kind === "7d");
  const meta = [account.email, account.planType].filter(Boolean).join(" · ") || account.accountId || "未识别账号信息";
  return `<div class="account">
    <div class="head">
      <div>
        <div class="name">${escapeHtml(account.label)}</div>
        <div class="meta">${escapeHtml(meta)}</div>
      </div>
      <div class="badge ${account.active ? "active" : ""}">${account.active ? "当前" : `${Math.max(0, Math.round(scoreAccount(account)))}%`}</div>
    </div>
    <div class="bars">
      ${renderBar("5小时", five?.remainingPercent)}
      ${renderBar("7天", seven?.remainingPercent)}
    </div>
    ${account.error ? `<div class="error">${escapeHtml(account.error)}</div>` : ""}
    <div class="actions"><button class="primary" data-command="switch" data-account-id="${escapeHtml(account.id)}">切换</button></div>
  </div>`;
}

function renderBar(label: string, remaining: number | undefined): string {
  const value = Math.max(0, Math.min(100, remaining ?? 0));
  const cls = value < 15 ? "danger" : value < 35 ? "warn" : "";
  const text = remaining == null ? "未知" : `${Math.round(value)}%`;
  return `<div class="bar-row"><span>${label}</span><div class="track"><div class="fill ${cls}" style="width:${value}%"></div></div><span>${text}</span></div>`;
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
