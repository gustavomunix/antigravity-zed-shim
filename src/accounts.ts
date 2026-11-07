/**
 * Account pool for the shim.
 *
 * Reads the same `antigravity-accounts.json` written by `opencode auth login`
 * (or by `shim login`), refreshes short-lived access tokens, resolves the
 * managed project context, and persists rotated credentials back to disk.
 * Auth specifics live upstream; this file only orchestrates.
 */
import {
  accessTokenExpired,
  ensureProjectContext,
  formatRefreshParts,
  loadAccounts,
  parseRefreshParts,
  refreshAccessToken,
  saveAccountCredentials,
  type AccountMetadataV3,
  type OAuthAuthDetails,
  type PluginClient,
} from "./upstream";

export interface LiveAuth {
  /** Account the credentials belong to (for persistence). */
  account: AccountMetadataV3;
  /** OAuth details ready to use (fresh access token + project parts). */
  auth: OAuthAuthDetails;
  /** Managed project id to send in the request envelope. */
  projectId: string;
}

/**
 * Minimal stub: `refreshAccessToken` only uses the client object as a
 * WeakMap key for in-flight dedup, never calls its methods.
 */
const dedupClient = {} as PluginClient;

function toOAuth(account: AccountMetadataV3, cached?: { access: string; expires: number }): OAuthAuthDetails {
  return {
    type: "oauth",
    refresh: formatRefreshParts({
      refreshToken: account.refreshToken,
      projectId: account.projectId,
      managedProjectId: account.managedProjectId,
    }),
    access: cached?.access,
    expires: cached?.expires,
  };
}

/** In-memory access-token cache per refresh token (avoids refresh per request). */
const tokenCache = new Map<string, { access: string; expires: number }>();

function isDisabled(account: AccountMetadataV3): boolean {
  return account.enabled === false;
}

function isCoolingDown(account: AccountMetadataV3): boolean {
  return typeof account.coolingDownUntil === "number" && account.coolingDownUntil > Date.now();
}

function orderedAccounts(accounts: AccountMetadataV3[], activeIndex: number): AccountMetadataV3[] {
  if (accounts.length === 0) return [];
  const start = ((activeIndex % accounts.length) + accounts.length) % accounts.length;
  return [...accounts.slice(start), ...accounts.slice(0, start)];
}

/**
 * Returns a live auth for the first usable account, starting at the stored
 * active index. Rotated refresh tokens and newly resolved managed project ids
 * are persisted back to the accounts file.
 *
 * Throws an Error with a human-readable message when no account can serve
 * (missing file, revoked grants, all cooling down, ...).
 */
export async function getLiveAuth(): Promise<LiveAuth> {
  const storage = await loadAccounts();
  if (!storage || storage.accounts.length === 0) {
    throw new Error(
      "No Antigravity accounts found. Run `npm run login` (or `opencode auth login google`) first.",
    );
  }

  const failures: string[] = [];
  for (const account of orderedAccounts(storage.accounts, storage.activeIndex ?? 0)) {
    const label = account.email ?? "account";
    if (isDisabled(account)) {
      failures.push(`${label}: disabled`);
      continue;
    }
    if (isCoolingDown(account)) {
      failures.push(`${label}: cooling down`);
      continue;
    }
    try {
      return await activateAccount(account);
    } catch (error) {
      failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`No usable Antigravity account. ${failures.join("; ")}`);
}

async function activateAccount(account: AccountMetadataV3): Promise<LiveAuth> {
  const cached = tokenCache.get(account.refreshToken);
  let auth = toOAuth(account, cached);

  if (accessTokenExpired(auth)) {
    const refreshed = await refreshAccessToken(auth, dedupClient, "google");
    if (!refreshed?.access) {
      tokenCache.delete(account.refreshToken);
      throw new Error("token refresh failed (grant may be revoked — re-run login)");
    }
    auth = refreshed;
    tokenCache.set(account.refreshToken, { access: refreshed.access, expires: refreshed.expires ?? 0 });
    await persistCredentialRotation(account, refreshed);
  }

  const context = await ensureProjectContext(auth);
  await persistCredentialRotation(account, context.auth);

  if (!context.effectiveProjectId) {
    throw new Error("could not resolve a project id (loadCodeAssist/onboardUser failed)");
  }
  return { account, auth: context.auth, projectId: context.effectiveProjectId };
}

async function persistCredentialRotation(
  original: AccountMetadataV3,
  updated: OAuthAuthDetails,
): Promise<void> {
  const parts = parseRefreshParts(updated.refresh);
  const originalParts = parseRefreshParts(
    formatRefreshParts({
      refreshToken: original.refreshToken,
      projectId: original.projectId,
      managedProjectId: original.managedProjectId,
    }),
  );
  if (
    parts.refreshToken === originalParts.refreshToken &&
    parts.projectId === originalParts.projectId &&
    parts.managedProjectId === originalParts.managedProjectId
  ) {
    return;
  }
  try {
    await saveAccountCredentials(original, {
      ...original,
      refreshToken: parts.refreshToken,
      projectId: parts.projectId,
      managedProjectId: parts.managedProjectId,
      lastUsed: Date.now(),
    });
  } catch {
    // Persistence is best-effort: the in-memory auth still works for this run.
  }
}

export interface AccountSummary {
  email?: string;
  hasRefreshToken: boolean;
  projectId?: string;
  managedProjectId?: string;
  disabled: boolean;
}

export async function listAccountSummaries(): Promise<AccountSummary[]> {
  const storage = await loadAccounts();
  if (!storage) return [];
  return storage.accounts.map((account) => ({
    email: account.email,
    hasRefreshToken: Boolean(account.refreshToken),
    projectId: account.projectId,
    managedProjectId: account.managedProjectId,
    disabled: isDisabled(account),
  }));
}
