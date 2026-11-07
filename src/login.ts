/**
 * `login` command: runs the Google OAuth flow and stores the grant in the
 * same `antigravity-accounts.json` used by the opencode plugin.
 */
import {
  authorizeAntigravity,
  exchangeAntigravity,
  loadAccounts,
  parseRefreshParts,
  saveAccounts,
  startOAuthListener,
} from "./upstream";

export async function runLogin(): Promise<void> {
  const { url } = await authorizeAntigravity("");
  console.log("\nOpen this URL in your browser to sign in with Google:\n");
  console.log(url);
  console.log("\nWaiting for the OAuth callback on http://localhost:51121 ...");

  const listener = await startOAuthListener({ timeoutMs: 5 * 60 * 1000 });
  try {
    const callbackUrl = await listener.waitForCallback();
    const code = callbackUrl.searchParams.get("code");
    const state = callbackUrl.searchParams.get("state");
    if (!code || !state) {
      throw new Error("OAuth callback did not include code/state");
    }
    const result = await exchangeAntigravity(code, state);
    if (result.type !== "success") {
      throw new Error(`Token exchange failed: ${result.error}`);
    }

    const parts = parseRefreshParts(result.refresh);
    const storage = (await loadAccounts()) ?? { version: 4 as const, accounts: [], activeIndex: 0 };
    const email = result.email ?? "unknown";
    const existing = storage.accounts.findIndex((a) => a.email === email && email !== "unknown");
    const record = {
      email: result.email,
      refreshToken: parts.refreshToken,
      projectId: parts.projectId,
      managedProjectId: parts.managedProjectId,
      addedAt: Date.now(),
      lastUsed: Date.now(),
      lastSwitchReason: "initial" as const,
    };
    if (existing >= 0) {
      storage.accounts[existing] = { ...storage.accounts[existing], ...record };
      storage.activeIndex = existing;
    } else {
      storage.accounts.push(record);
      storage.activeIndex = storage.accounts.length - 1;
    }
    await saveAccounts(storage);
    console.log(`\nSigned in as ${email}. Credentials stored (${storage.accounts.length} account(s)).`);
    console.log("Start the proxy with: npm run serve");
  } finally {
    await listener.close().catch(() => undefined);
  }
}
