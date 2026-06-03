# Codex 账号切换器

一个本地工具，用来保存、导入、查看余额并快速切换 Codex `auth.json` 账号。界面和提示默认中文。

## 功能

- 保存当前 `~/.codex/auth.json` 为账号快照。
- 从指定路径导入已有 `auth.json`。
- 写入目标机器的 `~/.codex/auth.json` 完成切换，并自动备份旧文件。
- 通过 Codex app-server 尝试读取 5 小时和 7 天余额；失败时不影响基础切换。
- VS Code Activity Bar 侧栏适配本地和 Remote SSH。
- Codex App 插件目录在 `codex-plugin/`。

## 使用

```bash
npm install
npm run build
node dist/src/cli.js add-current --label 主账号
node dist/src/cli.js import --from /path/to/auth.json --label 备用账号
node dist/src/cli.js refresh-limits --all
node dist/src/cli.js switch --best
```

VS Code 扩展打包：

```bash
npm run package:vsix
```

## CLI

- `add-current [--label 名称]`
- `import --from <path> [--label 名称]`
- `list [--json]`
- `refresh-limits --all [--json]`
- `switch <account-id> [--json]`
- `switch --best [--json]`
- `status [--json]`
- `doctor [--json]`

通用参数：

- `--codex-home <path>` 指定目标 Codex home。
- `--store <path>` 指定账号库路径。
- `--codex-cli <path>` 指定 Codex CLI 路径。

## 安全边界

v1 不强制修改权限，也不主动 `chmod 0600`。工具会避免在 UI、日志和错误里显示 token，但账号快照本身仍然是敏感文件，应只放在你信任的机器和目录下。
