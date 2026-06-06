import { spawn } from "node:child_process";
import { AppServerRestartMode, DaemonRestartResult, ManagerOptions } from "./types";
import { resolveCodexCli } from "./paths";
import { sanitizeError } from "./auth";

interface CommandResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
}

export async function refreshAppServerRuntime(
  mode: AppServerRestartMode,
  codexHome: string,
  options: ManagerOptions = {},
): Promise<DaemonRestartResult> {
  const timeoutMs = options.appServerTimeoutMs ?? 15_000;
  if (mode === "daemon" || mode === "auto") {
    const daemon = await restartDaemon(codexHome, options, timeoutMs);
    if (daemon.success || mode === "daemon") {
      return daemon;
    }
  }

  if (mode === "codex-app" || mode === "auto") {
    return scheduleCodexAppServerProcessRefresh();
  }

  return {
    attempted: true,
    success: false,
    strategy: mode,
    message: "没有可用的 app-server 刷新方式。",
  };
}

export function findCodexAppServerPids(psOutput: string): number[] {
  return psOutput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = /^(\d+)\s+\d+\s+(.+)$/.exec(line);
      if (!match) {
        return undefined;
      }
      const pid = Number(match[1]);
      const command = match[2];
      if (!Number.isFinite(pid)) {
        return undefined;
      }
      if (!command.includes("Codex.app/Contents/Resources/codex app-server")) {
        return undefined;
      }
      if (command.includes("--listen stdio://")) {
        return undefined;
      }
      return pid;
    })
    .filter((pid): pid is number => typeof pid === "number");
}

async function restartDaemon(
  codexHome: string,
  options: ManagerOptions,
  timeoutMs: number,
): Promise<DaemonRestartResult> {
  const cli = resolveCodexCli(options);
  const result = await runCommand(cli, ["app-server", "daemon", "restart"], {
    env: { ...process.env, CODEX_HOME: codexHome },
    timeoutMs,
  });
  const output = sanitizeError(`${result.stdout}\n${result.stderr}`.trim());
  if (result.error) {
    return {
      attempted: true,
      success: false,
      strategy: "daemon",
      message: "无法启动 Codex app-server daemon restart。",
      error: sanitizeError(result.error),
    };
  }
  return {
    attempted: true,
    success: result.code === 0,
    strategy: "daemon",
    message: result.code === 0 ? "app-server daemon 已重启。" : `app-server daemon 重启失败，退出码 ${result.code ?? "unknown"}。`,
    error: result.code === 0 ? undefined : output,
  };
}

async function scheduleCodexAppServerProcessRefresh(): Promise<DaemonRestartResult> {
  if (process.platform !== "darwin") {
    return {
      attempted: true,
      success: false,
      strategy: "codex-app",
      message: "当前平台暂不支持自动刷新 Codex App app-server 进程。",
    };
  }

  const ps = await runCommand("ps", ["-axo", "pid,ppid,command"], { timeoutMs: 5_000 });
  if (ps.error || ps.code !== 0) {
    return {
      attempted: true,
      success: false,
      strategy: "codex-app",
      message: "无法读取 Codex App app-server 进程列表。",
      error: sanitizeError(ps.error || ps.stderr || `ps exited ${ps.code}`),
    };
  }

  const pids = findCodexAppServerPids(ps.stdout);
  if (pids.length === 0) {
    return {
      attempted: true,
      success: false,
      strategy: "codex-app",
      message: "没有找到可刷新的 Codex App app-server 进程。",
    };
  }

  const script = `
const pids = ${JSON.stringify(pids)};
setTimeout(() => {
  for (const pid of pids) {
    try { process.kill(pid, "SIGTERM"); } catch {}
  }
}, 12000);
setTimeout(() => process.exit(0), 13000);
`;
  const child = spawn(process.execPath, ["-e", script], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  return {
    attempted: true,
    success: true,
    strategy: "codex-app-process",
    scheduled: true,
    affectedPids: pids,
    message: "已安排 Codex App app-server 在本轮回复后约 12 秒自动刷新。",
  };
}

function runCommand(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      env: options.env || process.env,
      stdio: "pipe",
    });
    const finish = (result: CommandResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: null, stdout, stderr, error: "timeout" });
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      finish({ code: null, stdout, stderr, error: error.message });
    });
    child.on("exit", (code) => {
      finish({ code, stdout, stderr });
    });
  });
}
