import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { sanitizeError, parseAuthJson, readAuthJson, summarizeAuth, stableAuthHash } from "./auth";
import { AppServerClient } from "./appServerClient";
import { authJsonPath, resolveCodexHome } from "./paths";
import { chooseCodexSnapshot, normalizeRateWindows, pickBestAccount } from "./rateLimits";
import { AccountStore } from "./store";
import { AccountSummary, ManagerOptions, StoredAccount, SwitchResult } from "./types";

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
    return this.store.upsertFromAuthFile(path.resolve(filePath), label);
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
    return this.switchTo(best);
  }

  async status(): Promise<AccountSummary | null> {
    return (await this.list()).find((account) => account.active) || null;
  }

  async doctor(): Promise<Record<string, unknown>> {
    return {
      codexHome: this.codexHome,
      authPath: authJsonPath(this.codexHome),
      storeRoot: this.store.root,
      authExists: await exists(authJsonPath(this.codexHome)),
      accountCount: (await this.store.load()).accounts.length,
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
      const verified = await this.verifyActiveAccount(account);
      return {
        targetAccountId: account.id,
        previousAccountId: previousKey,
        backupPath,
        verified,
        needsReloadHint: true,
        message: verified ? "切换完成，并已通过 account/read 验证。" : "切换已写入；account/read 验证未完成。",
      };
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

  private async verifyActiveAccount(account: StoredAccount): Promise<boolean> {
    const client = new AppServerClient(this.codexHome, this.options);
    try {
      const response = await client.readAccount(false);
      if (!response.account || response.requiresOpenaiAuth) {
        return false;
      }
      if (account.email && response.account.email) {
        return account.email === response.account.email;
      }
      return true;
    } catch {
      return false;
    } finally {
      client.close();
    }
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
