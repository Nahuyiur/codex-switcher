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

export function resolveCodexHome(options: ManagerOptions = {}): string {
  return path.resolve(
    expandHome(options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), ".codex")),
  );
}

export function resolveStoreRoot(options: ManagerOptions = {}): string {
  const configured = options.accountLibraryPath || process.env.CODEX_ACCOUNT_SWITCHER_HOME;
  return path.resolve(expandHome(configured || path.join(resolveCodexHome(options), "account-switcher")));
}

export function resolveCodexCli(options: ManagerOptions = {}): string {
  return options.codexCliPath || process.env.CODEX_CLI_PATH || "codex";
}

export function authJsonPath(codexHome: string): string {
  return path.join(codexHome, "auth.json");
}
