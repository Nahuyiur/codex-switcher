# Codex 账号切换器

当用户要在 Codex App 管理本机 Codex 账号时使用本 skill：保存当前登录、导入 `auth.json`、列出账号、刷新 5 小时/7 天余额、切换指定账号、切到余额最佳账号、查看或设置默认权限/审批/模型/智能档/速度档，以及切换后运行态刷新。

`/switch-account` 是本插件的斜杠风格消息入口，不是已确认的 Codex App 原生 autocomplete 命令。只要用户消息以 `/switch-account` 开头，就按本 skill 处理；不要承诺它会出现在 App 自动补全列表里。

## 执行规则

- 内部执行优先使用已链接的底层可执行文件 `codex-account-switcher`；如果不可用且当前在本仓库构建后目录，可直接运行 `dist/src/cli.js`。
- 面向用户的回复保持中文。
- 不要打印 `auth.json` 里的 token；报错只总结清洗后的错误。
- 相对路径按当前对话工作目录解释。
- 用户以 `/switch-account` 开头时，把完整 slash 消息交给底层 CLI，并追加 `--json`；总结返回的 `message`。
- 如果 shell 或调用环境不方便传递 `/switch-account` 这个参数，可以退回兼容形式：调用底层 CLI 的 `slash "<去掉 /switch-account 后的文本>" --json`。
- 不要把底层 CLI 前缀或内部执行命令展示给用户；用户可见命令一律写成 `/switch-account ...`。

## 能力映射

- 列出账号：`/switch-account list`，总结标签、当前状态、5 小时余额、7 天余额和错误。
- 保存当前：`/switch-account 保存当前 <名称>`。
- 导入账号：`/switch-account import <path> <名称>`。
- 刷新余额：`/switch-account refresh`。
- 切换账号：`/switch-account switch <账号名或id>`，说明是否写入磁盘、验证、同步刷新后快照、是否安排 app-server 刷新，以及是否还需要 reload/restart。
- 最佳账号：`/switch-account best`。
- 默认配置查看：`/switch-account defaults show`。
- 默认权限/审批：`/switch-account defaults set --sandbox read-only|workspace-write|danger-full-access --approval untrusted|on-request|never`。
- 默认模型预设：`/switch-account defaults preset speed|balanced|smart|custom`。
- 默认模型细项：`/switch-account defaults set --model <model> --effort minimal|low|medium|high|xhigh --speed standard|fast`。
- 切换后自动刷新运行态：`/switch-account auto-refresh`。
- 关闭自动刷新：`/switch-account 关闭自动刷新运行态`。
- 立即应用默认配置：`/switch-account defaults apply`。

## `/switch-account` 示例

- `/switch-account list`：列出账号和余额。
- `/switch-account refresh`：刷新所有账号余额。
- `/switch-account best`：切换到瓶颈余额最高的账号。
- `/switch-account switch muka2`：切换到标签/id/email 匹配 `muka2` 的账号。
- `/switch-account muka2`：简写，直接切换到 `muka2`。
- `/switch-account status`：查看当前账号是否已保存在账号库。
- `/switch-account 保存当前 主账号`：把当前 Codex 登录保存为 `主账号`。
- `/switch-account import ../codex-auths/backup.auth.json 备用账号`：导入 auth 文件。
- `/switch-account auto-refresh`：开启切换后的自动运行态刷新。
- `/switch-account 关闭自动刷新运行态`：关闭切换后的自动运行态刷新。
- `/switch-account defaults show`：查看默认权限、审批、模型、智能档和速度。
- `/switch-account defaults preset smart`：保存智能优先模型预设。
- `/switch-account defaults set --sandbox workspace-write --approval on-request --speed fast`：手动设置默认权限、审批和速度。
- `/switch-account defaults set --model gpt-5.5 --effort xhigh --speed fast`：手动设置模型、智能档和速度。
- `/switch-account defaults apply`：立即写入 `~/.codex/config.toml`。
- `/switch-account help`：显示斜杠入口帮助。

## 注意

- 切换会把目标账号快照写入目标机器的 `~/.codex/auth.json`。
- 切换后会用 `account/read(refreshToken=true)` 验证；如果验证过程中 auth 被刷新，会同步回账号快照。
- 开启默认配置后，切换也会写 `~/.codex/config.toml` 里的 `sandbox_mode`、`approval_policy`、`model`、`model_reasoning_effort` 和 `service_tier`。
- 开启 `auto` 运行态刷新后，会先尝试 `codex app-server daemon restart`；macOS Codex App 场景下可能在命令返回约 12 秒后安排 app-server 刷新。
- 运行中的 Codex turn 可能短暂重连；如果当前 turn 仍看不到新 auth，建议开新 turn/thread。
- VS Code Remote SSH 场景优先用 VS Code 扩展，它运行在远程 extension host，操作远程 `~/.codex`。
