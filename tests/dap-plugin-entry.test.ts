import { describe, expect, it } from "bun:test";
import pluginModule, { debugTool } from "../src/index";

// Test-case exception to the static-import rule: this suite intentionally
// exercises the module-loading boundary (default export shape) the OpenCode
// loader relies on, so the module must be re-imported the way the loader does.
const mod = await import("../src/index");

describe("OpenCode plugin entry contract", () => {
  it("default-exports the v1 plugin module the OpenCode loader requires", () => {
    const plugin = mod.default as { id?: unknown; server?: unknown } | undefined;

    expect(plugin).toBeDefined();
    // `id` is mandatory for file-source installs (resolvePluginId throws
    // without it); npm installs fall back to package.json name.
    expect(typeof plugin?.id).toBe("string");
    // `server(input) => Promise<Hooks>`; the legacy loader would otherwise
    // reject the module because `debugTool` is not a plugin function.
    expect(typeof plugin?.server).toBe("function");
  });

  it("server() returns hooks registering the debug tool", async () => {
    const plugin = mod.default as {
      server: (input: unknown) => Promise<{ tool?: Record<string, unknown> }>;
    };

    const hooks = await plugin.server({});
    const debug = hooks.tool?.debug as { execute?: unknown } | undefined;
    expect(debug).toBeDefined();
    expect(typeof debug?.execute).toBe("function");
  });

  it("keeps the library barrel exports for standalone API use", () => {
    expect(typeof debugTool).toBe("object");
    expect(typeof (debugTool as { execute?: unknown }).execute).toBe("function");
  });
});
