<p align="center">
  <img src="media/readme-preview.png" alt="Codex 账号切换器界面预览" width="880">
</p>

<h1 align="center">Codex 账号切换器</h1>

<p align="center">
  在 Codex App 里用 <code>/switch-account</code> 管理多个 Codex <code>auth.json</code> 快照，查看 5 小时 / 7 天余额，并快速切换到指定账号或瓶颈余额最高的账号。
</p>

<p align="center">
  <a href="https://github.com/Nahuyiur/codex-switcher"><img alt="GitHub" src="https://img.shields.io/badge/GitHub-Nahuyiur%2Fcodex--switcher-24292f?style=flat-square"></a>
  <img alt="Language" src="https://img.shields.io/badge/UI-%E4%B8%AD%E6%96%87-2563eb?style=flat-square">
  <img alt="TypeScript" src="https://img.shields.io/badge/Core-TypeScript-3178c6?style=flat-square">
  <img alt="Entrypoints" src="https://img.shields.io/badge/%E5%85%A5%E5%8F%A3-%2Fswitch--account%20%7C%20VS%20Code-16a34a?style=flat-square">
</p>

## 一句话

如果你有多个 Codex 账号，或者经常在本机 Codex App、VS Code Remote SSH、远程服务器之间切换账号，这个工具可以把“手动复制 `~/.codex/auth.json`”变成一个可验证、写入前自动备份、可自动选择的流程。

| 能力 | 做什么 |
| --- | --- |
| 账号库 | 保存当前 Codex 登录，或从指定路径导入已有 `auth.json`。 |
| 余额视图 | 读取 Codex 5 小时和 7 天窗口，显示剩余百分比和重置时间。 |
| 快速切换 | 写入目标机器的 `~/.codex/auth.json`，写入前备份，写入后验证。 |
| 自动选择 | 按 `min(5小时余额, 7天余额)` 选择瓶颈余额最大的账号。 |
| 默认配置 | 切换账号后自动恢复访问权限、审批策略、模型、智能档和速度档。 |

## 入口总览

| 入口 | 推荐场景 | 体验 |
| --- | --- | --- |
| **Codex App 插件** | 你主要在 Codex App 里使用 | 直接发 `/switch-account list`、`/switch-account switch muka2`，也支持中文自然语言。 |
| **VS Code 扩展** | 本机 VS Code 或 Remote SSH | Activity Bar 侧栏、状态栏、账号列表、余额条和默认配置面板。 |
| **CLI 交互界面** | 你在 zsh/bash 里直接用 Codex | `codex-account-switcher ui` 打开编号菜单，看余额、刷新、按编号切换或自动切最佳账号。 |
| **自动化能力** | 脚本、调试、插件内部调用 | 仍然复用同一套 `/switch-account ...` 解析器，普通用户不需要记底层二进制前缀。 |

工具只操作当前机器上的 Codex 配置。VS Code Remote SSH 中使用时，扩展运行在远程 extension host，因此修改的是远程服务器的 `~/.codex/auth.json` 和 `~/.codex/config.toml`，不会自动同步本机账号。

## Codex App 常用命令

安装完成后，在 Codex App 对话里直接发：

```text
/switch-account 保存当前 主账号
/switch-account import ../codex-auths/backup.auth.json 备用账号
/switch-account list
/switch-account switch muka2
/switch-account best
/switch-account refresh
/switch-account defaults preset smart
/switch-account defaults set --sandbox workspace-write --approval on-request --speed fast
/switch-account defaults set --model gpt-5.5 --effort xhigh --speed fast
/switch-account defaults apply
/switch-account status
/switch-account auto-refresh
/switch-account 关闭自动刷新运行态
/switch-account help
```

第一次使用时先保存或导入账号；之后如果你只记一条，`/switch-account best` 会自动选择 `min(5小时余额, 7天余额)` 最大的账号并切换。

## 最快开始：Codex App 插件

本地 checkout 开发或测试时，在仓库根目录安装依赖、构建，并把底层可执行文件链接到本机 PATH。后续日常使用仍然只在 Codex App 里发 `/switch-account ...`：

```bash
npm install
npm run build
npm link
```

安装 Codex 插件。下面是 Codex 插件安装命令，其中 `codex-account-switcher@codex-switcher` 是插件包名，不是日常换号命令。使用本地 checkout 时，可以把当前目录作为 marketplace 来源：

```bash
codex plugin marketplace add .
codex plugin add codex-account-switcher@codex-switcher
```

如果从 GitHub marketplace 安装：

```bash
codex plugin marketplace add Nahuyiur/codex-switcher --ref main
codex plugin add codex-account-switcher@codex-switcher
```

Codex 插件提供 skill 规则，让 Codex App 把 `/switch-account ...` 当普通消息处理；实际读写账号仍依赖上面 `npm run build` 和 `npm link` 链接好的本地可执行文件。

如果之前已经安装过旧版本，先重新构建并链接 CLI，然后更新 marketplace：

```bash
npm run build
npm link
codex plugin marketplace upgrade codex-switcher
```

必要时移除后重新安装：

```bash
codex plugin remove codex-account-switcher@codex-switcher
codex plugin add codex-account-switcher@codex-switcher
```

更新 skill 后建议开一个新的 Codex 对话再使用 `/switch-account ...`，旧对话可能已经加载了旧版插件说明。可以在新对话里发 `/switch-account help` 验证插件说明是否已经生效。

安装完成后，可以直接在 Codex App 对话里说。推荐先用斜杠写法，语义更稳定：

| 斜杠写法 | 它会做 |
| --- | --- |
| `/switch-account list` | 列出账号和余额。 |
| `/switch-account refresh` | 刷新所有账号余额。 |
| `/switch-account best` | 切换到瓶颈余额最高的账号。 |
| `/switch-account switch muka2` | 切换到 `muka2`。 |
| `/switch-account muka2` | 简写，直接切换到 `muka2`。 |
| `/switch-account status` | 查看当前账号是否在账号库中。 |
| `/switch-account 保存当前 主账号` | 把当前 Codex 登录保存为 `主账号`。 |
| `/switch-account import ../codex-auths/backup.auth.json 备用账号` | 从 auth 文件导入 `备用账号`。 |
| `/switch-account auto-refresh` | 开启切换后的自动运行态刷新。 |
| `/switch-account 关闭自动刷新运行态` | 关闭切换后的自动运行态刷新。 |
| `/switch-account defaults show` | 查看默认权限、模型、智能档和速度。 |
| `/switch-account defaults preset smart` | 使用智能优先预设。 |
| `/switch-account defaults set --sandbox workspace-write --approval on-request --speed fast` | 手动设置默认权限、审批和速度。 |
| `/switch-account defaults set --model gpt-5.5 --effort xhigh --speed fast` | 手动设置模型、智能档和速度。 |
| `/switch-account defaults apply` | 立即写入 `~/.codex/config.toml`。 |
| `/switch-account help` | 显示斜杠入口帮助。 |

也支持部分中文短句。为保证稳定，建议保留 `/switch-account` 前缀，并使用下列已验证写法：

| 你发 | 它会做 |
| --- | --- |
| `/switch-account 把当前 Codex 登录保存成主账号` | 读取当前 `~/.codex/auth.json` 并保存快照。 |
| `/switch-account 从 ../codex-auths/backup.auth.json 导入一个账号 叫备用账号` | 从相对路径导入一个账号快照。 |
| `/switch-account 列出 Codex 账号和余额` | 显示账号、当前标记、5 小时/7 天余额。 |
| `/switch-account 刷新所有账号余额` | 逐个账号调用余额读取。 |
| `/switch-account 切换到瓶颈余额最高的账号` | 自动选择 `min(5小时余额, 7天余额)` 最大的账号并切换。 |
| `/switch-account 默认权限 工作区可写` | 保存默认权限配置。 |
| `/switch-account 默认模型 smart` | 保存智能优先模型预设。 |
| `/switch-account 应用默认配置` | 写入 `~/.codex/config.toml`。 |
| `/switch-account auto-refresh` | 后续切换时自动刷新 app-server；Codex App 下会尽量避免手动重启。 |

Codex App 插件本身是 skill 插件，不是侧边栏 UI。当前 Codex 插件 manifest 没有可确认的原生 slash-command 声明字段，所以这里的 `/switch-account ...` 是斜杠风格消息入口，不是 Codex App 原生命令。新对话加载插件后，Codex 应按 skill 规则处理这类消息；如果没有触发，请明确说“使用 Codex 账号切换器执行 /switch-account list”。

## 第一次添加账号

本工具不自建 OAuth 登录流程。你需要先用官方 Codex 登录账号，再把当前登录或已有 `auth.json` 保存进账号库。

### 保存当前登录

在 Codex App 对话里发：

```text
/switch-account 保存当前 主账号
```

这会读取当前机器的 `~/.codex/auth.json`，保存为账号快照。

### 从文件导入

推荐使用相对路径，方便不同机器和不同用户复用同一套说明：

```text
/switch-account import ../codex-auths/backup.auth.json 备用账号
```

不要把真实 `auth.json` 放进会提交的 Git 仓库目录。上面的 `../codex-auths/` 是示例，表示放在当前项目目录外侧；你也可以用自己信任的绝对路径。

相对路径规则：

| 入口 | 相对路径从哪里算 |
| --- | --- |
| Codex App 插件 | 当前对话所在工作目录。 |
| VS Code 扩展设置 | 当前 workspace。 |
| VS Code Remote SSH | 远程 workspace。 |
| CLI | 当前 shell 所在目录。 |

账号快照默认保存在：

```text
~/.codex/account-switcher/
```

UI、日志和错误信息不会显示 token。账号快照文件本身仍然是敏感文件，只建议放在你信任的机器和目录里。工具会 best-effort 将账号库目录收紧到 `0700`，将账号快照、`auth.json`、备份和临时文件收紧到 `0600`；如果底层文件系统不支持 chmod，会继续按当前系统权限运行。

## 切换账号会发生什么

手动切换：

```text
/switch-account switch muka2
/switch-account muka2
```

自动切换到瓶颈余额最高的账号：

```text
/switch-account best
```

切换流程：

```text
选择账号快照
  -> 备份当前 ~/.codex/auth.json
  -> 写入目标账号 auth.json
  -> account/read(refreshToken=true) 验证
  -> 如 token 被刷新，同步回账号快照
  -> 如启用默认运行配置，写入 ~/.codex/config.toml
  -> 如启用运行态刷新，自动选择 daemon 或 Codex App app-server 刷新
```

需要注意：

- 已经运行中的 Codex 对话不保证热切换；必要时 reload/restart，新请求会使用新账号和新配置。
- 余额读取依赖 Codex app-server 的 `account/rateLimits/read`。
- 如果余额刷新失败，工具仍然可以切换账号，因为基础切换只依赖本地 `auth.json` 文件。

## 默认权限、模型和速度

账号切换后，Codex 可能回到其它权限或模型设置。本工具可以保存一套默认运行配置，并在每次切换账号后自动写回 `~/.codex/config.toml`。

常用命令：

```text
/switch-account defaults show
/switch-account defaults preset smart
/switch-account defaults set --sandbox workspace-write --approval on-request --speed fast
/switch-account defaults set --model gpt-5.5 --effort xhigh --speed fast
/switch-account defaults apply
```

也可以用更短的中文写法：

```text
/switch-account 默认权限 工作区可写
/switch-account 默认模型 smart
/switch-account 默认速度 fast
/switch-account 应用默认配置
```

让后续账号切换后自动刷新 app-server 运行态：

```text
/switch-account auto-refresh
```

关闭该行为：

```text
/switch-account 关闭自动刷新运行态
```

如果先使用 `smart` 这类预设，再手动修改模型、reasoning effort 或速度档，工具会把模型策略切到 `custom`，避免后续保存时又被预设覆盖。

### 配置含义

| 配置 | 可选值 | 说明 |
| --- | --- | --- |
| 访问权限 | `read-only` / `workspace-write` / `danger-full-access` | 只读、工作区可写、完全访问。 |
| 审批策略 | `untrusted` / `on-request` / `never` | 严格、按需、不请求审批。 |
| 模型预设 | `speed` / `balanced` / `smart` / `custom` | 速度优先、均衡、智能优先、自定义。 |
| 速度档 | `standard` / `fast` | `fast` 会写入 `service_tier = "priority"`；`standard` 会移除该默认速度档。 |
| 运行态刷新 | `auto` / `daemon` / `codex-app` | `auto` 先试 standalone/远程 daemon；失败后在 macOS Codex App 中安排 app-server 子进程约 12 秒后刷新。 |

模型预设默认值：

| 预设 | 模型 | reasoning effort | 速度档 |
| --- | --- | --- | --- |
| `speed` | `gpt-5.4-mini` | `low` | `standard` |
| `balanced` | `gpt-5.5` | `medium` | `standard` |
| `smart` | `gpt-5.5` | `xhigh` | `fast` |
| `custom` | 手动指定 | 手动指定 | 手动指定 |

## VS Code 扩展

仓库根目录已经放了可直接安装的 VSIX 包：

```text
codex-account-switcher-0.1.2.vsix
```

安装方式：

- VS Code 里打开 Extensions 面板，选择 “Install from VSIX...”，然后选中这个文件。
- 或者在终端里运行 `code --install-extension codex-account-switcher-0.1.2.vsix`。

开发者需要重新打包时再运行：

```bash
npm run package:vsix
```

安装后，从 Activity Bar 打开“Codex 账号”侧栏。

侧栏里可以完成：

- 保存当前账号。
- 从 `auth.json` 导入账号。
- 刷新 5 小时和 7 天余额。
- 手动切换到指定账号。
- 自动切换到瓶颈余额最高的账号。
- 设置默认访问权限、审批策略、模型、reasoning effort 和速度档。
- 保存默认配置并立即应用。
- 可选开启切换后自动刷新 app-server 运行态。

Remote SSH 使用时，VS Code 扩展运行在远程服务器上，所以文件选择、账号库、`~/.codex/auth.json` 和 `~/.codex/config.toml` 都属于远程服务器。

## CLI 交互界面

如果你在终端里直接运行 `codex`，可以先用交互菜单选账号：

```bash
codex-account-switcher ui
```

菜单会显示当前账号、5 小时余额、7 天余额、瓶颈余额和余额读取错误。可用操作：

| 输入 | 作用 |
| --- | --- |
| `1`、`2`、`3` | 按编号切换到对应账号。 |
| `muka3` | 按账号标签切换。 |
| `b` | 刷新余额并自动切换到瓶颈余额最高的账号。 |
| `r` | 刷新所有账号余额。 |
| `q` | 退出菜单。 |

切换后建议重新打开一个 Codex 会话，或者退出当前 `codex` 后重新进入。

## 自动化和调试

普通使用时不要加任何底层二进制前缀，所有面向人的账号切换命令都写成 `/switch-account ...`。例如：

```text
/switch-account 保存当前 主账号
/switch-account import ../codex-auths/backup.auth.json 备用账号
/switch-account list
/switch-account refresh
/switch-account switch muka2
/switch-account best
/switch-account status
/switch-account defaults show
/switch-account defaults preset smart
/switch-account defaults set --sandbox workspace-write --approval on-request --speed fast
/switch-account defaults set --model gpt-5.5 --effort xhigh --speed fast
/switch-account defaults set --restart-app-server-after-switch true --app-server-restart-mode auto
/switch-account defaults apply
/switch-account auto-refresh
/switch-account 关闭自动刷新运行态
/switch-account help
```

开发者如果要做脚本集成，可以调用项目底层 CLI，但 README 不再把底层二进制前缀作为用户命令展示，避免在 Codex App 对话里复制错入口。脚本可用的选项和 slash 写法共用同一套解析逻辑：

| 参数 | 说明 |
| --- | --- |
| `--codex-home <path>` | 指定目标 Codex home，默认是 `~/.codex`，支持相对路径。 |
| `--store <path>` | 指定账号库路径，默认是 `~/.codex/account-switcher`，支持相对路径。 |
| `--codex-cli <path>` | 指定 Codex CLI 路径。裸命令走 PATH；`./tools/codex` 这类路径支持相对写法。 |
| `--json` | 输出 JSON，适合脚本处理；可能包含 `sourcePath`、`backupPath`、`codexHome` 这类本机路径元数据，但不会包含 token。 |

运行态刷新参数：

| 参数 | 说明 |
| --- | --- |
| `--restart-app-server-after-switch true` | 切换账号后自动刷新 app-server 运行态。 |
| `--app-server-restart-mode auto` | 默认推荐。先试 daemon；如果 Codex App 不是 standalone install，则安排 macOS Codex App app-server 约 12 秒后刷新。 |
| `--app-server-restart-mode daemon` | 只用于 standalone/远程 daemon。 |
| `--app-server-restart-mode codex-app` | 只用于 macOS Codex App。 |
| `--no-restart-app-server-after-switch` | 关闭自动刷新。 |

示例：需要对临时 Codex home 调试时，可以在脚本里传 `--codex-home ./tmp/codex-home --store ./tmp/codex-store`，避免影响真实账号。

## 文件写入边界

| 文件或目录 | 什么时候会写 |
| --- | --- |
| `~/.codex/auth.json` | 切换账号时写入目标账号快照。 |
| `~/.codex/auth.json.bak.account-switcher-*` | 切换前备份旧 auth。 |
| `~/.codex/account-switcher/` | 保存账号快照、余额缓存、默认配置；首次列表、状态或默认配置检查也可能初始化这个目录。 |
| `~/.codex/config.toml` | 启用默认运行配置后写入权限、模型、速度档。 |

本机和远程不会默认同步。Remote SSH 场景下，远程服务器需要单独保存或导入账号。

当前没有一键回滚命令；如需回滚，需要手动把 `auth.json.bak.account-switcher-*` 备份恢复成 `~/.codex/auth.json`。

## 常见问题

**余额刷新失败，为什么仍然能切换？**

余额刷新依赖 Codex app-server 和当前账号状态；切换只需要把账号快照写入 `auth.json`。因此余额失败不会阻止基础切换。

**切换后当前 Codex 对话为什么没有立刻变化？**

运行中的 Codex session 不保证热切换。切换主要保证磁盘 `auth.json`、后续请求或新 session 生效。你可以发 `/switch-account auto-refresh`，让工具在切换后自动刷新 app-server；在 macOS Codex App 下，它会安排 app-server 子进程在本轮命令返回后刷新，通常不需要手动重启整个 App。

**会不会显示 token？**

不会在 UI、日志或错误里显示 token。但账号快照文件本身包含敏感凭据，应只保存在可信目录。

**这个工具会修改文件权限吗？**

会做 best-effort 收紧：账号库目录尽量设为 `0700`，账号快照、`auth.json`、备份和临时文件尽量设为 `0600`。如果文件系统不支持，工具不会因此中断。

## 开发与验证

```bash
npm install
npm run build
npm test
npm run package:vsix
```

常用本地检查：

```text
/switch-account help
/switch-account defaults show
```

`/switch-account defaults show` 可能会初始化 `~/.codex/account-switcher/` 目录，但不会写入 `auth.json` 或 `config.toml`。
