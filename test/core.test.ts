import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AccountSwitcher } from "../src/manager";
import { normalizeRateWindows, pickBestAccount, scoreAccount } from "../src/rateLimits";
import { parseAuthJson, sanitizeError, summarizeAuth } from "../src/auth";
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
    appServerTimeoutMs: 1_000,
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
  const text = sanitizeError(new Error("bad eyJaaa.bbb.ccc and rt.abc_123 and sk-test"));
  assert.equal(text.includes("eyJaaa.bbb.ccc"), false);
  assert.equal(text.includes("rt.abc_123"), false);
  assert.equal(text.includes("sk-test"), false);
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

function mockCodexCli(): string {
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
          account: { type: "chatgpt", email: "target@example.com", planType: "pro" },
          requiresOpenaiAuth: false
        }
      }) + "\\n");
    }
  }
});
`;
}
