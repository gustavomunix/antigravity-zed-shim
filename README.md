# antigravity-zed-shim

Local OpenAI-compatible proxy that exposes **Google Antigravity accounts
(subscription OAuth, same grant used by the Antigravity IDE / opencode
plugin) as a regular provider in Zed Agent** — model dropdown, Inline
Assistant, commit messages, thread summaries. No ACP thread, no external
agent: Zed talks to `http://127.0.0.1:8123/v1` like any OpenAI-compatible
endpoint.

How it works:

- Auth (Google OAuth, refresh, `loadCodeAssist`/`onboardUser` project
  context, request envelope, thinking/tool normalization) is **reused** from
  `opencode-antigravity-auth`, vendored under `vendor/auth-src`
  (see `vendor/PATCHES.md` — one typecheck-only line).
- The shim translates OpenAI Chat Completions ⇄ Antigravity `v1internal`:
  `POST /v1/chat/completions` (streaming SSE and JSON), `GET /v1/models`,
  `GET /health`.

## Prerequisites

- Node.js ≥ 20 (macOS, Linux, or Windows).
- A Google account with Antigravity access.


## Setup

```sh
cd antigravity-zed-shim
npm install # also fetches pinned upstream constants.ts (see vendor/PATCHES.md)

# 1. Sign in with Google (opens the browser, stores the grant in
#    ~/.config/opencode/antigravity-accounts.json — the same file the
#    opencode plugin uses; skip if you already ran `opencode auth login`).
npm run login

# 2. Start the proxy (default port 8123).
npm run serve

# 3. In another terminal, print a settings.json snippet with your live models.
npm run models
```

Paste the snippet into Zed's `settings.json` (`zed: open settings file` →
`Ctrl-O` or command palette → `zed: open settings`), merging the
`language_models.openai_compatible.antigravity` block.

Then tell Zed the API key. The shim ignores it (short-lived Bearer tokens
are minted per request from your stored OAuth grant), but Zed requires a
non-empty key for `openai_compatible` providers. Either:

- open Agent Settings (`agent: open settings`), find the `antigravity`
  provider, and paste any dummy value; or
- set the env var before launching Zed (provider id `antigravity` →
  `ANTIGRAVITY_API_KEY=dummy`).

Pick an `Antigravity …` model in the Agent Panel model dropdown. Done —
Zed Agent, Inline Assistant and friends now run on your Antigravity quota.

## Commands

| Command           | What it does                                              |
| ----------------- | --------------------------------------------------------- |
| `npm run serve`   | Build + start the proxy on `127.0.0.1:8123` (`--port N`)  |
| `npm run login`   | Google OAuth sign-in, stores the grant locally            |
| `npm run models`  | Print `settings.json` snippet with live model ids        |
| `npm run self-test` | Offline translator unit checks (no network)             |
| `npm run typecheck` | `tsc --noEmit`                                          |

`GET /health` returns `{status, accounts, emails}` for diagnostics.

## Multi-account / quota notes

- The shim tries accounts in stored order starting at `activeIndex`,
  skipping disabled or cooling-down accounts, and persists rotated refresh
  tokens and newly resolved `managedProjectId`s back to the accounts file.
- There is no quota-aware routing: if an account hits rate limits mid-run
  you get a `429` with the upstream message. Re-running picks the next
  usable account on the next request.
- Very long multi-turn tool sessions on `*-thinking` models can hit
  `thinking_block_order` errors; the shim retries once with forced recovery
  (same strategy as the upstream plugin). If it still fails, start a fresh
  thread — exactly like upstream behavior.

## Refreshing the vendored auth source

```sh
# from the workspace root, re-copy and re-apply vendor/PATCHES.md
```

Then `npm run build && npm run self-test`. The seam is `src/upstream.ts` —
the only file that imports from `vendor/`.
