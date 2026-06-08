import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AccountSwitcher } from "../src/manager";
import { normalizeRateWindows, pickBestAccount, scoreAccount } from "../src/rateLimits";
import { parseAuthJson, sanitizeError, stableAuthHash, summarizeAuth } from "../src/auth";
import { StoredAccount } from "../src/types";
import { updateTopLevelToml } from "../src/codexConfig";
import { findCodexAppServerPids } from "../src/appServerRestart";
import { runSwitchAccountSlashCommand, stripCommandName } from "../src/slashCommand";

test("auth parsing rejects malformed auth files", () => {
  assert.throws(() => parseAuthJson("{"), /不是合法 JSON/);
  assert.throws(() => parseAuthJson("{}"), /没有找到/);
});

test("JWT metadata is extracted without exposing tokens", () => {
  const payload = Buffer.from(
    JSON.stringify({
      email: "demo@example.com",
      "https://api.openai.com/auth": {
        chatgpt_account_id: "acct-1",
        chatgpt_plan_type: "pro",
      },
    }),
  ).toString("base64url");
  const auth = parseAuthJson(JSON.stringify({ tokens: { id_token: `x.${payload}.y`, access_token: "token" } }));
  assert.deepEqual(summarizeAuth(auth), {
    email: "demo@example.com",
    accountId: "acct-1",
    planType: "pro",
    suggestedLabel: "demo@example.com",
  });
});

test("stable auth hash prefers refresh token over rotating access token", () => {
  const first = parseAuthJson(JSON.stringify({ tokens: { access_token: "access-old", refresh_token: "refresh-stable" } }));
  const second = parseAuthJson(JSON.stringify({ tokens: { access_token: "access-new", refresh_token: "refresh-stable" } }));
  assert.equal(summarizeAuth(first).accountId, undefined);
  assert.equal(summarizeAuth(second).accountId, undefined);
  assert.equal(stableAuthHash(first), stableAuthHash(second));
});

test("rate limit windows are classified and clamped", () => {
  const windows = normalizeRateWindows({
    limitId: "codex",
    limitName: "Codex",
    planType: "pro",
    credits: null,
    rateLimitReachedType: null,
    primary: { usedPercent: 20, windowDurationMins: 300, resetsAt: 1 },
    secondary: { usedPercent: 105, windowDurationMins: 10080, resetsAt: 2 },
  });
  assert.equal(windows[0].kind, "5h");
  assert.equal(windows[0].remainingPercent, 80);
  assert.equal(windows[1].kind, "7d");
  assert.equal(windows[1].remainingPercent, 0);
});

test("best account uses bottleneck balance", () => {
  const accounts = [
    account("a", 90, 10),
    account("b", 50, 50),
    account("c", 70, 40),
  ];
  assert.equal(scoreAccount(accounts[0]), 10);
  assert.equal(pickBestAccount(accounts)?.id, "b");
});

test("codex config updates managed top-level keys only", () => {
  const updated = updateTopLevelToml(
    [
      'model = "old-model"',
      'service_tier = "priority"',
      "",
      "[profiles.remote]",
      'model = "profile-model"',
      'service_tier = "priority"',
    ].join("\n"),
    {
      model: "gpt-5.5",
      model_reasoning_effort: "xhigh",
      sandbox_mode: "workspace-write",
      service_tier: null,
    },
  );
  assert.match(updated, /model = "gpt-5\.5"/);
  assert.match(updated, /model_reasoning_effort = "xhigh"/);
  assert.match(updated, /sandbox_mode = "workspace-write"/);
  assert.equal(/^service_tier =/m.test(updated.split("[profiles.remote]")[0]), false);
  assert.match(updated, /\[profiles\.remote\]\nmodel = "profile-model"\nservice_tier = "priority"/);
});

test("store can import and switch auth snapshots", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-switcher-test-"));
  const codexHome = path.join(root, "codex");
  const store = path.join(root, "store");
  await fs.mkdir(codexHome, { recursive: true });
  const first = path.join(root, "first.auth.json");
  const second = path.join(root, "second.auth.json");
  await fs.writeFile(first, JSON.stringify({ tokens: { access_token: "a", refresh_token: "ra", account_id: "first" } }), "utf8");
  await fs.writeFile(second, JSON.stringify({ tokens: { access_token: "b", refresh_token: "rb", account_id: "second" } }), "utf8");
  await fs.copyFile(first, path.join(codexHome, "auth.json"));

  const switcher = new AccountSwitcher({ codexHome, accountLibraryPath: store, codexCliPath: "/missing/codex", appServerTimeoutMs: 25 });
  const saved = await switcher.addCurrent("第一个");
  const imported = await switcher.importAuth(second, "第二个");
  assert.equal((await switcher.list()).length, 2);
  const settings = await switcher.updateSettings({
    sandboxMode: "workspace-write",
    approvalPolicy: "on-request",
    modelPreset: "smart",
  });
  assert.equal(settings.model, "gpt-5.5");
  assert.equal(settings.modelReasoningEffort, "xhigh");
  assert.equal(settings.speedTier, "fast");

  const result = await switcher.switchAccount(imported.id);
  assert.equal(result.targetAccountId, imported.id);
  assert.equal(result.verified, false);
  assert.equal(result.diskAuthWritten, true);
  assert.equal(result.refreshedAuthSnapshot, false);
  assert.ok(result.appliedDefaults);
  assert.match(await fs.readFile(path.join(codexHome, "auth.json"), "utf8"), /second/);
  const config = await fs.readFile(path.join(codexHome, "config.toml"), "utf8");
  assert.match(config, /sandbox_mode = "workspace-write"/);
  assert.match(config, /approval_policy = "on-request"/);
  assert.match(config, /model = "gpt-5\.5"/);
  assert.match(config, /model_reasoning_effort = "xhigh"/);
  assert.match(config, /service_tier = "priority"/);
  assert.equal((await switcher.switchAccount(saved.id)).targetAccountId, saved.id);
  assert.equal((await switcher.switchAccount("第二个")).targetAccountId, imported.id);
});

test("switch refreshes active auth and syncs refreshed snapshot", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-switcher-refresh-test-"));
  const codexHome = path.join(root, "codex");
  const store = path.join(root, "store");
  const cli = path.join(root, "mock-codex.js");
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(cli, mockCodexCli(), "utf8");
  await fs.chmod(cli, 0o755);

  const authPath = path.join(root, "target.auth.json");
  await fs.writeFile(
    authPath,
    JSON.stringify({ tokens: { id_token: jwt("target@example.com", "acct-target"), access_token: "old-token", refresh_token: "rt-old" } }),
    "utf8",
  );

  const switcher = new AccountSwitcher({
    baseDir: root,
    codexHome,
    accountLibraryPath: store,
    codexCliPath: "./mock-codex.js",
    appServerTimeoutMs: 3_000,
  });
  const account = await switcher.importAuth("./target.auth.json", "目标账号");
  await switcher.updateSettings({ restartAppServerAfterSwitch: true });

  const result = await switcher.switchAccount(account.id);
  assert.equal(result.verified, true);
  assert.equal(result.diskAuthWritten, true);
  assert.equal(result.refreshedAuthSnapshot, true);
  assert.equal(result.appServerDaemonRestart?.success, true);
  assert.match(await fs.readFile(path.join(codexHome, "auth.json"), "utf8"), /new-token/);
  assert.match(await fs.readFile(path.join(store, account.snapshotFile), "utf8"), /new-token/);
});

test("switch verifies current Codex CLI account/read responses that still require OpenAI auth", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-switcher-current-cli-read-test-"));
  const codexHome = path.join(root, "codex");
  const store = path.join(root, "store");
  const cli = path.join(root, "mock-codex.js");
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(cli, mockCodexCli({ requiresOpenaiAuth: true }), "utf8");
  await fs.chmod(cli, 0o755);
  const authPath = path.join(root, "target.auth.json");
  await fs.writeFile(
    authPath,
    JSON.stringify({ tokens: { id_token: jwt("target@example.com", "acct-target"), access_token: "old-token", refresh_token: "rt-old" } }),
    "utf8",
  );

  const switcher = new AccountSwitcher({
    baseDir: root,
    codexHome,
    accountLibraryPath: store,
    codexCliPath: "./mock-codex.js",
    appServerTimeoutMs: 3_000,
  });
  const account = await switcher.importAuth("./target.auth.json", "目标账号");

  const result = await switcher.switchAccount(account.id);
  assert.equal(result.verified, true);
  assert.equal(result.refreshedAuthSnapshot, true);
});

test("CLI accepts positional labels and label selectors", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-switcher-cli-test-"));
  const codexHome = path.join(root, "codex");
  const store = path.join(root, "store");
  await fs.mkdir(codexHome, { recursive: true });
  const first = path.join(root, "first.auth.json");
  const second = path.join(root, "second.auth.json");
  await fs.writeFile(first, JSON.stringify({ tokens: { access_token: "a", refresh_token: "ra", account_id: "first" } }), "utf8");
  await fs.writeFile(second, JSON.stringify({ tokens: { access_token: "b", refresh_token: "rb", account_id: "second" } }), "utf8");

  const baseArgs = ["--codex-home", codexHome, "--store", store, "--codex-cli", "/missing/codex"];
  const imported = JSON.parse(await runCli([...baseArgs, "import", first, "alpha label", "--json"], root));
  assert.equal(imported.label, "alpha label");
  const importedWithFlag = JSON.parse(await runCli([...baseArgs, "import", "--from", second, "--label", "beta", "--json"], root));
  assert.equal(importedWithFlag.label, "beta");

  const switched = JSON.parse(await runCli([...baseArgs, "switch", "beta", "--json"], root));
  assert.equal(switched.diskAuthWritten, true);
  assert.match(await fs.readFile(path.join(codexHome, "auth.json"), "utf8"), /second/);

  const refreshed = await runCli([...baseArgs, "refresh-limits", "alpha", "--json"], root);
  const accounts = JSON.parse(refreshed);
  assert.equal(accounts.find((account: StoredAccount) => account.label === "alpha label")?.error?.length > 0, true);
});

test("switch keeps token-only account active after access token refresh", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-switcher-token-only-refresh-test-"));
  const codexHome = path.join(root, "codex");
  const store = path.join(root, "store");
  const cli = path.join(root, "mock-codex.js");
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(cli, mockCodexCli({ tokenOnly: true }), "utf8");
  await fs.chmod(cli, 0o755);

  const authPath = path.join(root, "token-only.auth.json");
  await fs.writeFile(
    authPath,
    JSON.stringify({ tokens: { access_token: "old-token", refresh_token: "stable-refresh" } }),
    "utf8",
  );

  const switcher = new AccountSwitcher({
    baseDir: root,
    codexHome,
    accountLibraryPath: store,
    codexCliPath: "./mock-codex.js",
    appServerTimeoutMs: 3_000,
  });
  const account = await switcher.importAuth("./token-only.auth.json", "token-only");
  const result = await switcher.switchAccount(account.id);

  assert.equal(result.verified, true);
  assert.equal((await switcher.status())?.label, "token-only");
  assert.match(await fs.readFile(path.join(codexHome, "auth.json"), "utf8"), /new-token/);
});

test("relative codex and store paths resolve from configured baseDir", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-switcher-relative-test-"));
  const authPath = path.join(root, "account.auth.json");
  await fs.writeFile(authPath, JSON.stringify({ tokens: { access_token: "a", refresh_token: "r", account_id: "relative" } }), "utf8");

  const switcher = new AccountSwitcher({
    baseDir: root,
    codexHome: "./codex",
    accountLibraryPath: "./store",
    codexCliPath: "/missing/codex",
    appServerTimeoutMs: 25,
  });
  await fs.mkdir(path.join(root, "codex"), { recursive: true });
  await fs.copyFile(authPath, path.join(root, "codex", "auth.json"));
  const account = await switcher.importAuth("./account.auth.json", "相对路径账号");

  assert.equal(switcher.codexHome, path.join(root, "codex"));
  assert.equal(switcher.store.root, path.join(root, "store"));
  assert.equal(account.sourcePath, authPath);
});

test("store rejects snapshot paths outside snapshots directory", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-switcher-store-boundary-test-"));
  const store = path.join(root, "store");
  await fs.mkdir(store, { recursive: true });
  await fs.writeFile(
    path.join(store, "accounts.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        {
          id: "bad",
          label: "bad",
          snapshotFile: "../auth.json",
          addedAt: "now",
          updatedAt: "now",
          windows: [],
        },
      ],
    }),
    "utf8",
  );

  const switcher = new AccountSwitcher({ codexHome: path.join(root, "codex"), accountLibraryPath: store });
  await assert.rejects(() => switcher.list(), /snapshotFile/);
});

test("slash command switches by account label", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-switcher-slash-test-"));
  const codexHome = path.join(root, "codex");
  const store = path.join(root, "store");
  await fs.mkdir(codexHome, { recursive: true });
  const first = path.join(root, "alpha.auth.json");
  const second = path.join(root, "beta.auth.json");
  await fs.writeFile(first, JSON.stringify({ tokens: { access_token: "a", refresh_token: "ra", account_id: "alpha" } }), "utf8");
  await fs.writeFile(second, JSON.stringify({ tokens: { access_token: "b", refresh_token: "rb", account_id: "beta" } }), "utf8");
  await fs.copyFile(first, path.join(codexHome, "auth.json"));

  const switcher = new AccountSwitcher({ codexHome, accountLibraryPath: store, codexCliPath: "/missing/codex", appServerTimeoutMs: 25 });
  await switcher.importAuth(first, "alpha");
  await switcher.importAuth(second, "beta");

  const result = await runSwitchAccountSlashCommand("/switch-account switch beta", switcher);
  assert.equal(result.action, "switch");
  assert.match(await fs.readFile(path.join(codexHome, "auth.json"), "utf8"), /beta/);
  assert.equal((await switcher.status())?.label, "beta");
  assert.equal(stripCommandName("/switch-account list"), "list");
});

test("slash command manages default runtime settings", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-switcher-slash-defaults-test-"));
  const codexHome = path.join(root, "codex");
  const store = path.join(root, "store");
  const switcher = new AccountSwitcher({ codexHome, accountLibraryPath: store, codexCliPath: "/missing/codex", appServerTimeoutMs: 25 });

  const preset = await runSwitchAccountSlashCommand("/switch-account defaults preset smart", switcher);
  assert.equal(preset.action, "defaults-preset");
  assert.equal((await switcher.getSettings()).model, "gpt-5.5");
  assert.equal((await switcher.getSettings()).modelReasoningEffort, "xhigh");
  assert.equal((await switcher.getSettings()).speedTier, "fast");

  const configured = await runSwitchAccountSlashCommand(
    "/switch-account defaults set --sandbox read-only --approval never --speed standard apply",
    switcher,
  );
  assert.equal(configured.action, "defaults-set");
  const settings = await switcher.getSettings();
  assert.equal(settings.sandboxMode, "read-only");
  assert.equal(settings.approvalPolicy, "never");
  assert.equal(settings.speedTier, "standard");
  const config = await fs.readFile(path.join(codexHome, "config.toml"), "utf8");
  assert.match(config, /sandbox_mode = "read-only"/);
  assert.match(config, /approval_policy = "never"/);
  assert.equal(/^service_tier =/m.test(config), false);

  await runSwitchAccountSlashCommand("/switch-account 默认权限 工作区可写", switcher);
  assert.equal((await switcher.getSettings()).sandboxMode, "workspace-write");

  await runSwitchAccountSlashCommand("/switch-account 默认智能档 xhigh", switcher);
  assert.equal((await switcher.getSettings()).modelReasoningEffort, "xhigh");
  await runSwitchAccountSlashCommand("/switch-account 默认智能档 最高", switcher);
  assert.equal((await switcher.getSettings()).modelReasoningEffort, "xhigh");
});

test("slash command import flags and account matching are strict", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-switcher-slash-import-test-"));
  const codexHome = path.join(root, "codex");
  const store = path.join(root, "store");
  await fs.mkdir(codexHome, { recursive: true });
  const one = path.join(root, "one.auth.json");
  const two = path.join(root, "two.auth.json");
  await fs.writeFile(one, JSON.stringify({ tokens: { access_token: "a", refresh_token: "ra", account_id: "one" } }), "utf8");
  await fs.writeFile(two, JSON.stringify({ tokens: { access_token: "b", refresh_token: "rb", account_id: "two" } }), "utf8");

  const switcher = new AccountSwitcher({ codexHome, accountLibraryPath: store, codexCliPath: "/missing/codex", appServerTimeoutMs: 25 });
  const imported = await runSwitchAccountSlashCommand(`/switch-account import --label 备用 --from ${one}`, switcher);
  assert.equal(imported.action, "import");
  assert.equal((await switcher.list())[0].label, "备用");

  await switcher.importAuth(one, "team-alpha");
  await switcher.importAuth(two, "team-beta");
  await assert.rejects(
    () => runSwitchAccountSlashCommand("/switch-account switch team", switcher),
    /账号名不够精确/,
  );
});

test("slash command accepts documented Chinese phrases", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-switcher-slash-phrases-test-"));
  const codexHome = path.join(root, "codex");
  const store = path.join(root, "store");
  const cli = path.join(root, "mock-codex.js");
  await fs.mkdir(codexHome, { recursive: true });
  await fs.writeFile(cli, mockCodexCli(), "utf8");
  await fs.chmod(cli, 0o755);
  await fs.writeFile(
    path.join(codexHome, "auth.json"),
    JSON.stringify({ tokens: { id_token: jwt("target@example.com", "acct-target"), access_token: "a", refresh_token: "ra", account_id: "active" } }),
    "utf8",
  );

  const switcher = new AccountSwitcher({ baseDir: root, codexHome, accountLibraryPath: store, codexCliPath: "./mock-codex.js", appServerTimeoutMs: 3_000 });
  assert.equal((await runSwitchAccountSlashCommand("/switch-account 把当前 Codex 登录保存成主账号", switcher)).action, "add-current");
  assert.equal((await runSwitchAccountSlashCommand("/switch-account 列出 Codex 账号和余额", switcher)).action, "list");
  assert.equal((await runSwitchAccountSlashCommand("/switch-account 切换到余额最多的账号", switcher)).action, "switch-best");
});

test("codex app server pid detection skips vscode and temporary stdio servers", () => {
  const output = [
    "100 1 /Applications/Codex.app/Contents/Resources/codex app-server --analytics-default-enabled",
    "101 1 /Users/demo/.vscode/extensions/openai.chatgpt/bin/codex app-server --analytics-default-enabled",
    "102 100 /Applications/Codex.app/Contents/Resources/codex app-server --listen stdio://",
    "103 1 /Applications/Codex.app/Contents/MacOS/Codex",
  ].join("\n");
  assert.deepEqual(findCodexAppServerPids(output), [100]);
});

test("sanitizeError redacts common token shapes", () => {
  const text = sanitizeError(new Error('bad eyJaaa.bbb.ccc and rt.abc_123 and sk-test and "access_token":"opaque-secret" and refresh_token=plain-secret and Authorization: Bearer bearer-secret and sess-abc_123'));
  assert.equal(text.includes("eyJaaa.bbb.ccc"), false);
  assert.equal(text.includes("rt.abc_123"), false);
  assert.equal(text.includes("sk-test"), false);
  assert.equal(text.includes("opaque-secret"), false);
  assert.equal(text.includes("plain-secret"), false);
  assert.equal(text.includes("bearer-secret"), false);
  assert.equal(text.includes("sess-abc_123"), false);
});

function account(id: string, five: number, seven: number): StoredAccount {
  return {
    id,
    label: id,
    snapshotFile: `${id}.json`,
    addedAt: "now",
    updatedAt: "now",
    windows: [
      { kind: "5h", usedPercent: 100 - five, remainingPercent: five, windowDurationMins: 300, resetsAt: null },
      { kind: "7d", usedPercent: 100 - seven, remainingPercent: seven, windowDurationMins: 10080, resetsAt: null },
    ],
  };
}

function jwt(email: string, accountId: string): string {
  const payload = Buffer.from(
    JSON.stringify({
      email,
      "https://api.openai.com/auth": {
        chatgpt_account_id: accountId,
        chatgpt_plan_type: "pro",
      },
    }),
  ).toString("base64url");
  return `x.${payload}.y`;
}

function runCli(args: string[], cwd: string): Promise<string> {
  const cliPath = path.join(__dirname, "../src/cli.js");
  return new Promise((resolve, reject) => {
    execFile(process.execPath, [cliPath, ...args], { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${error.message}\n${stderr}`));
      } else {
        resolve(stdout);
      }
    });
  });
}

function mockCodexCli(options: { tokenOnly?: boolean; requiresOpenaiAuth?: boolean } = {}): string {
  return `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
if (process.argv.includes("daemon") && process.argv.includes("restart")) {
  process.exit(0);
}
let buffer = "";
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  while (buffer.includes("\\n")) {
    const index = buffer.indexOf("\\n");
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
    } else if (message.method === "account/read") {
      const authPath = path.join(process.env.CODEX_HOME, "auth.json");
      const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
      auth.tokens.access_token = "new-token";
      fs.writeFileSync(authPath, JSON.stringify(auth, null, 2) + "\\n");
      process.stdout.write(JSON.stringify({
        id: message.id,
        result: {
          account: ${options.tokenOnly ? '{ type: "chatgpt" }' : '{ type: "chatgpt", email: "target@example.com", planType: "pro" }'},
          requiresOpenaiAuth: ${options.requiresOpenaiAuth ? "true" : "false"}
        }
      }) + "\\n");
    } else if (message.method === "account/rateLimits/read") {
      process.stdout.write(JSON.stringify({
        id: message.id,
        result: {
          rateLimits: {
            limitId: "codex",
            limitName: "Codex",
            planType: "pro",
            credits: null,
            rateLimitReachedType: null,
            primary: { usedPercent: 10, windowDurationMins: 300, resetsAt: 1 },
            secondary: { usedPercent: 20, windowDurationMins: 10080, resetsAt: 2 }
          },
          rateLimitsByLimitId: null
        }
      }) + "\\n");
    }
  }
});
`;
}
