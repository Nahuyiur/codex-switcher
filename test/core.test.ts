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
