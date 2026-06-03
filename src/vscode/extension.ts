import * as vscode from "vscode";
import { AccountSwitcher } from "../manager";
import { scoreAccount } from "../rateLimits";
import { describeSettings, isApprovalPolicy, isModelPreset, isReasoningEffort, isSandboxMode, isSpeedTier, KNOWN_MODELS } from "../settings";
import { AccountSummary, ManagerOptions, SwitcherSettings, SwitcherSettingsUpdate } from "../types";
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
  private settings?: SwitcherSettings;

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
      const switcher = this.switcher();
      [this.accounts, this.settings] = await Promise.all([switcher.list(), switcher.getSettings()]);
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
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: "正在刷新余额并选择账号" }, async () => {
        await this.switcher().refreshLimits();
        await this.refresh(false);
      });
      const best = [...this.accounts].sort((a, b) => scoreAccount(b) - scoreAccount(a))[0];
      if (!best) {
        throw new Error("没有可用账号。");
      }
      const ok = await vscode.window.showWarningMessage(
        `自动切换到“${best.label}”？瓶颈余额 ${Math.max(0, Math.round(scoreAccount(best)))}%。`,
        { modal: true },
        "自动切换",
      );
      if (ok !== "自动切换") {
        return;
      }
      const result = await this.switcher().switchAccount(best.id);
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

  private async saveSettings(settings: Record<string, unknown> | undefined, applyNow: boolean): Promise<void> {
    const update = parseSettingsMessage(settings);
    const switcher = this.switcher();
    const saved = await switcher.updateSettings(update);
    this.settings = saved;
    if (applyNow) {
      const result = await switcher.applyDefaults();
      const changed = result?.changedKeys.length ? `已应用：${result.changedKeys.join(", ")}。` : "默认运行配置已是最新。";
      vscode.window.showInformationMessage(changed);
    } else {
      vscode.window.showInformationMessage("默认运行配置已保存。");
    }
    await this.refresh(false);
  }

  private handleMessage(message: { command: string; accountId?: string; settings?: Record<string, unknown>; applyNow?: boolean }): void {
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
    } else if (message.command === "saveSettings") {
      this.saveSettings(message.settings, Boolean(message.applyNow)).catch((error) =>
        vscode.window.showErrorMessage(`保存默认配置失败：${sanitizeError(error)}`),
      );
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
    const model = this.settings?.model || "默认模型";
    statusBar.text = active ? `$(account) Codex: ${active.label} · ${model}` : "$(account) Codex: 未保存账号";
    statusBar.tooltip = "打开 Codex 账号切换器";
    statusBar.show();
  }

  private render(): string {
    const nonce = String(Date.now());
    const active = this.accounts.find((account) => account.active);
    const rows = this.accounts.length
      ? this.accounts.map((account) => renderAccount(account)).join("")
      : `<div class="empty">
          <div class="empty-title">暂无账号</div>
          <div class="empty-text">保存当前账号，或导入已有 auth.json。</div>
        </div>`;
    return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    :root { --ok: var(--vscode-testing-iconPassed); --warn: var(--vscode-charts-yellow); --bad: var(--vscode-charts-red); }
    body { margin: 0; padding: 12px; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); font-size: 12px; }
    .top { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; align-items: center; margin-bottom: 10px; }
    .eyebrow { color: var(--vscode-descriptionForeground); font-size: 11px; margin-bottom: 2px; }
    .current { font-weight: 700; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .summary { color: var(--vscode-descriptionForeground); font-size: 11px; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .toolbar { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-bottom: 10px; }
    button { border: 1px solid var(--vscode-button-border, transparent); background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border-radius: 6px; padding: 6px 8px; cursor: pointer; font-size: 12px; min-height: 28px; }
    button.primary { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
    button.ghost { background: transparent; border-color: var(--vscode-panel-border); color: var(--vscode-descriptionForeground); min-width: 30px; padding: 4px 7px; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    .section-title { display: flex; align-items: center; justify-content: space-between; color: var(--vscode-descriptionForeground); font-size: 11px; margin: 12px 0 7px; }
    .settings { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 9px; background: var(--vscode-editor-background); margin-bottom: 10px; }
    .settings-grid { display: grid; gap: 8px; }
    .field { display: grid; gap: 4px; min-width: 0; }
    .field.two { grid-template-columns: 1fr 1fr; gap: 7px; }
    label { color: var(--vscode-descriptionForeground); font-size: 11px; }
    select, input[type="text"] { width: 100%; box-sizing: border-box; border: 1px solid var(--vscode-input-border, transparent); border-radius: 6px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); padding: 5px 7px; font-size: 12px; min-height: 28px; }
    .check { display: flex; align-items: center; gap: 7px; color: var(--vscode-foreground); }
    .settings-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin-top: 9px; }
    .accounts { display: flex; flex-direction: column; gap: 8px; }
    .account { border: 1px solid var(--vscode-panel-border); border-radius: 8px; padding: 9px; background: var(--vscode-editor-background); }
    .head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 8px; }
    .name { font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .meta { color: var(--vscode-descriptionForeground); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; margin-top: 2px; }
    .badge { border: 1px solid var(--vscode-panel-border); border-radius: 999px; padding: 2px 7px; font-size: 11px; color: var(--vscode-descriptionForeground); flex: none; }
    .badge.active { color: var(--ok); border-color: var(--ok); }
    .bars { display: grid; gap: 7px; }
    .bar-row { display: grid; grid-template-columns: 44px 1fr 42px; gap: 8px; align-items: center; font-size: 11px; }
    .track { height: 5px; border-radius: 999px; background: var(--vscode-input-background); overflow: hidden; }
    .fill { height: 100%; background: var(--ok); }
    .fill.warn { background: var(--warn); }
    .fill.danger { background: var(--bad); }
    .reset { color: var(--vscode-descriptionForeground); font-size: 10px; margin: 5px 0 0 52px; }
    .actions { display: flex; justify-content: flex-end; margin-top: 9px; }
    .actions button { padding: 5px 10px; }
    .error { color: var(--vscode-errorForeground); font-size: 11px; margin-top: 7px; }
    .empty { border: 1px dashed var(--vscode-panel-border); border-radius: 8px; padding: 18px 12px; text-align: center; }
    .empty-title { font-weight: 600; margin-bottom: 5px; }
    .empty-text { color: var(--vscode-descriptionForeground); font-size: 12px; }
  </style>
</head>
<body>
  <div class="top">
    <div>
      <div class="eyebrow">当前账号</div>
      <div class="current">${escapeHtml(active?.label || "未保存账号")}</div>
      <div class="summary">${escapeHtml(this.settings ? describeSettings(this.settings) : "默认运行配置未加载")}</div>
    </div>
    <button class="ghost" data-command="refresh" title="刷新">刷新</button>
  </div>
  <div class="toolbar">
    <button class="primary" data-command="switchBest">自动切换</button>
    <button data-command="refreshLimits">刷新余额</button>
    <button data-command="addCurrent">保存当前</button>
    <button data-command="importAuth">导入 auth</button>
  </div>
  ${renderSettingsPanel(this.settings)}
  <div class="section-title"><span>账号</span><span>${this.accounts.length} 个</span></div>
  <div class="accounts">${rows}</div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const presets = {
      speed: { model: 'gpt-5.4-mini', effort: 'low', speed: 'standard' },
      balanced: { model: 'gpt-5.5', effort: 'medium', speed: 'standard' },
      smart: { model: 'gpt-5.5', effort: 'xhigh', speed: 'fast' }
    };
    function settingsPayload() {
      const form = document.getElementById('defaults');
      return {
        sandboxMode: form.sandboxMode.value,
        approvalPolicy: form.approvalPolicy.value,
        modelPreset: form.modelPreset.value,
        model: form.model.value,
        modelReasoningEffort: form.modelReasoningEffort.value,
        speedTier: form.speedTier.value,
        applyAfterSwitch: form.applyAfterSwitch.checked
      };
    }
    document.getElementById('modelPreset')?.addEventListener('change', (event) => {
      const preset = presets[event.target.value];
      if (!preset) return;
      const form = document.getElementById('defaults');
      form.model.value = preset.model;
      form.modelReasoningEffort.value = preset.effort;
      form.speedTier.value = preset.speed;
    });
    document.addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (!button) return;
      if (button.dataset.command === 'saveSettings') {
        vscode.postMessage({ command: 'saveSettings', settings: settingsPayload(), applyNow: button.dataset.applyNow === 'true' });
        return;
      }
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
      ${renderBar("5小时", five)}
      ${renderBar("7天", seven)}
    </div>
    ${account.error ? `<div class="error">${escapeHtml(account.error)}</div>` : ""}
    <div class="actions"><button class="primary" data-command="switch" data-account-id="${escapeHtml(account.id)}">切换</button></div>
  </div>`;
}

function renderSettingsPanel(settings?: SwitcherSettings): string {
  const current: SwitcherSettings = settings || {
    version: 1,
    applyAfterSwitch: true,
    sandboxMode: "workspace-write",
    approvalPolicy: "on-request",
    modelPreset: "custom",
    model: "",
    modelReasoningEffort: "medium",
    speedTier: "standard",
  };
  const models = KNOWN_MODELS.map((model) => `<option value="${escapeHtml(model)}"></option>`).join("");
  return `<div class="section-title"><span>默认运行配置</span><span>${current.applyAfterSwitch ? "自动应用" : "手动应用"}</span></div>
  <form id="defaults" class="settings">
    <div class="settings-grid">
      <div class="field two">
        <div>
          <label for="sandboxMode">访问权限</label>
          <select id="sandboxMode" name="sandboxMode">
            ${option("read-only", "只读", current.sandboxMode)}
            ${option("workspace-write", "工作区可写", current.sandboxMode)}
            ${option("danger-full-access", "完全访问", current.sandboxMode)}
          </select>
        </div>
        <div>
          <label for="approvalPolicy">审批</label>
          <select id="approvalPolicy" name="approvalPolicy">
            ${option("untrusted", "严格", current.approvalPolicy)}
            ${option("on-request", "按需", current.approvalPolicy)}
            ${option("never", "不询问", current.approvalPolicy)}
          </select>
        </div>
      </div>
      <div class="field two">
        <div>
          <label for="modelPreset">模型策略</label>
          <select id="modelPreset" name="modelPreset">
            ${option("speed", "速度优先", current.modelPreset)}
            ${option("balanced", "均衡", current.modelPreset)}
            ${option("smart", "智能优先", current.modelPreset)}
            ${option("custom", "自定义", current.modelPreset)}
          </select>
        </div>
        <div>
          <label for="speedTier">速度档</label>
          <select id="speedTier" name="speedTier">
            ${option("standard", "标准", current.speedTier)}
            ${option("fast", "快速", current.speedTier)}
          </select>
        </div>
      </div>
      <div class="field two">
        <div>
          <label for="model">模型</label>
          <input id="model" name="model" type="text" list="models" value="${escapeHtml(current.model || "")}" placeholder="gpt-5.5">
          <datalist id="models">${models}</datalist>
        </div>
        <div>
          <label for="modelReasoningEffort">智能</label>
          <select id="modelReasoningEffort" name="modelReasoningEffort">
            ${option("minimal", "极低", current.modelReasoningEffort)}
            ${option("low", "低", current.modelReasoningEffort)}
            ${option("medium", "中", current.modelReasoningEffort)}
            ${option("high", "高", current.modelReasoningEffort)}
            ${option("xhigh", "最高", current.modelReasoningEffort)}
          </select>
        </div>
      </div>
      <label class="check"><input type="checkbox" name="applyAfterSwitch" ${current.applyAfterSwitch ? "checked" : ""}>切换账号后应用</label>
    </div>
    <div class="settings-actions">
      <button type="button" class="primary" data-command="saveSettings" data-apply-now="true">保存并应用</button>
      <button type="button" data-command="saveSettings" data-apply-now="false">只保存</button>
    </div>
  </form>`;
}

function renderBar(label: string, window: AccountSummary["windows"][number] | undefined): string {
  const value = Math.max(0, Math.min(100, window?.remainingPercent ?? 0));
  const cls = value < 15 ? "danger" : value < 35 ? "warn" : "";
  const text = window?.remainingPercent == null ? "未知" : `${Math.round(value)}%`;
  const reset = formatReset(window?.resetsAt);
  return `<div><div class="bar-row"><span>${label}</span><div class="track"><div class="fill ${cls}" style="width:${value}%"></div></div><span>${text}</span></div>${reset ? `<div class="reset">${escapeHtml(reset)}</div>` : ""}</div>`;
}

function option(value: string, label: string, current: string | undefined): string {
  return `<option value="${escapeHtml(value)}" ${value === current ? "selected" : ""}>${escapeHtml(label)}</option>`;
}

function formatReset(resetsAt: number | null | undefined): string {
  if (!resetsAt) {
    return "";
  }
  const date = new Date(resetsAt);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return `重置 ${date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })}`;
}

function parseSettingsMessage(raw: Record<string, unknown> | undefined): SwitcherSettingsUpdate {
  if (!raw) {
    throw new Error("没有收到默认配置。");
  }
  const sandboxMode = stringValue(raw.sandboxMode);
  const approvalPolicy = stringValue(raw.approvalPolicy);
  const modelPreset = stringValue(raw.modelPreset);
  const modelReasoningEffort = stringValue(raw.modelReasoningEffort);
  const speedTier = stringValue(raw.speedTier);
  if (!isSandboxMode(sandboxMode)) {
    throw new Error("访问权限无效。");
  }
  if (!isApprovalPolicy(approvalPolicy)) {
    throw new Error("审批策略无效。");
  }
  if (!isModelPreset(modelPreset)) {
    throw new Error("模型策略无效。");
  }
  if (!isReasoningEffort(modelReasoningEffort)) {
    throw new Error("智能档无效。");
  }
  if (!isSpeedTier(speedTier)) {
    throw new Error("速度档无效。");
  }
  return {
    sandboxMode,
    approvalPolicy,
    modelPreset,
    model: stringValue(raw.model),
    modelReasoningEffort,
    speedTier,
    applyAfterSwitch: Boolean(raw.applyAfterSwitch),
  };
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function escapeHtml(input: string): string {
  return input.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
