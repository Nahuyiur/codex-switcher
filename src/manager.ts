import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { sanitizeError, parseAuthJson, readAuthJson, summarizeAuth, stableAuthHash } from "./auth";
import { AppServerClient } from "./appServerClient";
import { applyCodexConfigDefaults } from "./codexConfig";
import { authJsonPath, configTomlPath, resolveCodexCli, resolveCodexHome, resolveInputPath } from "./paths";
import { chooseCodexSnapshot, normalizeRateWindows, pickBestAccount, scoreAccount } from "./rateLimits";
import { describeSettings } from "./settings";
import { AccountStore } from "./store";
import {
  AccountSummary,
  AppliedCodexConfig,
  DaemonRestartResult,
  ManagerOptions,
  StoredAccount,
  SwitcherSettings,
  SwitcherSettingsUpdate,
  SwitchResult,
} from "./types";

export class AccountSwitcher {
  readonly codexHome: string;
  readonly store: AccountStore;

  constructor(private readonly options: ManagerOptions = {}) {
    this.codexHome = resolveCodexHome(options);
    this.store = new AccountStore(options);
  }

  async addCurrent(label?: string): Promise<StoredAccount> {
    return this.store.upsertFromAuthFile(authJsonPath(this.codexHome), label);
  }

  async importAuth(filePath: string, label?: string): Promise<StoredAccount> {
    return this.store.upsertFromAuthFile(resolveInputPath(filePath, this.options), label);
  }

  async list(): Promise<AccountSummary[]> {
    const store = await this.store.load();
    const activeKey = await this.readActiveKey();
    return store.accounts.map((account) => ({
      id: account.id,
      label: account.label,
      sourcePath: account.sourcePath,
      email: account.email,
      accountId: account.accountId,
      planType: account.planType,
      active: Boolean(activeKey && account.accountId === activeKey),
      lastRefreshAt: account.lastRefreshAt,
      windows: account.windows || [],
      error: account.error,
    }));
  }

  async refreshLimits(accountId?: string): Promise<AccountSummary[]> {
    const store = await this.store.load();
    const targets = accountId ? store.accounts.filter((account) => account.id === accountId) : store.accounts;
    for (const account of targets) {
      await this.refreshOne(account);
    }
    return this.list();
  }

  async switchAccount(accountId: string): Promise<SwitchResult> {
    const store = await this.store.load();
    const account = store.accounts.find((entry) => entry.id === accountId);
    if (!account) {
      throw new Error(`没有找到账号: ${accountId}`);
    }
    return this.switchTo(account);
  }

  async switchBest(): Promise<SwitchResult> {
    await this.refreshLimits();
    const store = await this.store.load();
    const best = pickBestAccount(store.accounts);
    if (!best) {
      throw new Error("没有可用账号，或余额都读取失败。");
    }
    const result = await this.switchTo(best);
    result.selectionReason = describeBestAccount(best);
    result.message = `${result.message} 自动选择：${result.selectionReason}`;
    return result;
  }

  async status(): Promise<AccountSummary | null> {
    return (await this.list()).find((account) => account.active) || null;
  }

  async getSettings(): Promise<SwitcherSettings> {
    return this.store.getSettings();
  }

  async updateSettings(update: SwitcherSettingsUpdate): Promise<SwitcherSettings> {
    return this.store.updateSettings(update);
  }

  async applyDefaults(): Promise<AppliedCodexConfig | null> {
    return applyCodexConfigDefaults(this.codexHome, await this.store.getSettings());
  }

  async doctor(): Promise<Record<string, unknown>> {
    const settings = await this.store.getSettings();
    return {
      codexHome: this.codexHome,
      authPath: authJsonPath(this.codexHome),
      configPath: configTomlPath(this.codexHome),
      storeRoot: this.store.root,
      authExists: await exists(authJsonPath(this.codexHome)),
      accountCount: (await this.store.load()).accounts.length,
      settings,
      settingsSummary: describeSettings(settings),
    };
  }

  private async switchTo(account: StoredAccount): Promise<SwitchResult> {
    const lockDir = path.join(this.store.root, "switch.lock");
    return withLock(lockDir, async () => {
      await fs.mkdir(this.codexHome, { recursive: true });
      const targetPath = authJsonPath(this.codexHome);
      const backupPath = path.join(
        this.codexHome,
        `auth.json.bak.account-switcher-${new Date().toISOString().replace(/[:.]/g, "-")}`,
      );
      const previousKey = await this.readActiveKey();
      if (await exists(targetPath)) {
        await fs.copyFile(targetPath, backupPath);
      } else {
        await fs.writeFile(backupPath, "{}\n", "utf8");
      }
      const snapshot = await this.store.readSnapshot(account);
      parseAuthJson(snapshot);
      const tmp = `${targetPath}.tmp-${process.pid}-${Date.now()}`;
      try {
        await fs.writeFile(tmp, snapshot.endsWith("\n") ? snapshot : `${snapshot}\n`, "utf8");
        await fs.rename(tmp, targetPath);
      } catch (error) {
        await safeCopy(backupPath, targetPath);
        throw new Error(`写入 auth.json 失败，已尝试恢复备份: ${sanitizeError(error)}`);
      }
      const verification = await this.verifyAndRefreshActiveAccount(account, snapshot);
      const { appliedDefaults, defaultsError } = await this.applyDefaultsAfterSwitch();
      const appServerDaemonRestart = await this.restartAppServerDaemonAfterSwitch();
      const defaultsMessage = appliedDefaults
        ? appliedDefaults.changedKeys.length
          ? "默认运行配置已应用。"
          : "默认运行配置已是最新。"
        : defaultsError
          ? "默认运行配置应用失败。"
          : "默认运行配置未启用。";
      const restartMessage = appServerDaemonRestart?.attempted
        ? appServerDaemonRestart.success
          ? "app-server daemon 已重启。"
          : "app-server daemon 重启失败。"
        : "app-server daemon 未重启。";
      return {
        targetAccountId: account.id,
        previousAccountId: previousKey,
        backupPath,
        verified: verification.verified,
        diskAuthWritten: true,
        refreshedAuthSnapshot: verification.snapshotUpdated,
        needsReloadHint: true,
        message: `${verification.verified ? "磁盘账号已切换，并已通过 account/read refresh 验证。" : "磁盘账号已切换；account/read refresh 验证未完成。"} ${verification.snapshotUpdated ? "刷新后的 auth 已同步回账号快照。" : "账号快照未更新。"} ${defaultsMessage} ${restartMessage} 运行中的 Codex App 可能仍需 reload/restart。`,
        appliedDefaults,
        defaultsError,
        appServerDaemonRestart,
      };
    });
  }

  private async verifyAndRefreshActiveAccount(
    account: StoredAccount,
    originalSnapshot: string,
  ): Promise<{ verified: boolean; snapshotUpdated: boolean }> {
    const client = new AppServerClient(this.codexHome, this.options);
    try {
      const response = await client.readAccount(true);
      if (!response.account || response.requiresOpenaiAuth) {
        return { verified: false, snapshotUpdated: false };
      }
      if (account.email && response.account.email && account.email !== response.account.email) {
        return { verified: false, snapshotUpdated: false };
      }

      const refreshedAuth = await fs.readFile(authJsonPath(this.codexHome), "utf8").catch(() => undefined);
      let snapshotUpdated = false;
      if (refreshedAuth) {
        parseAuthJson(refreshedAuth);
        snapshotUpdated = normalizeAuthText(refreshedAuth) !== normalizeAuthText(originalSnapshot);
        if (snapshotUpdated) {
          await this.store.replaceSnapshot(account, refreshedAuth);
        }
      }

      const refreshedSummary = refreshedAuth ? summarizeAuth(parseAuthJson(refreshedAuth)) : undefined;
      await this.store.updateAccount({
        ...account,
        updatedAt: new Date().toISOString(),
        email: response.account.email || account.email,
        planType: response.account.planType || account.planType,
        accountId: refreshedSummary?.accountId || account.accountId,
        error: undefined,
      });

      return { verified: true, snapshotUpdated };
    } catch {
      return { verified: false, snapshotUpdated: false };
    } finally {
      client.close();
    }
  }

  private async applyDefaultsAfterSwitch(): Promise<{
    appliedDefaults: AppliedCodexConfig | null;
    defaultsError?: string;
  }> {
    const settings = await this.store.getSettings();
    if (!settings.applyAfterSwitch) {
      return { appliedDefaults: null };
    }
    try {
      return { appliedDefaults: await applyCodexConfigDefaults(this.codexHome, settings) };
    } catch (error) {
      return { appliedDefaults: null, defaultsError: sanitizeError(error) };
    }
  }

  private async restartAppServerDaemonAfterSwitch(): Promise<DaemonRestartResult | undefined> {
    const settings = await this.store.getSettings();
    if (!settings.restartAppServerAfterSwitch) {
      return undefined;
    }
    const cli = resolveCodexCli(this.options);
    const timeoutMs = this.options.appServerTimeoutMs ?? 15_000;
    return new Promise((resolve) => {
      const child = spawn(cli, ["app-server", "daemon", "restart"], {
        env: { ...process.env, CODEX_HOME: this.codexHome },
        stdio: "pipe",
      });
      let stderr = "";
      let stdout = "";
      const timer = setTimeout(() => {
        child.kill();
        resolve({
          attempted: true,
          success: false,
          message: "app-server daemon 重启超时。",
          error: "timeout",
        });
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.on("error", (error) => {
        clearTimeout(timer);
        resolve({
          attempted: true,
          success: false,
          message: "无法启动 Codex app-server daemon restart。",
          error: sanitizeError(error),
        });
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        const output = sanitizeError(`${stdout}\n${stderr}`.trim());
        resolve({
          attempted: true,
          success: code === 0,
          message: code === 0 ? "app-server daemon 已重启。" : `app-server daemon 重启失败，退出码 ${code ?? "unknown"}。`,
          error: code === 0 ? undefined : output,
        });
      });
    });
  }

  private async refreshOne(account: StoredAccount): Promise<void> {
    const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "codex-account-switcher-"));
    const tempAuth = authJsonPath(tempHome);
    const nextAccount = { ...account, updatedAt: new Date().toISOString() };
    try {
      await fs.writeFile(tempAuth, await this.store.readSnapshot(account), "utf8");
      const client = new AppServerClient(tempHome, this.options);
      try {
        const accountRead = await client.readAccount(true);
        const rates = await client.readRateLimits();
        const snapshot = chooseCodexSnapshot(rates);
        const refreshedAuth = await fs.readFile(tempAuth, "utf8").catch(() => undefined);
        if (refreshedAuth) {
          await this.store.replaceSnapshot(account, refreshedAuth);
        }
        nextAccount.email = accountRead.account?.email || nextAccount.email;
        nextAccount.planType = accountRead.account?.planType || snapshot.planType || nextAccount.planType;
        nextAccount.windows = normalizeRateWindows(snapshot);
        nextAccount.lastRefreshAt = new Date().toISOString();
        nextAccount.error = undefined;
      } finally {
        client.close();
      }
    } catch (error) {
      nextAccount.error = sanitizeError(error);
    } finally {
      await fs.rm(tempHome, { recursive: true, force: true });
    }
    await this.store.updateAccount(nextAccount);
  }

  private async readActiveKey(): Promise<string | undefined> {
    try {
      const auth = await readAuthJson(authJsonPath(this.codexHome));
      const summary = summarizeAuth(auth);
      return summary.accountId || stableAuthHash(auth);
    } catch {
      return undefined;
    }
  }
}

function normalizeAuthText(input: string): string {
  return JSON.stringify(parseAuthJson(input));
}

async function withLock<T>(lockDir: string, action: () => Promise<T>): Promise<T> {
  const started = Date.now();
  while (true) {
    try {
      await fs.mkdir(lockDir, { recursive: false });
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || Date.now() - started > 5_000) {
        throw new Error("无法获取账号切换锁，请稍后重试。");
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  try {
    return await action();
  } finally {
    await fs.rm(lockDir, { recursive: true, force: true });
  }
}

async function safeCopy(from: string, to: string): Promise<void> {
  try {
    await fs.copyFile(from, to);
  } catch {
    // Best-effort restore only.
  }
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function describeBestAccount(account: StoredAccount): string {
  const five = account.windows?.find((window) => window.kind === "5h")?.remainingPercent;
  const seven = account.windows?.find((window) => window.kind === "7d")?.remainingPercent;
  const parts = [`${account.label} 瓶颈余额 ${Math.max(0, Math.round(scoreAccount(account)))}%`];
  if (five != null) {
    parts.push(`5小时 ${Math.round(five)}%`);
  }
  if (seven != null) {
    parts.push(`7天 ${Math.round(seven)}%`);
  }
  return parts.join("，");
}
