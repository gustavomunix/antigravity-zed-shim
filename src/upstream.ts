/**
 * Single seam over the vendored `opencode-antigravity-auth` source.
 *
 * Everything Antigravity-protocol-specific (OAuth, token refresh, project
 * context, request envelope, thinking/tool normalization) is reused from
 * `vendor/auth-src` instead of being reimplemented. If the vendor tree is
 * refreshed from upstream, only the paths below may need adjusting.
 *
 * Upstream: https://github.com/NoeFabris/opencode-antigravity-auth
 * Vendored from: labs/antigravity-opencode-auth (package version 2.1.2)
 */

export {
  ANTIGRAVITY_ENDPOINT,
  ANTIGRAVITY_DEFAULT_PROJECT_ID,
  getAntigravityUserAgent,
} from "../vendor/auth-src/constants";

export {
  authorizeAntigravity,
  exchangeAntigravity,
} from "../vendor/auth-src/antigravity/oauth";

export {
  parseRefreshParts,
  formatRefreshParts,
  accessTokenExpired,
  calculateTokenExpiry,
} from "../vendor/auth-src/plugin/auth";

export {
  refreshAccessToken,
  AntigravityTokenRefreshError,
} from "../vendor/auth-src/plugin/token";

export {
  ensureProjectContext,
  invalidateProjectContextCache,
} from "../vendor/auth-src/plugin/project";

export { prepareAntigravityRequest } from "../vendor/auth-src/plugin/request";

export { detectErrorType } from "../vendor/auth-src/plugin/recovery";

export {
  loadAccounts,
  saveAccounts,
  saveAccountCredentials,
  getStoragePath,
} from "../vendor/auth-src/plugin/storage";

export { startOAuthListener } from "../vendor/auth-src/plugin/server";

export { registerAdvertisedModelIds } from "../vendor/auth-src/plugin/transform/model-resolver";

export type {
  OAuthAuthDetails,
  PluginClient,
} from "../vendor/auth-src/plugin/types";
export type { AccountMetadataV3 } from "../vendor/auth-src/plugin/storage";
