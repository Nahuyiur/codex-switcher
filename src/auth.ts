import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import { AuthJson } from "./types";

const OPENAI_AUTH_CLAIM = "https://api.openai.com/auth";

export function parseAuthJson(text: string): AuthJson {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`auth.json 不是合法 JSON: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("auth.json 必须是 JSON object。");
  }
  const auth = parsed as AuthJson;
  if (!auth.OPENAI_API_KEY && !auth.tokens?.access_token && !auth.tokens?.refresh_token) {
    throw new Error("auth.json 中没有找到 API key 或 ChatGPT token。");
  }
  return auth;
}

export async function readAuthJson(filePath: string): Promise<AuthJson> {
  return parseAuthJson(await fs.readFile(filePath, "utf8"));
}

export function stableAuthHash(auth: AuthJson): string {
  const accountId = getAccountId(auth);
  const email = getEmail(auth);
  const stable = accountId || email || auth.tokens?.refresh_token || auth.OPENAI_API_KEY || auth.tokens?.access_token || JSON.stringify(auth);
  return crypto.createHash("sha256").update(stable).digest("hex").slice(0, 16);
}

export function summarizeAuth(auth: AuthJson): {
  email?: string;
  accountId?: string;
  planType?: string;
  suggestedLabel: string;
} {
  const email = getEmail(auth);
  const accountId = getAccountId(auth);
  const planType = getPlanType(auth);
  const suggestedLabel = email || (accountId ? `账号 ${accountId.slice(0, 8)}` : `API Key ${stableAuthHash(auth).slice(0, 8)}`);
  return { email, accountId, planType, suggestedLabel };
}

export function getAccountId(auth: AuthJson): string | undefined {
  return (
    auth.tokens?.account_id ||
    readOpenAiAuthClaim(auth.tokens?.access_token)?.chatgpt_account_id ||
    readOpenAiAuthClaim(auth.tokens?.id_token)?.chatgpt_account_id
  );
}

export function getEmail(auth: AuthJson): string | undefined {
  return readStringClaim(readJwtPayload(auth.tokens?.id_token), "email") || readStringClaim(readJwtPayload(auth.tokens?.access_token), "email");
}

export function getPlanType(auth: AuthJson): string | undefined {
  return (
    readOpenAiAuthClaim(auth.tokens?.access_token)?.chatgpt_plan_type ||
    readOpenAiAuthClaim(auth.tokens?.id_token)?.chatgpt_plan_type
  );
}

export function redactAuth(value: unknown): unknown {
  if (typeof value === "string") {
    if (looksLikeSecret(value)) {
      return `${value.slice(0, 4)}...${value.slice(-4)}`;
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(redactAuth);
  }
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = /token|key|secret/i.test(key) ? "<redacted>" : redactAuth(entry);
    }
    return output;
  }
  return value;
}

export function sanitizeError(error: unknown): string {
  return String((error as Error)?.message || error)
    .replace(/(Bearer\s+)[a-zA-Z0-9._~+/=-]+/gi, "$1<redacted>")
    .replace(/(["']?(?:access_token|refresh_token|id_token|OPENAI_API_KEY|api_key|authorization)["']?\s*[:=]\s*["']?)([^"',\s)]+)/gi, "$1<redacted>")
    .replace(/eyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+/g, "<jwt>")
    .replace(/rt\.[a-zA-Z0-9._-]+/g, "<refresh-token>")
    .replace(/sk-[a-zA-Z0-9_-]+/g, "<api-key>")
    .replace(/sess-[a-zA-Z0-9._-]+/g, "<session-token>");
}

function readOpenAiAuthClaim(token: string | undefined): Record<string, string> | undefined {
  const payload = readJwtPayload(token);
  const claim = payload?.[OPENAI_AUTH_CLAIM];
  return claim && typeof claim === "object" ? (claim as Record<string, string>) : undefined;
}

function readJwtPayload(token: string | undefined): Record<string, unknown> | undefined {
  if (!token) {
    return undefined;
  }
  const parts = token.split(".");
  if (parts.length < 2) {
    return undefined;
  }
  try {
    const json = Buffer.from(parts[1], "base64url").toString("utf8");
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readStringClaim(payload: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = payload?.[key];
  return typeof value === "string" ? value : undefined;
}

function looksLikeSecret(value: string): boolean {
  return value.startsWith("eyJ") || value.startsWith("rt.") || value.startsWith("sk-") || value.length > 80;
}
