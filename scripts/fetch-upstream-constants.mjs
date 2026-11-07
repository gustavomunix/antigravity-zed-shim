/**
 * Fetches `vendor/auth-src/constants.ts` from upstream at install time.
 *
 * Why: the file embeds the Antigravity OAuth client ID/secret (a public,
 * non-confidential installed-app credential published in the upstream repo),
 * which trips GitHub push protection, so it cannot live in git. Everything
 * else under `vendor/` is committed verbatim.
 *
 * The download is pinned to the exact upstream commit the vendor tree was
 * copied from, keeping the tree coherent. Re-run with `npm run sync-vendor`
 * (same as postinstall).
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const UPSTREAM_COMMIT = "05e600ad6c780a429e7c23d2b0202d2e81e8ff7f"; // v2.1.2
const UPSTREAM_URL = `https://raw.githubusercontent.com/NoeFabris/opencode-antigravity-auth/${UPSTREAM_COMMIT}/src/constants.ts`;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const target = join(root, "vendor", "auth-src", "constants.ts");

const response = await fetch(UPSTREAM_URL);
if (!response.ok) {
  throw new Error(`Failed to fetch upstream constants.ts: ${response.status} ${response.statusText}`);
}
const text = await response.text();
if (!text.includes("ANTIGRAVITY_CLIENT_ID") || !text.includes("ANTIGRAVITY_ENDPOINT")) {
  throw new Error("Downloaded constants.ts failed sanity check (unexpected content)");
}
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, text, "utf-8");
console.log(`vendor/auth-src/constants.ts synced from upstream @ ${UPSTREAM_COMMIT.slice(0, 12)}`);
