import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { readAuthJson, stableAuthHash, summarizeAuth } from "./auth";
import { resolveStoreRoot } from "./paths";
import { normalizeSwitcherSettings, updateSwitcherSettings } from "./settings";
import { ManagerOptions, StoreFile, StoredAccount, SwitcherSettings, SwitcherSettingsUpdate } from "./types";

export class AccountStore {
  readonly root: string;
  private readonly storePath: string;
  private readonly snapshotsDir: string;

  constructor(options: ManagerOptions = {}) {
    this.root = resolveStoreRoot(options);
    this.storePath = path.join(this.root, "accounts.json");
    this.snapshotsDir = path.join(this.root, "snapshots");
  }

  async load(): Promise<StoreFile> {
    await this.ensure();
    try {
      const parsed = JSON.parse(await fs.readFile(this.storePath, "utf8"));
      if (parsed?.version !== 1 || !Array.isArray(parsed.accounts)) {
        throw new Error("账号库格式不正确。");
      }
      return {
        ...parsed,
        accounts: parsed.accounts.map((account: StoredAccount) => this.normalizeAccount(account)),
        settings: normalizeSwitcherSettings(parsed.settings),
      } as StoreFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: 1, accounts: [], settings: normalizeSwitcherSettings(undefined) };
      }
      throw error;
    }
  }

  async save(store: StoreFile): Promise<void> {
    await this.ensure();
    const tmp = `${this.storePath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, this.storePath);
    await chmodPrivate(this.storePath);
  }

  async upsertFromAuthFile(filePath: string, label?: string): Promise<StoredAccount> {
    const auth = await readAuthJson(filePath);
    const summary = summarizeAuth(auth);
    const store = await this.load();
    const accountKey = summary.accountId || stableAuthHash(auth);
    const existing = store.accounts.find((account) => account.accountId === accountKey);
    const account: StoredAccount = {
      id: existing?.id || crypto.randomUUID(),
      label: label?.trim() || existing?.label || summary.suggestedLabel,
      sourcePath: filePath,
      snapshotFile: existing?.snapshotFile || path.join("snapshots", `${crypto.randomUUID()}.auth.json`),
      addedAt: existing?.addedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      lastRefreshAt: existing?.lastRefreshAt,
      email: summary.email,
      accountId: accountKey,
      planType: summary.planType,
      windows: existing?.windows || [],
      error: undefined,
    };
    await this.writeSnapshot(account, JSON.stringify(auth, null, 2));
    store.accounts = [account, ...store.accounts.filter((entry) => entry.id !== account.id)];
    await this.save(store);
    return account;
  }

  async updateAccount(account: StoredAccount): Promise<void> {
    const store = await this.load();
    store.accounts = store.accounts.map((entry) => (entry.id === account.id ? account : entry));
    await this.save(store);
  }

  async getSettings(): Promise<SwitcherSettings> {
    return normalizeSwitcherSettings((await this.load()).settings);
  }

  async updateSettings(update: SwitcherSettingsUpdate): Promise<SwitcherSettings> {
    const store = await this.load();
    store.settings = updateSwitcherSettings(store.settings, update);
    await this.save(store);
    return store.settings;
  }

  async readSnapshot(account: StoredAccount): Promise<string> {
    return fs.readFile(this.resolveSnapshotPath(account.snapshotFile), "utf8");
  }

  async replaceSnapshot(account: StoredAccount, authText: string): Promise<void> {
    await this.writeSnapshot(account, authText);
    await this.updateAccount({ ...account, updatedAt: new Date().toISOString() });
  }

  private async writeSnapshot(account: StoredAccount, authText: string): Promise<void> {
    const snapshotPath = this.resolveSnapshotPath(account.snapshotFile);
    await fs.mkdir(path.dirname(snapshotPath), { recursive: true });
    await chmodPrivateDir(path.dirname(snapshotPath));
    const tmp = `${snapshotPath}.tmp-${process.pid}-${Date.now()}`;
    await fs.writeFile(tmp, authText.endsWith("\n") ? authText : `${authText}\n`, { encoding: "utf8", mode: 0o600 });
    await fs.rename(tmp, snapshotPath);
    await chmodPrivate(snapshotPath);
  }

  private async ensure(): Promise<void> {
    await fs.mkdir(this.snapshotsDir, { recursive: true });
    await chmodPrivateDir(this.root);
    await chmodPrivateDir(this.snapshotsDir);
  }

  private normalizeAccount(account: StoredAccount): StoredAccount {
    this.resolveSnapshotPath(account.snapshotFile);
    return account;
  }

  private resolveSnapshotPath(snapshotFile: string): string {
    if (!snapshotFile || path.isAbsolute(snapshotFile)) {
      throw new Error("账号库 snapshotFile 必须是 snapshots/ 下的相对路径。");
    }
    const snapshotPath = path.resolve(this.root, snapshotFile);
    const snapshotsRoot = path.resolve(this.snapshotsDir);
    if (snapshotPath !== snapshotsRoot && !snapshotPath.startsWith(`${snapshotsRoot}${path.sep}`)) {
      throw new Error("账号库 snapshotFile 不能指向账号库 snapshots/ 之外。");
    }
    return snapshotPath;
  }
}

async function chmodPrivate(filePath: string): Promise<void> {
  await fs.chmod(filePath, 0o600).catch(() => undefined);
}

async function chmodPrivateDir(dirPath: string): Promise<void> {
  await fs.chmod(dirPath, 0o700).catch(() => undefined);
}
