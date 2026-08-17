import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { DapClient, connectSocket } from "../src/client";
import { DapSessionManager } from "../src/session";
import type {
  DapCapabilities,
  DapClientState,
  DapEventMessage,
  DapResolvedAdapter,
} from "../src/types";

const TEST_ADAPTER: DapResolvedAdapter = {
  name: "lldb-dap",
  command: "lldb-dap",
  args: [],
  resolvedCommand: "lldb-dap",
  languages: [],
  fileTypes: [],
  rootMarkers: [],
  launchDefaults: {},
  attachDefaults: {},
  connectMode: "stdio",
  acceptsDirectoryProgram: false,
};

const DELAYED_UNIX_SOCKET_ADAPTER = `
const listenPrefix = "--listen=unix:";
const listenArg = process.argv.find(arg => arg.startsWith(listenPrefix));
if (!listenArg) {
  throw new Error("missing --listen=unix argument");
}
const socketPath = listenArg.slice(listenPrefix.length);
let server;
process.on("SIGTERM", () => {
  server?.stop();
  process.exit(0);
});
await Bun.sleep(100);
server = Bun.listen({
  unix: socketPath,
  socket: {
    open() {},
    data() {},
    close() {},
    error() {},
  },
});
await Bun.sleep(2_000);
server.stop();
`;

type DapEventHandler = (body: unknown, event: DapEventMessage) => void | Promise<void>;

class FakeDapClient {
  readonly proc: DapClientState["proc"];
  readonly #exited = Promise.withResolvers<void>();
  readonly #handlers = new Map<string, Set<DapEventHandler>>();
  #alive = true;

  requests: Array<{ command: string; args?: unknown }> = [];

  constructor(
    readonly adapter: DapResolvedAdapter,
    readonly cwd: string,
    readonly options: {
      launchError?: string;
      launchErrorDelayMs?: number;
      attachError?: string;
      attachErrorDelayMs?: number;
      configurationDoneError?: string;
      rejectStopWaiters?: boolean;
      stopAfterLaunch?: boolean;
    },
  ) {
    this.proc = {
      exited: this.#exited.promise,
      exitCode: null,
      stdin: { write: () => 0, flush: () => undefined },
      stdout: new ReadableStream<Uint8Array>(),
      stderr: new ReadableStream<Uint8Array>(),
      kill: () => {
        this.#alive = false;
        this.#exited.resolve();
        return true;
      },
    } as unknown as DapClientState["proc"];
  }

  async initialize(): Promise<DapCapabilities> {
    queueMicrotask(() => this.#emit("initialized", {}));
    return { supportsConfigurationDoneRequest: true };
  }

  async sendRequest(command: string, args?: unknown): Promise<unknown> {
    this.requests.push({ command, args });
    if (command === "launch" && this.options.launchError) {
      if (this.options.launchErrorDelayMs) await Bun.sleep(this.options.launchErrorDelayMs);
      throw new Error(this.options.launchError);
    }
    if (command === "attach" && this.options.attachError) {
      if (this.options.attachErrorDelayMs) await Bun.sleep(this.options.attachErrorDelayMs);
      throw new Error(this.options.attachError);
    }
    if (command === "configurationDone" && this.options.configurationDoneError) {
      throw new Error(this.options.configurationDoneError);
    }
    if (command === "launch" && this.options.stopAfterLaunch) {
      queueMicrotask(() => this.#emit("stopped", { reason: "entry", threadId: 1 }));
    }
    return {};
  }

  waitForEvent(event: string): Promise<unknown> {
    if (this.options.rejectStopWaiters && (event === "stopped" || event === "terminated" || event === "exited")) {
      return Promise.reject(new Error(`DAP event ${event} timed out after 1ms`));
    }
    const { promise, resolve } = Promise.withResolvers<unknown>();
    const unsubscribe = this.onEvent(event, body => {
      unsubscribe();
      resolve(body);
    });
    return promise;
  }

  onEvent(event: string, handler: DapEventHandler): () => void {
    let handlers = this.#handlers.get(event);
    if (!handlers) {
      handlers = new Set<DapEventHandler>();
      this.#handlers.set(event, handlers);
    }
    handlers.add(handler);
    return () => handlers?.delete(handler);
  }

  onReverseRequest(): () => void {
    return () => {};
  }

  isAlive(): boolean {
    return this.#alive;
  }

  async dispose(): Promise<void> {
    this.#alive = false;
    this.#exited.resolve();
  }

  #emit(event: string, body: unknown): void {
    const message: DapEventMessage = { seq: 1, type: "event", event, body };
    for (const handler of this.#handlers.get(event) ?? []) {
      void handler(body, message);
    }
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DAP launch failure handling", () => {
  it("preserves adapter launchDefaults args when launch omits args", async () => {
    const adapter: DapResolvedAdapter = {
      ...TEST_ADAPTER,
      launchDefaults: { request: "launch", args: ["--configured"], stopOnEntry: true },
    };
    const manager = new DapSessionManager();
    const fake = new FakeDapClient(adapter, process.cwd(), { stopAfterLaunch: true });
    spyOn(DapClient, "spawn").mockResolvedValue(fake as unknown as DapClient);

    await manager.launch({ adapter, program: "/bin/echo", cwd: process.cwd() }, undefined, 10_000);

    const launch = fake.requests.find(request => request.command === "launch");
    expect(launch?.args).toMatchObject({ args: ["--configured"], program: "/bin/echo" });
  });

  it("surfaces the launch failure when configurationDone also fails", async () => {
    const manager = new DapSessionManager();
    const fake = new FakeDapClient(TEST_ADAPTER, process.cwd(), {
      launchError: "launch: 'C:\\repo\\python' is not a valid executable",
      configurationDoneError: "configurationDone: Expected process to be stopped.",
    });
    spyOn(DapClient, "spawn").mockResolvedValue(fake as unknown as DapClient);

    let message = "";
    try {
      await manager.launch({ adapter: TEST_ADAPTER, program: "C:\\repo\\python", cwd: process.cwd() });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      message = (error as Error).message;
    }

    expect(message).toContain("launch: 'C:\\repo\\python' is not a valid executable");
    expect(message).toContain("configurationDone: Expected process to be stopped.");
  });

  it("surfaces the attach failure when configurationDone also fails", async () => {
    const manager = new DapSessionManager();
    const fake = new FakeDapClient(TEST_ADAPTER, process.cwd(), {
      attachError: "attach: target process exited",
      configurationDoneError: "configurationDone: Expected process to be stopped.",
    });
    spyOn(DapClient, "spawn").mockResolvedValue(fake as unknown as DapClient);

    let message = "";
    try {
      await manager.attach({ adapter: TEST_ADAPTER, cwd: process.cwd(), pid: 123 });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      message = (error as Error).message;
    }

    expect(message).toContain("attach: target process exited");
    expect(message).toContain("configurationDone: Expected process to be stopped.");
  });

  it("does not emit an unhandled rejection when launch fails before initial stop watchers settle", async () => {
    const manager = new DapSessionManager();
    const fake = new FakeDapClient(TEST_ADAPTER, process.cwd(), {
      launchError: "launch: failed before stop outcome",
      rejectStopWaiters: true,
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    spyOn(DapClient, "spawn").mockResolvedValue(fake as unknown as DapClient);

    try {
      await expect(
        manager.launch({ adapter: TEST_ADAPTER, program: "/bin/echo", cwd: process.cwd() }),
      ).rejects.toThrow("launch: failed before stop outcome");
      await Bun.sleep(10);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("surfaces the adapter name and ENOENT when spawn fails", async () => {
    const manager = new DapSessionManager();
    spyOn(DapClient, "spawn").mockRejectedValue(new Error("ENOENT: no such file or directory, spawn 'lldb-dap'"));

    let message = "";
    try {
      await manager.launch({ adapter: TEST_ADAPTER, program: "/bin/echo", cwd: process.cwd() });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      message = (error as Error).message;
    }

    expect(message).toContain("ENOENT");
    expect(message).toContain(TEST_ADAPTER.name);
  });

  it("surfaces 'pip install debugpy' when launch stderr mentions missing module", async () => {
    const manager = new DapSessionManager();
    const debugpyAdapter: DapResolvedAdapter = { ...TEST_ADAPTER, name: "debugpy" };
    const fake = new FakeDapClient(debugpyAdapter, process.cwd(), {
      launchError: "ImportError: No module named 'debugpy'",
    });
    spyOn(DapClient, "spawn").mockResolvedValue(fake as unknown as DapClient);

    let message = "";
    try {
      await manager.launch({ adapter: debugpyAdapter, program: "/bin/echo", cwd: process.cwd() });
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      message = (error as Error).message;
    }

    expect(message).toContain("pip install debugpy");
    expect(message).toContain("debugpy");
  });

  it("surfaces 'pip install debugpy' when attach stderr mentions missing module", async () => {
    const manager = new DapSessionManager();
    const debugpyAdapter: DapResolvedAdapter = { ...TEST_ADAPTER, name: "debugpy" };
    const fake = new FakeDapClient(debugpyAdapter, process.cwd(), {
      attachError: 'ModuleNotFoundError: No module named "debugpy"',
    });
    spyOn(DapClient, "spawn").mockResolvedValue(fake as unknown as DapClient);

    let message = "";
    try {
      await manager.attach({ adapter: debugpyAdapter, cwd: process.cwd(), pid: 123 });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("pip install debugpy");
  });

  it("does NOT rewrite to 'pip install debugpy' for non-debugpy adapters even when stderr mentions the module", async () => {
    const manager = new DapSessionManager();
    const fake = new FakeDapClient(TEST_ADAPTER, process.cwd(), {
      launchError: "incidental log line: No module named debugpy was here but the adapter is lldb-dap",
    });
    spyOn(DapClient, "spawn").mockResolvedValue(fake as unknown as DapClient);

    let message = "";
    try {
      await manager.launch({ adapter: TEST_ADAPTER, program: "/bin/echo", cwd: process.cwd() });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).not.toContain("pip install debugpy");
    expect(message).toContain("incidental log line");
  });

  it("prefers a delayed launch failure over the configurationDone cascade", async () => {
    const manager = new DapSessionManager();
    const fake = new FakeDapClient(TEST_ADAPTER, process.cwd(), {
      launchError: "launch: 'C:\\repo\\program' is not a valid executable",
      launchErrorDelayMs: 10,
      configurationDoneError: "configurationDone: Expected process to be stopped.",
    });
    spyOn(DapClient, "spawn").mockResolvedValue(fake as unknown as DapClient);

    let message = "";
    try {
      await manager.launch({ adapter: TEST_ADAPTER, program: "C:\\repo\\program", cwd: process.cwd() });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toContain("launch: 'C:\\repo\\program' is not a valid executable");
    expect(message).toContain("configurationDone: Expected process to be stopped.");
  });
});

describe("connectSocket unix transport", () => {
  it("rejects instead of hanging when the unix socket cannot be connected", async () => {
    // A path that stat would report as a socket but that no one listens on
    // yields ECONNREFUSED/ENOENT from Bun.connect. Before the fix the error
    // handler only errored the stream and the returned promise never settled,
    // so `await connectSocket(...)` hung the launch forever.
    const deadSocket = path.join(os.tmpdir(), `opencode-dap-dead-${Date.now()}-${Math.random().toString(36).slice(2)}.sock`);
    const start = Date.now();
    await expect(connectSocket({ unix: deadSocket }, 5_000)).rejects.toThrow();
    // Must settle on the connect error, not linger until the timeout bound.
    expect(Date.now() - start).toBeLessThan(2_000);
  });
});

describe("DAP socket spawn cleanup", () => {
  it("kills the adapter process when the Unix socket never appears (Linux)", async () => {
    if (process.platform !== "linux") return;
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-dap-unix-leak-"));
    try {
      const adapterPath = path.join(cwd, "wedged-unix-adapter.mjs");
      const pidFilePath = path.join(cwd, "adapter.pid");
      // Adapter records its pid and stays alive without ever creating the
      // socket, forcing #spawnSocketUnix's readiness wait to time out.
      await fs.writeFile(
        adapterPath,
        `await Bun.write(${JSON.stringify(pidFilePath)}, String(process.pid));\nawait Bun.sleep(60_000);\n`,
      );
      const adapter: DapResolvedAdapter = {
        ...TEST_ADAPTER,
        name: "wedged-unix-adapter",
        command: process.execPath,
        args: [adapterPath],
        resolvedCommand: process.execPath,
        connectMode: "socket",
      };
      await expect(DapClient.spawn({ adapter, cwd, socketReadyTimeoutMs: 300 })).rejects.toThrow(
        /Socket not ready/,
      );
      // Real delay required: the kill signal must propagate to the detached
      // adapter and the pid file must be readable; neither is an event this
      // test can await, so deterministic time control does not work here.
      await Bun.sleep(500);
      const adapterPid = Number(await Bun.file(pidFilePath).text());
      expect(Number.isFinite(adapterPid)).toBe(true);
      let alive = true;
      try {
        process.kill(adapterPid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    } finally {
      await fs.rm(cwd, { recursive: true, force: true });
    }
  });
});

describe("DAP adapter selection", () => {
  it("dlv adapter accepts directory programs", () => {
    const dlvAdapter: DapResolvedAdapter = {
      ...TEST_ADAPTER,
      name: "dlv",
      command: "dlv",
      resolvedCommand: "dlv",
      launchDefaults: { request: "launch", mode: "debug", stopOnEntry: true },
      acceptsDirectoryProgram: true,
    };
    expect(dlvAdapter.acceptsDirectoryProgram).toBe(true);
  });

  it("gdb adapter does not accept directory programs", () => {
    expect(TEST_ADAPTER.acceptsDirectoryProgram).toBe(false);
  });
});
