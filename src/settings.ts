import {
  AppServerRestartMode,
  ApprovalPolicy,
  ModelPreset,
  ReasoningEffort,
  SandboxMode,
  SpeedTier,
  SwitcherSettings,
  SwitcherSettingsUpdate,
} from "./types";

const SANDBOX_MODES: SandboxMode[] = ["read-only", "workspace-write", "danger-full-access"];
const APPROVAL_POLICIES: ApprovalPolicy[] = ["untrusted", "on-request", "never"];
const MODEL_PRESETS: ModelPreset[] = ["speed", "balanced", "smart", "custom"];
const REASONING_EFFORTS: ReasoningEffort[] = ["minimal", "low", "medium", "high", "xhigh"];
const SPEED_TIERS: SpeedTier[] = ["standard", "fast"];
const APP_SERVER_RESTART_MODES: AppServerRestartMode[] = ["auto", "daemon", "codex-app"];

export const KNOWN_MODELS = ["gpt-5.5", "gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex", "gpt-5.2"] as const;

export const MODEL_PRESET_VALUES: Record<
  Exclude<ModelPreset, "custom">,
  { model: string; modelReasoningEffort: ReasoningEffort; speedTier: SpeedTier }
> = {
  speed: { model: "gpt-5.4-mini", modelReasoningEffort: "low", speedTier: "standard" },
  balanced: { model: "gpt-5.5", modelReasoningEffort: "medium", speedTier: "standard" },
  smart: { model: "gpt-5.5", modelReasoningEffort: "xhigh", speedTier: "fast" },
};

export function defaultSwitcherSettings(): SwitcherSettings {
  return {
    version: 1,
    applyAfterSwitch: true,
    restartAppServerAfterSwitch: false,
    appServerRestartMode: "auto",
    sandboxMode: "workspace-write",
    approvalPolicy: "on-request",
    modelPreset: "custom",
    speedTier: "standard",
  };
}

export function normalizeSwitcherSettings(input: unknown): SwitcherSettings {
  const defaults = defaultSwitcherSettings();
  if (!input || typeof input !== "object") {
    return defaults;
  }
  const raw = input as Partial<SwitcherSettings>;
  const next: SwitcherSettings = {
    version: 1,
    applyAfterSwitch: typeof raw.applyAfterSwitch === "boolean" ? raw.applyAfterSwitch : defaults.applyAfterSwitch,
    restartAppServerAfterSwitch:
      typeof raw.restartAppServerAfterSwitch === "boolean"
        ? raw.restartAppServerAfterSwitch
        : defaults.restartAppServerAfterSwitch,
    appServerRestartMode: isAppServerRestartMode(raw.appServerRestartMode)
      ? raw.appServerRestartMode
      : defaults.appServerRestartMode,
    sandboxMode: isSandboxMode(raw.sandboxMode) ? raw.sandboxMode : defaults.sandboxMode,
    approvalPolicy: isApprovalPolicy(raw.approvalPolicy) ? raw.approvalPolicy : defaults.approvalPolicy,
    modelPreset: isModelPreset(raw.modelPreset) ? raw.modelPreset : defaults.modelPreset,
    model: typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : undefined,
    modelReasoningEffort: isReasoningEffort(raw.modelReasoningEffort) ? raw.modelReasoningEffort : undefined,
    speedTier: isSpeedTier(raw.speedTier) ? raw.speedTier : defaults.speedTier,
    updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
  };
  if (next.modelPreset !== "custom") {
    Object.assign(next, MODEL_PRESET_VALUES[next.modelPreset]);
  }
  return next;
}

export function updateSwitcherSettings(
  current: SwitcherSettings | undefined,
  update: SwitcherSettingsUpdate,
): SwitcherSettings {
  const next = normalizeSwitcherSettings(current);
  if (update.applyAfterSwitch !== undefined) {
    next.applyAfterSwitch = update.applyAfterSwitch;
  }
  if (update.restartAppServerAfterSwitch !== undefined) {
    next.restartAppServerAfterSwitch = update.restartAppServerAfterSwitch;
  }
  if (update.appServerRestartMode !== undefined) {
    next.appServerRestartMode = update.appServerRestartMode ?? "auto";
  }
  if (update.sandboxMode !== undefined) {
    next.sandboxMode = update.sandboxMode ?? undefined;
  }
  if (update.approvalPolicy !== undefined) {
    next.approvalPolicy = update.approvalPolicy ?? undefined;
  }
  if (update.modelPreset !== undefined) {
    next.modelPreset = update.modelPreset ?? "custom";
  }
  if (update.model !== undefined) {
    next.model = update.model?.trim() || undefined;
  }
  if (update.modelReasoningEffort !== undefined) {
    next.modelReasoningEffort = update.modelReasoningEffort ?? undefined;
  }
  if (update.speedTier !== undefined) {
    next.speedTier = update.speedTier ?? "standard";
  }
  if (next.modelPreset !== "custom") {
    Object.assign(next, MODEL_PRESET_VALUES[next.modelPreset]);
  }
  next.updatedAt = new Date().toISOString();
  return normalizeSwitcherSettings(next);
}

export function codexConfigValuesForSettings(settings: SwitcherSettings): Record<string, string | null> {
  const values: Record<string, string | null> = {};
  if (settings.sandboxMode) {
    values.sandbox_mode = settings.sandboxMode;
  }
  if (settings.approvalPolicy) {
    values.approval_policy = settings.approvalPolicy;
  }
  if (settings.model) {
    values.model = settings.model;
  }
  if (settings.modelReasoningEffort) {
    values.model_reasoning_effort = settings.modelReasoningEffort;
  }
  values.service_tier = settings.speedTier === "fast" ? "priority" : null;
  return values;
}

export function isSandboxMode(value: unknown): value is SandboxMode {
  return typeof value === "string" && SANDBOX_MODES.includes(value as SandboxMode);
}

export function isApprovalPolicy(value: unknown): value is ApprovalPolicy {
  return typeof value === "string" && APPROVAL_POLICIES.includes(value as ApprovalPolicy);
}

export function isModelPreset(value: unknown): value is ModelPreset {
  return typeof value === "string" && MODEL_PRESETS.includes(value as ModelPreset);
}

export function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === "string" && REASONING_EFFORTS.includes(value as ReasoningEffort);
}

export function isSpeedTier(value: unknown): value is SpeedTier {
  return typeof value === "string" && SPEED_TIERS.includes(value as SpeedTier);
}

export function isAppServerRestartMode(value: unknown): value is AppServerRestartMode {
  return typeof value === "string" && APP_SERVER_RESTART_MODES.includes(value as AppServerRestartMode);
}

export function describeSettings(settings: SwitcherSettings): string {
  const model = settings.model ? `${settings.model}${settings.modelReasoningEffort ? `/${settings.modelReasoningEffort}` : ""}` : "不覆盖模型";
  const speed = settings.speedTier === "fast" ? "快速" : "标准";
  const apply = settings.applyAfterSwitch ? "切换后自动应用" : "仅保存不自动应用";
  const restart = settings.restartAppServerAfterSwitch
    ? `切换后刷新 app-server(${settings.appServerRestartMode})`
    : "不重启 app-server";
  return `权限 ${settings.sandboxMode || "不覆盖"}，审批 ${settings.approvalPolicy || "不覆盖"}，模型 ${model}，速度 ${speed}，${apply}，${restart}`;
}
