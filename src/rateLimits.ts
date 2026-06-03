import { RateLimitSnapshotRaw, RateWindow, RateLimitWindowRaw, StoredAccount } from "./types";

export function normalizeRateWindows(snapshot: RateLimitSnapshotRaw | null | undefined): RateWindow[] {
  if (!snapshot) {
    return [];
  }
  return [snapshot.primary, snapshot.secondary]
    .filter((window): window is RateLimitWindowRaw => Boolean(window))
    .map((window) => {
      const usedPercent = clampPercent(window.usedPercent);
      return {
        kind: classifyWindow(window.windowDurationMins),
        usedPercent,
        remainingPercent: clampPercent(100 - usedPercent),
        windowDurationMins: window.windowDurationMins,
        resetsAt: window.resetsAt,
      };
    })
    .sort((a, b) => windowSortKey(a) - windowSortKey(b));
}

export function chooseCodexSnapshot(
  response: { rateLimits: RateLimitSnapshotRaw; rateLimitsByLimitId: Record<string, RateLimitSnapshotRaw> | null },
): RateLimitSnapshotRaw {
  return response.rateLimitsByLimitId?.codex || response.rateLimits;
}

export function pickBestAccount(accounts: StoredAccount[]): StoredAccount | undefined {
  return accounts
    .filter((account) => !account.error)
    .slice()
    .sort((a, b) => compareAccountScore(b) - compareAccountScore(a))[0];
}

export function scoreAccount(account: Pick<StoredAccount, "windows">): number {
  const fiveHour = account.windows?.find((window) => window.kind === "5h")?.remainingPercent;
  const sevenDay = account.windows?.find((window) => window.kind === "7d")?.remainingPercent;
  if (fiveHour == null && sevenDay == null) {
    return -1;
  }
  return Math.min(fiveHour ?? 100, sevenDay ?? 100);
}

export function formatWindow(window: RateWindow | undefined): string {
  if (!window) {
    return "未知";
  }
  return `${Math.round(window.remainingPercent)}%`;
}

function compareAccountScore(account: StoredAccount): number {
  const fiveHour = account.windows?.find((window) => window.kind === "5h")?.remainingPercent ?? -1;
  const sevenDay = account.windows?.find((window) => window.kind === "7d")?.remainingPercent ?? -1;
  const bottleneck = scoreAccount(account);
  const reset = Math.max(...(account.windows || []).map((window) => window.resetsAt || 0), 0);
  return bottleneck * 1_000_000 + fiveHour * 10_000 + sevenDay * 100 + reset / 1_000_000_000;
}

function classifyWindow(durationMins: number | null): "5h" | "7d" | "other" {
  if (durationMins == null) {
    return "other";
  }
  if (Math.abs(durationMins - 300) <= 10) {
    return "5h";
  }
  if (Math.abs(durationMins - 10080) <= 120) {
    return "7d";
  }
  return "other";
}

function windowSortKey(window: RateWindow): number {
  if (window.kind === "5h") {
    return 1;
  }
  if (window.kind === "7d") {
    return 2;
  }
  return 3;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(100, value));
}
