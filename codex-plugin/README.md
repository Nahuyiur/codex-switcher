# Codex 账号切换器插件

这个目录是 Codex App 插件包。安装后，Codex 可以按 `skills/account-switcher/SKILL.md` 调用本项目构建出的 CLI。

先在仓库根目录运行：

```bash
npm install
npm run build
```

然后把 `codex-plugin` 作为本地 marketplace/plugin 来源安装，或在 Codex 内按本地插件流程加载。

安装后可以直接在 Codex App 里说：

- “列出 Codex 账号”
- “切换到余额最多的账号”
- “把默认权限设成工作区可写”
- “把默认模型设成智能优先并立即应用”
