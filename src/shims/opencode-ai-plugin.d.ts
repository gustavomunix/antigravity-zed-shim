/**
 * Minimal ambient types for `@opencode-ai/plugin`.
 *
 * The vendored code only uses `PluginInput` as a *type* (via `import type`),
 * so this package never resolves the real module at runtime (tsx erases
 * type-only imports). These declarations exist solely so `tsc --noEmit`
 * can check the vendored files that reference it.
 *
 * Method signatures are intentionally strict (`never[]` args) so that the
 * upstream `@ts-expect-error` directives keep working as written.
 */
declare module "@opencode-ai/plugin" {
  type AnyMethod = (...args: any[]) => Promise<unknown>;
  export interface PluginInput {
    client: {
      app: { log: AnyMethod };
      auth: { set: AnyMethod };
      tui: { showToast: AnyMethod };
      session: {
        prompt: AnyMethod;
        abort: AnyMethod;
        messages: AnyMethod;
      };
    };
  }
}
