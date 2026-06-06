# Codex 账号切换器插件

这个目录是 Codex App 插件包。安装后，Codex 会按 `skills/account-switcher/SKILL.md` 调用本项目构建出的 CLI，帮你管理本机 Codex 账号。

先在仓库根目录运行：

```bash
npm install
npm run build
npm link
```

然后安装插件：

```bash
codex plugin marketplace add Nahuyiur/codex-switcher --ref main
codex plugin add codex-account-switcher@codex-switcher
```

如果已经安装过旧版本，重新运行上面的构建和安装命令，并开一个新的 Codex 对话再使用新入口。

## `/switch-account` 入口

`/switch-account ...` 是斜杠风格消息入口：你把它当普通消息发给 Codex，插件 skill 会把后面的文本交给本项目的本地解析器。它不是已确认的 Codex App 原生 autocomplete 命令，也不保证会出现在自动补全列表里。

常用写法：

- “/switch-account list”
- “/switch-account refresh”
- “/switch-account best”
- “/switch-account switch muka2”
- “/switch-account muka2”
- “/switch-account status”
- “/switch-account 保存当前 主账号”
- “/switch-account import ../codex-auths/backup.auth.json 备用账号”
- “/switch-account auto-refresh”
- “/switch-account 关闭自动刷新运行态”
- “/switch-account defaults show”
- “/switch-account defaults preset smart”
- “/switch-account defaults set --sandbox workspace-write --approval on-request --speed fast”
- “/switch-account defaults set --model gpt-5.5 --effort xhigh --speed fast”
- “/switch-account defaults apply”
- “/switch-account help”

也支持部分中文短句。为保证稳定，建议保留 `/switch-account` 前缀：

- “/switch-account 把当前 Codex 登录保存成主账号”
- “/switch-account 从 `../codex-auths/backup.auth.json` 导入一个账号 叫备用账号”
- “/switch-account 列出 Codex 账号和余额”
- “/switch-account 刷新所有账号余额”
- “/switch-account 切换到 `muka2`”
- “/switch-account 切换到瓶颈余额最高的账号”
- “/switch-account 默认权限 工作区可写”
- “/switch-account 默认模型 smart”
- “/switch-account 应用默认配置”
- “/switch-account auto-refresh”
