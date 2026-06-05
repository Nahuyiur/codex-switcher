import * as os from "node:os";
import * as path from "node:path";
import { ManagerOptions } from "./types";

export function expandHome(input: string): string {
  if (input === "~") {
    return os.homedir();
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

export function resolveInputPath(input: string, options: ManagerOptions = {}): string {
  const expanded = expandHome(input);
  if (path.isAbsolute(expanded)) {
    return path.resolve(expanded);
  }
  return path.resolve(options.baseDir || process.cwd(), expanded);
}

export function resolveCodexHome(options: ManagerOptions = {}): string {
  return resolveInputPath(options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), options);
}

export function resolveStoreRoot(options: ManagerOptions = {}): string {
  const configured = options.accountLibraryPath || process.env.CODEX_ACCOUNT_SWITCHER_HOME;
  return resolveInputPath(configured || path.join(resolveCodexHome(options), "account-switcher"), options);
}

export function resolveCodexCli(options: ManagerOptions = {}): string {
  const configured = options.codexCliPath || process.env.CODEX_CLI_PATH;
  if (!configured) {
    return "codex";
  }
  if (isBareCommand(configured)) {
    return configured;
  }
  return resolveInputPath(configured, options);
}

export function authJsonPath(codexHome: string): string {
  return path.join(codexHome, "auth.json");
}

export function configTomlPath(codexHome: string): string {
  return path.join(codexHome, "config.toml");
}

function isBareCommand(input: string): boolean {
  return expandHome(input) === input && !path.isAbsolute(input) && !/[\\/]/.test(input) && !input.startsWith(".");
}
