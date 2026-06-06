# Codex 账号切换器

Use this skill when the user wants to manage local Codex accounts from Codex App: list saved accounts, import an `auth.json`, save the current account, refresh 5-hour/7-day balances, switch to a selected account, switch to the account with the most remaining balance, or set default Codex permissions/model/speed.

This skill must also be used whenever the user message starts with `/switch-account`. Treat `/switch-account` as the slash-style command entrypoint for this plugin.

## Workflow

- Prefer the linked CLI command: `codex-account-switcher`.
- If the linked command is unavailable and the current working directory is this repository after build, use `node dist/src/cli.js`.
- Keep all user-facing text in Chinese.
- Never print token values from `auth.json`; if a command errors, summarize the sanitized error only.
- For any prompt that starts with `/switch-account`, run `codex-account-switcher slash "<text after /switch-account>" --json` and summarize the returned `message`. Example: `/switch-account switch muka2` maps to `codex-account-switcher slash "switch muka2" --json`.
- For listing accounts, run `codex-account-switcher list --json` and summarize label, active state, 5小时余额, 7天余额, and any error.
- To save the current account, run `codex-account-switcher add-current --label <名称>`.
- To import a file, ask for or use the path, then run `codex-account-switcher import --from <path> --label <名称>`.
- Relative paths are supported; interpret them relative to the current conversation working directory.
- To refresh balances, run `codex-account-switcher refresh-limits --all --json`.
- To switch to a specific account, run `codex-account-switcher switch <account-id> --json` and report `diskAuthWritten`, `verified`, `refreshedAuthSnapshot`, `appServerDaemonRestart.strategy`, `appServerDaemonRestart.scheduled`, and whether reload/restart may still be needed.
- To switch automatically, run `codex-account-switcher switch --best --json`.
- To show default runtime settings, run `codex-account-switcher defaults show --json`.
- To set the permission preset, use `codex-account-switcher defaults set --sandbox read-only|workspace-write|danger-full-access --json`.
- To set model behavior quickly, use `codex-account-switcher defaults preset speed|balanced|smart|custom --json`.
- To set custom model settings, use `codex-account-switcher defaults set --model <model> --effort minimal|low|medium|high|xhigh --speed standard|fast --json`.
- To enable automatic runtime refresh after future switches, run `codex-account-switcher defaults set --restart-app-server-after-switch true --app-server-restart-mode auto --json`.
- To force standalone/remote daemon restart only, run `codex-account-switcher defaults set --restart-app-server-after-switch true --app-server-restart-mode daemon --json`.
- To force macOS Codex App app-server refresh only, run `codex-account-switcher defaults set --restart-app-server-after-switch true --app-server-restart-mode codex-app --json`.
- To disable runtime refresh after future switches, run `codex-account-switcher defaults set --no-restart-app-server-after-switch --json`.
- To apply saved defaults immediately, run `codex-account-switcher defaults apply --json`.

## Slash-style examples

- `/switch-account list` lists saved accounts and balances.
- `/switch-account refresh` refreshes all balances.
- `/switch-account best` switches to the account with the most remaining balance.
- `/switch-account switch muka2` switches to account label/id/email `muka2`.
- `/switch-account muka2` is shorthand for switching to `muka2`.
- `/switch-account 保存当前 主账号` saves the current Codex login as `主账号`.
- `/switch-account import ./accounts/backup.auth.json 备用账号` imports an auth file.
- `/switch-account auto-refresh` enables automatic runtime refresh after future switches.

## Notes

- Switching writes the selected snapshot to the target machine's `~/.codex/auth.json`.
- Switching verifies with `account/read(refreshToken=true)`; if Codex refreshes auth during verification, the refreshed `auth.json` is synced back into the saved account snapshot.
- If enabled, switching also writes saved defaults to `~/.codex/config.toml` for `sandbox_mode`, `approval_policy`, `model`, `model_reasoning_effort`, and `service_tier`.
- If enabled in `auto` mode, switching first tries `codex app-server daemon restart`; if the desktop app is not a standalone install, macOS Codex App app-server refresh is scheduled about 12 seconds after the CLI returns so the assistant can report the result first.
- Running Codex turns may briefly reconnect when the app-server refresh is scheduled. If a loaded turn still does not see the new auth, start a new turn/thread.
- In VS Code Remote SSH, use the VS Code extension instead; it runs on the remote extension host and operates on the remote `~/.codex`.
