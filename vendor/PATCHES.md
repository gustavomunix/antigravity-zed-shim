# Vendor patches

`vendor/auth-src` is a verbatim copy of `labs/antigravity-opencode-auth/src`
(package version 2.1.2), except for the patches listed below. To refresh the
vendor tree, re-copy `src/` and re-apply these patches.

## Notable exclusion: `plugin/../constants.ts`

`vendor/auth-src/constants.ts` is **not committed**. It embeds the
Antigravity OAuth client ID/secret — public, non-confidential installed-app
credentials published in the upstream repo, but flagged by GitHub push
protection, so they cannot live in git.

The file is fetched at install time (`postinstall` →
`scripts/fetch-upstream-constants.mjs`) from the pinned upstream commit
`05e600a` (v2.1.2), i.e. the exact commit the vendor tree was copied from.
`npm install` therefore requires network access beyond the registry.
Deleting the file and running `npm run sync-vendor` restores it.

## P1 — `plugin/recovery.ts`

Upstream line (in `cancelSession`):

```ts
// @ts-expect-error - SDK types may not include tool_result parts
```

Patched to:

```ts
// @ts-ignore - SDK types may not include tool_result parts (patched for shim typecheck; see vendor/PATCHES.md)
```

Reason: the shim typechecks against minimal ambient `@opencode-ai/plugin`
types (`src/shims/opencode-ai-plugin.d.ts`) instead of the real SDK, under
which the call below typechecks fine and `@ts-expect-error` would be an
"unused directive" error. `@ts-ignore` suppresses under both type systems,
so runtime behavior is unchanged in either case.
