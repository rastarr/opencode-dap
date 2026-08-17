import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import { DapClient } from "../src/client";
import { DapSessionManager } from "../src/session";
import { TEST_ADAPTER } from "./helpers";
import type {
  DapCapabilities,
  DapClientState,
  DapEventMessage,
  DapResolvedAdapter,
} from "../src/types";

type DapEventHandler = (body: unknown, event: DapEventMessage) => void | Promise<void>;

class FakeDapClient {
  readonly proc: DapClientState["proc"];
  readonly exited = Promise.withResolvers<void>();
  readonly #handlers = new Map<string, Set<DapEventHandler>>();
  readonly #reverseHandlers = new Map<string, (args: unknown) => unknown | Promise<unknown>>();
  #alive = true;
  #capabilities: DapCapabilities = { supportsConfigurationDoneRequest: true };

  requests: Array<{ command: string; args?: unknown }> = [];

  constructor(
    readonly adapter: DapResolvedAdapter,
    readonly cwd: string,
    readonly options: {
      stopAfterLaunch?: boolean;
      launchError?: string;
    } = {},
  ) {
    this.proc = {
      exited: this.exited.promise,
      exitCode: null,
      stdin: { write: () => 0, flush: () => undefined },
      stdout: new ReadableStream<Uint8Array>(),
      stderr: new ReadableStream<Uint8Array>(),
      kill: () => {
        this.#alive = false;
        this.exited.resolve();
        return true;
      },
    } as unknown as DapClientState["proc"];
  }

  async initialize(): Promise<DapCapabilities> {
    queueMicrotask(() => this.#emit("initialized", {}));
    return this.#capabilities;
  }

  async sendRequest(command: string, args?: unknown): Promise<unknown> {
    this.requests.push({ command, args });

    if (command === "launch" && this.options.launchError) {
      throw new Error(this.options.launchError);
    }
    if (command === "setBreakpoints") {
      const bpArgs = args as { source?: { path?: string }; breakpoints?: Array<{ line: number }> };
      const bps = (bpArgs.breakpoints ?? []).map((bp) => ({
        id: bp.line,
        verified: true,
        line: bp.line,
      }));
      return { breakpoints: bps };
    }
    if (command === "setFunctionBreakpoints") {
      const fbArgs = args as { breakpoints?: Array<{ name: string }> };
      const bps = (fbArgs.breakpoints ?? []).map((fb, i) => ({
        id: i + 1,
        verified: true,
      }));
      return { breakpoints: bps };
    }
    if (command === "launch" && this.options.stopAfterLaunch) {
      queueMicrotask(() => this.#emit("stopped", { reason: "entry", threadId: 1, allThreadsStopped: true }));
    }
    if (command === "configurationDone") {
      queueMicrotask(() => this.#emit("stopped", { reason: "breakpoint", threadId: 1 }));
    }
    if (command === "continue") {
      queueMicrotask(() => this.#emit("stopped", { reason: "breakpoint", threadId: 1 }));
    }
    if (command === "stackTrace") {
      return {
        stackFrames: [
          { id: 1, name: "main", line: 10, column: 1, source: { path: "main.py" } },
        ],
      };
    }
    if (command === "scopes") {
      return { scopes: [{ name: "Locals", variablesReference: 100, expensive: false }] };
    }
    if (command === "variables") {
      return {
        variables: [
          { name: "x", value: "42", type: "int", variablesReference: 0 },
          { name: "msg", value: '"hello"', type: "str", variablesReference: 0 },
        ],
      };
    }
    if (command === "evaluate") {
      return { result: "42", type: "int", variablesReference: 0 };
    }
    if (command === "threads") {
      return { threads: [{ id: 1, name: "MainThread" }] };
    }
    return {};
  }

  async waitForEvent(event: string): Promise<unknown> {
    const { promise, resolve } = Promise.withResolvers<unknown>();
    const unsubscribe = this.onEvent(event, (body) => {
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
    return () => { handlers?.delete(handler); };
  }

  onReverseRequest(command: string, handler: (args: unknown) => unknown | Promise<unknown>): () => void {
    this.#reverseHandlers.set(command, handler);
    return () => {
      this.#reverseHandlers.delete(command);
    };
  }

  async triggerReverse(command: string, args: unknown): Promise<unknown> {
    const handler = this.#reverseHandlers.get(command);
    if (!handler) throw new Error(`no reverse-request handler for ${command}`);
    return handler(args);
  }

  emitOutput(category: string, output: string): void {
    this.#emit("output", { category, output });
  }

  isAlive(): boolean {
    return this.#alive;
  }

  async dispose(): Promise<void> {
    this.#alive = false;
    this.exited.resolve();
  }

  get capabilities(): DapCapabilities {
    return this.#capabilities;
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

describe("DAP session lifecycle", () => {
  it("launches a session and returns a summary", async () => {
    const manager = new DapSessionManager();
    const fake = new FakeDapClient(TEST_ADAPTER, "/tmp", { stopAfterLaunch: true });
    spyOn(DapClient, "spawn").mockResolvedValue(fake as unknown as DapClient);

    const snapshot = await manager.launch({
      adapter: TEST_ADAPTER,
      program: "/tmp/main.py",
      cwd: "/tmp",
    });

    expect(snapshot.status).toBe("stopped");
    expect(snapshot.adapter).toBe("test-adapter");
  });

  it("terminates a session and updates status", async () => {
    const manager = new DapSessionManager();
    const fake = new FakeDapClient(TEST_ADAPTER, "/tmp", { stopAfterLaunch: true });
    spyOn(DapClient, "spawn").mockResolvedValue(fake as unknown as DapClient);

    await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/main.py", cwd: "/tmp" });
    const snapshot = await manager.terminate();

    expect(snapshot).not.toBeNull();
    expect(snapshot!.status).toBe("terminated");
  });

  it("tracks session history across launches", async () => {
    const manager = new DapSessionManager();
    spyOn(DapClient, "spawn").mockImplementation(async () => {
      const fake = new FakeDapClient(TEST_ADAPTER, "/tmp", { stopAfterLaunch: true });
      return fake as unknown as DapClient;
    });

    await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/a.py", cwd: "/tmp" });
    await manager.terminate();

    await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/b.py", cwd: "/tmp" });

    const sessions = manager.listSessions();
    expect(sessions.length).toBeGreaterThanOrEqual(1);
  });

  it("getActiveSession returns null when no session", () => {
    const manager = new DapSessionManager();
    expect(manager.getActiveSession()).toBeNull();
  });
});

describe("DAP breakpoint management", () => {
  it("sets a file breakpoint and returns verified breakpoints", async () => {
    const manager = new DapSessionManager();
    const fake = new FakeDapClient(TEST_ADAPTER, "/tmp", { stopAfterLaunch: true });
    spyOn(DapClient, "spawn").mockResolvedValue(fake as unknown as DapClient);

    await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/main.py", cwd: "/tmp" });

    const result = await manager.setBreakpoint("/tmp/main.py", 10);
    expect(result.breakpoints).toHaveLength(1);
    expect(result.breakpoints[0].verified).toBe(true);
    expect(result.breakpoints[0].line).toBe(10);
  });

  it("removes a breakpoint and updates count", async () => {
    const manager = new DapSessionManager();
    const fake = new FakeDapClient(TEST_ADAPTER, "/tmp", { stopAfterLaunch: true });
    spyOn(DapClient, "spawn").mockResolvedValue(fake as unknown as DapClient);

    await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/main.py", cwd: "/tmp" });
    await manager.setBreakpoint("/tmp/main.py", 10);

    const removeResult = await manager.removeBreakpoint("/tmp/main.py", 10);
    expect(removeResult.breakpoints).toHaveLength(0);
  });

  it("sets a function breakpoint", async () => {
    const manager = new DapSessionManager();
    const fake = new FakeDapClient(TEST_ADAPTER, "/tmp", { stopAfterLaunch: true });
    spyOn(DapClient, "spawn").mockResolvedValue(fake as unknown as DapClient);

    await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/main.py", cwd: "/tmp" });

    const result = await manager.setFunctionBreakpoint("main");
    expect(result.breakpoints).toHaveLength(1);
    expect(result.breakpoints[0].verified).toBe(true);
  });

  it("reports breakpoint counts in session summary", async () => {
    const manager = new DapSessionManager();
    const fake = new FakeDapClient(TEST_ADAPTER, "/tmp", { stopAfterLaunch: true });
    spyOn(DapClient, "spawn").mockResolvedValue(fake as unknown as DapClient);

    await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/main.py", cwd: "/tmp" });
    await manager.setBreakpoint("/tmp/a.py", 10);
    await manager.setBreakpoint("/tmp/a.py", 20);
    await manager.setBreakpoint("/tmp/b.py", 5);

    const active = manager.getActiveSession();
    expect(active?.breakpointCount).toBe(3);
    expect(active?.breakpointFiles).toBe(2);
  });
});

describe("DAP execution control", () => {
  it("continues from stopped state", async () => {
    const manager = new DapSessionManager();
    const fake = new FakeDapClient(TEST_ADAPTER, "/tmp", { stopAfterLaunch: true });
    spyOn(DapClient, "spawn").mockResolvedValue(fake as unknown as DapClient);

    await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/main.py", cwd: "/tmp" });

    const outcome = await manager.continue();
    expect(outcome.state).toBe("stopped");
  });

  it("session stays active after continue from stopped", async () => {
    const manager = new DapSessionManager();
    const fake = new FakeDapClient(TEST_ADAPTER, "/tmp", { stopAfterLaunch: true });
    spyOn(DapClient, "spawn").mockResolvedValue(fake as unknown as DapClient);

    await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/main.py", cwd: "/tmp" });
    await manager.continue();

    // after continue, the FakeDapClient re-emits stopped
    const snapshot = manager.getActiveSession();
    expect(snapshot).not.toBeNull();
  });
});

describe("DAP state inspection", () => {
  it("gets stack trace at a breakpoint", async () => {
    const manager = new DapSessionManager();
    const fake = new FakeDapClient(TEST_ADAPTER, "/tmp", { stopAfterLaunch: true });
    spyOn(DapClient, "spawn").mockResolvedValue(fake as unknown as DapClient);

    await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/main.py", cwd: "/tmp" });

    const result = await manager.stackTrace(undefined);
    expect(result.stackFrames).toHaveLength(1);
    expect(result.stackFrames[0].name).toBe("main");
  });

  it("inspects local variables", async () => {
    const manager = new DapSessionManager();
    const fake = new FakeDapClient(TEST_ADAPTER, "/tmp", { stopAfterLaunch: true });
    spyOn(DapClient, "spawn").mockResolvedValue(fake as unknown as DapClient);

    await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/main.py", cwd: "/tmp" });

    const varResult = await manager.variables(100);
    expect(varResult.variables).toHaveLength(2);
    expect(varResult.variables[0].name).toBe("x");
    expect(varResult.variables[0].value).toBe("42");
  });

  it("evaluates an expression", async () => {
    const manager = new DapSessionManager();
    const fake = new FakeDapClient(TEST_ADAPTER, "/tmp", { stopAfterLaunch: true });
    spyOn(DapClient, "spawn").mockResolvedValue(fake as unknown as DapClient);

    await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/main.py", cwd: "/tmp" });

    const evalResult = await manager.evaluate("x + 1", "repl", undefined);
    expect(evalResult.evaluation.result).toBe("42");
  });

  it("lists threads", async () => {
    const manager = new DapSessionManager();
    const fake = new FakeDapClient(TEST_ADAPTER, "/tmp", { stopAfterLaunch: true });
    spyOn(DapClient, "spawn").mockResolvedValue(fake as unknown as DapClient);

    await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/main.py", cwd: "/tmp" });

    const threadResult = await manager.threads();
    expect(threadResult.threads).toHaveLength(1);
    expect(threadResult.threads[0].name).toBe("MainThread");
  });
});

describe("DAP output capture", () => {
  it("drops telemetry output events but keeps debuggee stdout", async () => {
    const manager = new DapSessionManager();
    const fake = new FakeDapClient(TEST_ADAPTER, "/tmp", { stopAfterLaunch: true });
    spyOn(DapClient, "spawn").mockResolvedValue(fake as unknown as DapClient);

    await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/main.py", cwd: "/tmp" });

    // debugpy emits telemetry markers ("ptvsd"/"debugpy") on session start;
    // they must not pollute the captured output buffer.
    fake.emitOutput("telemetry", "ptvsd");
    fake.emitOutput("telemetry", "debugpy");
    fake.emitOutput("stdout", "result: {'alice': 125.0}\n");

    const output = manager.getOutput().output;
    expect(output).not.toContain("ptvsd");
    expect(output).not.toContain("debugpy");
    expect(output).toContain("result: {'alice': 125.0}");

    await manager.terminate(undefined, 1_000);
  });
});

describe("DAP runInTerminal stdout drain", () => {  it("drains a runInTerminal debuggee's stdout into the session output buffer", async () => {
    const manager = new DapSessionManager();
    const fake = new FakeDapClient(TEST_ADAPTER, "/tmp", { stopAfterLaunch: true });
    spyOn(DapClient, "spawn").mockResolvedValue(fake as unknown as DapClient);

    await manager.launch({ adapter: TEST_ADAPTER, program: "/tmp/main.py", cwd: "/tmp" });

    // Synthetic debuggee stdout: >64KB ahead of a unique terminal marker,
    // then a trailing sentinel and EOF. The handler discards the Bun child
    // after reading its PID, so the drain must consume this whole stream and
    // route it to the session output — undrained, the marker never reaches
    // the buffer. The sentinel after the marker guarantees the marker chunk
    // is routed (in the read cycle before it) before `closed` resolves.
    const marker = "__RUNINTERMINAL_MARKER__";
    const enc = new TextEncoder();
    const chunks = [enc.encode("x".repeat(128 * 1024)), enc.encode(`${marker}\n`), enc.encode("tail\n")];
    let next = 0;
    const closed = Promise.withResolvers<void>();
    const stdout = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (next < chunks.length) {
          controller.enqueue(chunks[next++]);
        } else {
          controller.close();
          closed.resolve();
        }
      },
    });
    const spawnSpy = spyOn(Bun, "spawn").mockReturnValue({
      pid: 4242,
      stdout,
      exited: Promise.resolve(0),
    } as unknown as Bun.Subprocess<"pipe">);

    await fake.triggerReverse("runInTerminal", { args: ["/usr/bin/debuggee", "--verbose"] });
    // The stream reaching EOF proves the drain consumed it end to end; the
    // marker (routed before close) is then present in the session output.
    await closed.promise;

    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(spawnSpy.mock.calls[0]?.[0]).toEqual(["/usr/bin/debuggee", "--verbose"]);
    expect(manager.getOutput().output).toContain(marker);

    await manager.terminate(undefined, 1_000);
  });
});
