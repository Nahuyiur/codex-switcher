# Codex 账号切换器

Use this skill when the user wants to manage local Codex accounts from Codex App: list saved accounts, import an `auth.json`, save the current account, refresh 5-hour/7-day balances, switch to a selected account, switch to the account with the most remaining balance, or set default Codex permissions/model/speed.

## Workflow

- Prefer the linked CLI command: `codex-account-switcher`.
- If the linked command is unavailable and the current working directory is this repository after build, use `node dist/src/cli.js`.
- Keep all user-facing text in Chinese.
- Never print token values from `auth.json`; if a command errors, summarize the sanitized error only.
- For listing accounts, run `codex-account-switcher list --json` and summarize label, active state, 5小时余额, 7天余额, and any error.
- To save the current account, run `codex-account-switcher add-current --label <名称>`.
- To import a file, ask for or use the path, then run `codex-account-switcher import --from <path> --label <名称>`.
- To refresh balances, run `codex-account-switcher refresh-limits --all --json`.
- To switch to a specific account, run `codex-account-switcher switch <account-id> --json` and report whether `verified` is true.
- To switch automatically, run `codex-account-switcher switch --best --json`.
- To show default runtime settings, run `codex-account-switcher defaults show --json`.
- To set the permission preset, use `codex-account-switcher defaults set --sandbox read-only|workspace-write|danger-full-access --json`.
- To set model behavior quickly, use `codex-account-switcher defaults preset speed|balanced|smart|custom --json`.
- To set custom model settings, use `codex-account-switcher defaults set --model <model> --effort minimal|low|medium|high|xhigh --speed standard|fast --json`.
- To apply saved defaults immediately, run `codex-account-switcher defaults apply --json`.

## Notes

- Switching writes the selected snapshot to the target machine's `~/.codex/auth.json`.
- If enabled, switching also writes saved defaults to `~/.codex/config.toml` for `sandbox_mode`, `approval_policy`, `model`, `model_reasoning_effort`, and `service_tier`.
- Running Codex turns may need reload/restart before they see the new auth.
- In VS Code Remote SSH, use the VS Code extension instead; it runs on the remote extension host and operates on the remote `~/.codex`.
