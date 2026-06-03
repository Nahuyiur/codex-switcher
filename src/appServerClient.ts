import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { AccountReadResponse, ManagerOptions, RateLimitsReadResponse } from "./types";
import { resolveCodexCli } from "./paths";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class AppServerClient {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private buffer = "";
  private pending = new Map<number, PendingRequest>();
  private events = new EventEmitter();

  constructor(
    private readonly codexHome: string,
    private readonly options: ManagerOptions = {},
  ) {}

  async start(): Promise<void> {
    if (this.child) {
      return;
    }
    const cli = resolveCodexCli(this.options);
    this.child = spawn(cli, ["app-server", "--listen", "stdio://"], {
      env: { ...process.env, CODEX_HOME: this.codexHome },
      stdio: "pipe",
    });
    this.child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
    this.child.stderr.on("data", (chunk: Buffer) => this.events.emit("stderr", chunk.toString("utf8")));
    this.child.on("error", (error) => this.rejectAll(new Error(`无法启动 Codex app-server: ${error.message}`)));
    this.child.on("exit", (code) => {
      this.rejectAll(new Error(`Codex app-server 已退出，退出码 ${code ?? "unknown"}`));
    });
    await this.request("initialize", {
      clientInfo: { name: "codex-account-switcher", title: "Codex 账号切换器", version: "0.1.0" },
      capabilities: null,
    });
    this.notify("initialized");
  }

  async readAccount(refreshToken = true): Promise<AccountReadResponse> {
    await this.start();
    return (await this.request("account/read", { refreshToken })) as AccountReadResponse;
  }

  async readRateLimits(): Promise<RateLimitsReadResponse> {
    await this.start();
    return (await this.request("account/rateLimits/read", undefined)) as RateLimitsReadResponse;
  }

  close(): void {
    if (!this.child) {
      return;
    }
    this.child.kill();
    this.child = undefined;
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const timeoutMs = this.options.appServerTimeoutMs ?? 15_000;
    const message = params === undefined ? { id, method } : { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 请求超时。`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.writeMessage(message);
    });
  }

  private notify(method: string): void {
    this.writeMessage({ method });
  }

  private writeMessage(message: unknown): void {
    if (!this.child) {
      throw new Error("app-server 尚未启动。");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    while (true) {
      const separator = this.buffer.indexOf("\n");
      if (separator === -1) {
        return;
      }
      const line = this.buffer.slice(0, separator).trim();
      this.buffer = this.buffer.slice(separator + 1);
      if (!line) {
        continue;
      }
      this.handleMessage(line);
    }
  }

  private handleMessage(body: string): void {
    let message: any;
    try {
      message = JSON.parse(body);
    } catch {
      return;
    }
    if (typeof message.id === "number" && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id)!;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(new Error(message.error.message || String(message.error)));
      } else {
        pending.resolve(message.result ?? message);
      }
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
