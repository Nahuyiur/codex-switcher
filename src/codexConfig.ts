import * as fs from "node:fs/promises";
import * as path from "node:path";
import { sanitizeError } from "./auth";
import { configTomlPath } from "./paths";
import { codexConfigValuesForSettings } from "./settings";
import { AppliedCodexConfig, SwitcherSettings } from "./types";

const MANAGED_KEYS = new Set(["sandbox_mode", "approval_policy", "model", "model_reasoning_effort", "service_tier"]);

export async function applyCodexConfigDefaults(
  codexHome: string,
  settings: SwitcherSettings,
): Promise<AppliedCodexConfig | null> {
  const values = codexConfigValuesForSettings(settings);
  const entries = Object.entries(values).filter(([key]) => MANAGED_KEYS.has(key));
  if (entries.length === 0) {
    return null;
  }

  await fs.mkdir(codexHome, { recursive: true });
  const configPath = configTomlPath(codexHome);
  const previousText = await fs.readFile(configPath, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  });
  const nextText = updateTopLevelToml(previousText, Object.fromEntries(entries));
  const changedKeys = entries
    .filter(([key, value]) => readTopLevelTomlValue(previousText, key) !== (value == null ? undefined : tomlString(value)))
    .map(([key]) => key);
  if (nextText === previousText) {
    return { configPath, changedKeys: [] };
  }

  const backupPath = await backupConfig(configPath, previousText);
  const tmp = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tmp, nextText, "utf8");
    await fs.rename(tmp, configPath);
    return { configPath, backupPath, changedKeys };
  } catch (error) {
    if (backupPath) {
      await safeRestore(backupPath, configPath);
    }
    throw new Error(`写入 config.toml 失败，已尝试恢复备份: ${sanitizeError(error)}`);
  }
}

export function updateTopLevelToml(input: string, values: Record<string, string | null>): string {
  const lines = input.length ? input.replace(/\r\n/g, "\n").split("\n") : [];
  if (lines.length && lines[lines.length - 1] === "") {
    lines.pop();
  }

  const firstTableIndex = lines.findIndex((line) => /^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(line));
  const topLevelEnd = firstTableIndex === -1 ? lines.length : firstTableIndex;
  const seen = new Set<string>();
  const output: string[] = [];

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (index < topLevelEnd) {
      const key = parseTopLevelKey(line);
      if (key && Object.prototype.hasOwnProperty.call(values, key)) {
        const value = values[key];
        if (!seen.has(key) && value != null) {
          output.push(`${key} = ${tomlString(value)}`);
        }
        seen.add(key);
        continue;
      }
    }
    output.push(line);
  }

  const missing = Object.entries(values).filter(([key, value]) => !seen.has(key) && value != null) as Array<
    [string, string]
  >;
  if (missing.length) {
    const insert = missing.map(([key, value]) => `${key} = ${tomlString(value)}`);
    const outputFirstTableIndex = output.findIndex((line) => /^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(line));
    if (outputFirstTableIndex === -1) {
      if (output.length && output[output.length - 1].trim() !== "") {
        output.push("");
      }
      output.push(...insert);
    } else {
      const before = output.slice(0, outputFirstTableIndex);
      const after = output.slice(outputFirstTableIndex);
      if (before.length && before[before.length - 1].trim() !== "") {
        before.push("");
      }
      before.push(...insert);
      if (after.length && after[0].trim() !== "") {
        before.push("");
      }
      output.splice(0, output.length, ...before, ...after);
    }
  }

  return `${output.join("\n")}\n`;
}

function readTopLevelTomlValue(input: string, key: string): string | undefined {
  const lines = input.replace(/\r\n/g, "\n").split("\n");
  for (const line of lines) {
    if (/^\s*\[[^\]]+\]\s*(?:#.*)?$/.test(line)) {
      return undefined;
    }
    const parsed = parseTopLevelKey(line);
    if (parsed === key) {
      return line.slice(line.indexOf("=") + 1).trim();
    }
  }
  return undefined;
}

function parseTopLevelKey(line: string): string | undefined {
  if (!line.includes("=") || /^\s*(#|$)/.test(line)) {
    return undefined;
  }
  const key = line.split("=", 1)[0].trim();
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : undefined;
}

function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

async function backupConfig(configPath: string, previousText: string): Promise<string | undefined> {
  if (!previousText) {
    return undefined;
  }
  const backupPath = path.join(
    path.dirname(configPath),
    `config.toml.bak.account-switcher-${new Date().toISOString().replace(/[:.]/g, "-")}`,
  );
  await fs.writeFile(backupPath, previousText, "utf8");
  return backupPath;
}

async function safeRestore(from: string, to: string): Promise<void> {
  try {
    await fs.copyFile(from, to);
  } catch {
    // Best-effort restore only.
  }
}
