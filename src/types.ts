export type AuthMode = "apikey" | "chatgpt" | "chatgptAuthTokens" | "agentIdentity" | string;

export interface AuthJson {
  auth_mode?: AuthMode;
  OPENAI_API_KEY?: string | null;
  tokens?: {
    id_token?: string;
    access_token?: string;
    refresh_token?: string;
    account_id?: string;
    [key: string]: unknown;
  };
  last_refresh?: string;
  [key: string]: unknown;
}

export type RateWindowKind = "5h" | "7d" | "other";

export interface RateWindow {
  kind: RateWindowKind;
  usedPercent: number;
  remainingPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface AccountSummary {
  id: string;
  label: string;
  sourcePath?: string;
  email?: string;
  accountId?: string;
  planType?: string;
  active: boolean;
  lastRefreshAt?: string;
  windows: RateWindow[];
  error?: string;
}

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export type ApprovalPolicy = "untrusted" | "on-request" | "never";

export type ModelPreset = "speed" | "balanced" | "smart" | "custom";

export type ReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

export type SpeedTier = "standard" | "fast";

export interface SwitcherSettings {
  version: 1;
  applyAfterSwitch: boolean;
  restartAppServerAfterSwitch: boolean;
  sandboxMode?: SandboxMode;
  approvalPolicy?: ApprovalPolicy;
  modelPreset: ModelPreset;
  model?: string;
  modelReasoningEffort?: ReasoningEffort;
  speedTier: SpeedTier;
  updatedAt?: string;
}

export interface SwitcherSettingsUpdate {
  applyAfterSwitch?: boolean;
  restartAppServerAfterSwitch?: boolean;
  sandboxMode?: SandboxMode | null;
  approvalPolicy?: ApprovalPolicy | null;
  modelPreset?: ModelPreset | null;
  model?: string | null;
  modelReasoningEffort?: ReasoningEffort | null;
  speedTier?: SpeedTier | null;
}

export interface AppliedCodexConfig {
  configPath: string;
  backupPath?: string;
  changedKeys: string[];
}

export interface DaemonRestartResult {
  attempted: boolean;
  success: boolean;
  message: string;
  error?: string;
}

export interface SwitchResult {
  targetAccountId: string;
  previousAccountId?: string;
  backupPath: string;
  verified: boolean;
  diskAuthWritten: boolean;
  refreshedAuthSnapshot: boolean;
  needsReloadHint: boolean;
  message: string;
  selectionReason?: string;
  appliedDefaults?: AppliedCodexConfig | null;
  defaultsError?: string;
  appServerDaemonRestart?: DaemonRestartResult;
}

export interface StoredAccount {
  id: string;
  label: string;
  sourcePath?: string;
  snapshotFile: string;
  addedAt: string;
  updatedAt: string;
  lastRefreshAt?: string;
  email?: string;
  accountId?: string;
  planType?: string;
  windows?: RateWindow[];
  error?: string;
}

export interface StoreFile {
  version: 1;
  accounts: StoredAccount[];
  settings?: SwitcherSettings;
}

export interface ManagerOptions {
  codexHome?: string;
  accountLibraryPath?: string;
  codexCliPath?: string;
  appServerTimeoutMs?: number;
  baseDir?: string;
}

export interface RateLimitWindowRaw {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

export interface RateLimitSnapshotRaw {
  limitId: string | null;
  limitName: string | null;
  primary: RateLimitWindowRaw | null;
  secondary: RateLimitWindowRaw | null;
  credits: { hasCredits: boolean; unlimited: boolean; balance: string | null } | null;
  planType: string | null;
  rateLimitReachedType: string | null;
}

export interface AccountReadResponse {
  account: null | { type: string; email?: string; planType?: string };
  requiresOpenaiAuth: boolean;
}

export interface RateLimitsReadResponse {
  rateLimits: RateLimitSnapshotRaw;
  rateLimitsByLimitId: Record<string, RateLimitSnapshotRaw> | null;
}
