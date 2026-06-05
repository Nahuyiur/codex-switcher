# Codex 账号切换器

一个中文本地工具，用来管理多个 Codex `auth.json` 账号快照，查看 5 小时和 7 天余额，并快速切换到指定账号或余额最多的账号。

它提供三个入口：

- **Codex App 插件**：推荐入口。安装后可以在 Codex 对话里直接用中文命令管理账号。
- **VS Code 扩展**：适合本地 VS Code 和 Remote SSH，提供 Activity Bar 侧栏 UI。
- **CLI**：适合自动化脚本、调试和 Codex App 插件调用。

工具只操作当前机器上的 Codex 配置。VS Code Remote SSH 中使用时，扩展运行在远程 extension host，因此修改的是远程服务器的 `~/.codex/auth.json` 和 `~/.codex/config.toml`，不会自动同步本机账号。

## 最快开始：Codex App 插件

先在仓库根目录安装依赖、构建 CLI，并把 `codex-account-switcher` 链接到本机 PATH：

```bash
npm install
npm run build
npm link
```

然后安装 Codex 插件：

```bash
codex plugin marketplace add Nahuyiur/codex-switcher --ref main
codex plugin add codex-account-switcher@codex-switcher
```

安装完成后，在 Codex App 对话里可以直接说这些中文命令：

- “把当前 Codex 登录保存成主账号”
- “从 `./accounts/backup.auth.json` 导入一个账号，叫备用账号”
- “列出 Codex 账号和余额”
- “刷新所有账号余额”
- “切换到余额最多的账号”
- “把默认访问权限设成工作区可写”
- “把默认模型设成智能优先并立即应用”
- “切换账号后自动重启 app-server”

Codex App 插件本身是 skill 插件，不是侧边栏 UI。它会调用本项目构建出的 CLI，所以第一次使用前需要完成上面的 `npm run build` 和 `npm link`。

## 第一次添加账号

本工具不自建 OAuth 登录流程。你需要先用官方 Codex 登录账号，再把当前登录或已有 `auth.json` 保存进账号库。

方法一：保存当前 Codex 登录账号。

```bash
codex-account-switcher add-current --label 主账号
```

这会读取当前机器的 `~/.codex/auth.json`，保存为账号快照。

方法二：从指定路径导入已有 `auth.json`。推荐使用相对路径，方便不同机器和不同用户复用同一套说明。

```bash
codex-account-switcher import --from ./accounts/backup.auth.json --label 备用账号
```

CLI 中的相对路径按当前 shell 所在目录解析。VS Code 扩展设置里的相对账号库路径按当前 workspace 解析；Remote SSH 时按远程 workspace 解析。

账号快照默认保存在：

```text
~/.codex/account-switcher/
```

UI、日志和错误信息不会显示 token。账号快照文件本身仍然是敏感文件，只建议放在你信任的机器和目录里。v1 不会主动 `chmod 0600`，默认沿用系统和目录当前权限。

## 切换账号会发生什么

手动切换：

```bash
codex-account-switcher switch <account-id>
```

自动切换到余额最多的账号：

```bash
codex-account-switcher switch --best
```

切换时会执行这些操作：

- 把目标账号快照写入当前目标机器的 `~/.codex/auth.json`。
- 写入前备份旧文件，备份名类似 `auth.json.bak.account-switcher-...`。
- 写入后通过 Codex app-server 的 `account/read(refreshToken=true)` 尝试验证账号。
- 如果 Codex 在验证时刷新了 token，工具会把刷新后的 `auth.json` 同步回账号快照，避免下次切回旧 token。
- 如果开启了默认运行配置，切换后还会写入当前目标机器的 `~/.codex/config.toml`。
- 如果开启了“切换后重启 app-server”，工具会额外执行 `codex app-server daemon restart`。这不是默认行为，适合你发现 Codex App/daemon 运行态没有及时跟上磁盘 auth 时使用。
- 已经运行中的 Codex 对话不保证热切换；必要时 reload/restart，新请求会使用新账号和新配置。

余额读取依赖 Codex app-server 的 `account/rateLimits/read`。如果余额刷新失败，工具仍然可以切换账号，因为基础切换只依赖本地 `auth.json` 文件。

## 默认权限、模型和速度

账号切换后，Codex 可能回到其它权限或模型设置。本工具可以保存一套默认运行配置，并在每次切换账号后自动写回 `~/.codex/config.toml`。

查看当前默认配置：

```bash
codex-account-switcher defaults show
```

选择智能优先预设：

```bash
codex-account-switcher defaults preset smart
```

设置访问权限、审批策略和速度档：

```bash
codex-account-switcher defaults set --sandbox workspace-write --approval on-request --speed fast
```

立即应用已保存的默认配置：

```bash
codex-account-switcher defaults apply
```

让后续账号切换后自动尝试重启 app-server daemon：

```bash
codex-account-switcher defaults set --restart-app-server-after-switch true
```

关闭该行为：

```bash
codex-account-switcher defaults set --no-restart-app-server-after-switch
```

访问权限三档：

- `read-only`：只读。
- `workspace-write`：工作区可写。
- `danger-full-access`：完全访问。

审批策略：

- `untrusted`：更严格，只自动执行可信命令。
- `on-request`：按需请求审批。
- `never`：不请求审批。

模型预设：

- `speed`：速度优先，写入 `gpt-5.4-mini`、`low`、标准速度。
- `balanced`：均衡，写入 `gpt-5.5`、`medium`、标准速度。
- `smart`：智能优先，写入 `gpt-5.5`、`xhigh`、快速速度档。
- `custom`：使用你手动指定的 `--model`、`--effort` 和 `--speed`。

速度档：

- `standard`：标准速度，并移除默认配置里的 `service_tier`。
- `fast`：快速速度档，写入 `service_tier = "priority"`。

## VS Code 扩展

打包扩展：

```bash
npm run package:vsix
```

生成的 `.vsix` 可以安装到 VS Code。安装后，从 Activity Bar 打开“Codex 账号”侧栏。

侧栏支持：

- 保存当前账号。
- 从 `auth.json` 导入账号。
- 刷新 5 小时和 7 天余额。
- 手动切换到指定账号。
- 自动切换到余额最多的账号。
- 设置默认访问权限、审批策略、模型、reasoning effort 和速度档。
- 保存默认配置并立即应用。
- 可选开启切换后重启 app-server daemon。

Remote SSH 使用时，VS Code 扩展运行在远程服务器上，所以文件选择、账号库、`~/.codex/auth.json` 和 `~/.codex/config.toml` 都属于远程服务器。

## CLI

如果已经运行过 `npm link`，可以直接使用：

```bash
codex-account-switcher add-current --label 主账号
codex-account-switcher import --from ./accounts/backup.auth.json --label 备用账号
codex-account-switcher list
codex-account-switcher refresh-limits --all
codex-account-switcher switch <account-id>
codex-account-switcher switch --best
codex-account-switcher status
codex-account-switcher defaults show
codex-account-switcher defaults preset smart
codex-account-switcher defaults set --sandbox workspace-write --approval on-request --speed fast
codex-account-switcher defaults set --restart-app-server-after-switch true
codex-account-switcher defaults apply
codex-account-switcher doctor
```

不想全局链接时，也可以在仓库根目录使用：

```bash
node dist/src/cli.js list
```

常用参数：

- `--codex-home <path>`：指定目标 Codex home，默认是 `~/.codex`，支持相对路径。
- `--store <path>`：指定账号库路径，默认是 `~/.codex/account-switcher`，支持相对路径。
- `--codex-cli <path>`：指定 Codex CLI 路径，默认从 `CODEX_CLI_PATH` 或 PATH 查找 `codex`；`./tools/codex` 这类路径支持相对写法，裸命令 `codex` 仍然走 PATH。
- `--json`：输出 JSON，适合脚本处理。

示例：对临时 Codex home 操作，不影响真实账号。

```bash
codex-account-switcher --codex-home ./tmp/codex-home --store ./tmp/codex-store defaults show --json
```

## 常见问题

**余额刷新失败，为什么仍然能切换？**

余额刷新依赖 Codex app-server 和当前账号状态；切换只需要把账号快照写入 `auth.json`。因此余额失败不会阻止基础切换。

**切换后当前 Codex 对话为什么没有立刻变化？**

运行中的 Codex session 不保证热切换。切换主要保证磁盘 `auth.json`、后续请求或新 session 生效；必要时 reload/restart。你也可以开启 `--restart-app-server-after-switch true`，让工具在切换后尝试重启 app-server daemon。

**本机和远程服务器账号会同步吗？**

不会默认同步。VS Code Remote SSH 场景下，远程服务器需要单独保存或导入账号。

**会不会显示 token？**

不会在 UI、日志或错误里显示 token。但账号快照文件本身包含敏感凭据，应只保存在可信目录。

**这个工具会强制修改文件权限吗？**

不会。v1 不主动 `chmod 0600`，默认沿用系统和目录当前权限。

## 开发与验证

```bash
npm install
npm run build
npm test
npm run package:vsix
```

常用本地检查：

```bash
codex-account-switcher --help
codex-account-switcher defaults show
```
