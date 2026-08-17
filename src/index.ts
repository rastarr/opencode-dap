import { opencodeDapPlugin } from "./plugin";

export * from "./client";
export * from "./config";
export * from "./plugin";
export * from "./session";
export * from "./types";

/**
 * OpenCode v1 plugin module. The loader requires a default export of
 * `{ id, server }` where `server(input)` returns the plugin hooks; without
 * it the legacy loader rejects the module because `debugTool` (re-exported
 * above) is not a plugin function ("Plugin export is not a function").
 *
 * Note: `export { opencodeDapPlugin } from "./plugin"` does not create a
 * local binding, so this must be a real import.
 */
export default {
  id: "opencode-dap",
  server: opencodeDapPlugin,
};
