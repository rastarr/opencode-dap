# opencode-dap

DAP (Debug Adapter Protocol) client for OpenCode — ported from [oh-my-pi](https://github.com/can1357/oh-my-pi)'s DAP subsystem, with upstream robustness fixes and a working OpenCode plugin entry.

Lets AI coding agents debug programs via the Debug Adapter Protocol — supports 14 debug adapters covering ~18 languages. Drop it into OpenCode with a single `plugin` entry or use it as a standalone Bun/Node library.

> **Fork notice**: this is a maintained fork of [debugtalk/opencode-dap](https://github.com/debugtalk/opencode-dap) (dormant upstream). It adds:
>
> - **Plugin entry fix** — the upstream package never loads in OpenCode: its entry module exports a tool object, which OpenCode's plugin loader rejects with `Plugin export is not a function`. This fork default-exports the v1 plugin module (`{ id, server }`) the loader requires.
> - **OMP robustness fixes** — ported from upstream oh-my-pi commits: bounded DAP writes (no infinite hang on a wedged adapter stdin), unix-socket connect rejection/bound (no infinite hang or leaked adapter on a dead socket), and `runInTerminal` stdout draining (no unbounded memory growth from a chatty debuggee).
>
> See [CHANGELOG.md](CHANGELOG.md) for the full history.

## Requirements

| Requirement | Version | Notes |
|---|---|---|
| OpenCode | ≥ 1.18 (any version whose loader accepts v1 plugin modules — the contract has been stable since 2026-03) | The `debug` tool registers through the standard plugin system |
| Bun | ≥ 1.3.14 | Runtime for the plugin code and the standalone library |
| `@opencode-ai/plugin` | peer dependency — provided by the OpenCode host | Do not install a conflicting version into your project |

The package itself ships **zero runtime dependencies**; it relies on Bun built-ins and the plugin SDK the OpenCode host injects.

## Install

### From this fork (recommended)

Add to `opencode.json` (project) or `~/.config/opencode/opencode.json` (global):

```json
{
  "plugin": ["rastarr/opencode-dap"]
}
```

The GitHub-style spec makes OpenCode resolve and install the package from this repository. Restart OpenCode — the `debug` tool is available with 30+ actions.

### Local tarball / path

```bash
npm pack            # produces debugtalk-opencode-dap-0.2.0.tgz
```

Then point `opencode.json` at the packed directory (or a checkout):

```json
{
  "plugin": ["/path/to/opencode-dap"]
}
```

### Standalone library

```bash
npm install rastarr/opencode-dap
```

The installed package keeps its npm name, so import from `@debugtalk/opencode-dap` (resolved from this fork, not the upstream npm registry):

```ts
import { DapSessionManager, selectLaunchAdapter } from "@debugtalk/opencode-dap";
```

> Note: do **not** install the upstream `@debugtalk/opencode-dap` npm package — its plugin entry is broken and it does not contain the fixes in this fork.

### Install debug adapters

```bash
pip install debugpy          # Python
brew install llvm            # macOS: C/C++/Rust/Swift (lldb-dap)
go install github.com/go-delve/delve/cmd/dlv@latest  # Go
npm install -g @vscode/js-debug      # JavaScript / TypeScript
npm install -g @vscode/bash-debug    # Bash / Shell
```

## Verify

### 1. The plugin loads (no `Plugin export is not a function`)

```bash
opencode serve --port 4599 &
curl -s http://127.0.0.1:4599/experimental/tool/ids | grep debug
```

`debug` present in the JSON array means the plugin registered. This is the same deterministic check used to validate this fork (it does not depend on a model invoking the tool).

### 2. The tool works end-to-end

In an OpenCode session, run `debug action=sessions` to confirm the tool is registered, then launch a program:

```
debug action=launch program=src/main.py adapter=debugpy
debug action=continue
debug action=output
debug action=terminate
```

Debug sessions are automatically cleaned up on session idle/deleted.

## Standalone API

For use outside OpenCode or when building custom integrations:

```ts
import { DapSessionManager, selectLaunchAdapter } from "opencode-dap";

const cwd = process.cwd();
const adapter = selectLaunchAdapter("src/main.py", cwd);
if (!adapter) throw new Error("No debug adapter available");

const mgr = new DapSessionManager();

// Launch
const snapshot = await mgr.launch({ adapter, program: "src/main.py", cwd });
console.log("Status:", snapshot.status);

// Set breakpoint
const bp = await mgr.setBreakpoint("src/main.py", 10);

// Continue
const outcome = await mgr.continue();

// Evaluate when stopped
const result = await mgr.evaluate("myVar", "repl", undefined);
console.log("myVar =", result.evaluation.result);

// Terminate
await mgr.terminate();
```

To build a custom tool, import `DapSessionManager`, `selectLaunchAdapter`, etc. from the library. See [src/plugin.ts](src/plugin.ts) for the reference implementation.

## Supported Adapters

| Adapter | Languages | Command | Install |
|---|---|---|---|
| `gdb` | C, C++, Rust | `gdb -i dap` | system package |
| `lldb-dap` | C, C++, ObjC, Swift, Rust, Zig | `lldb-dap` | `brew install llvm` (macOS), `apt install lldb` |
| `codelldb` | C, C++, Rust, Zig | `codelldb` | VS Code extension |
| `debugpy` | Python | `python -m debugpy.adapter` | `pip install debugpy` |
| `dlv` | Go | `dlv dap` | `go install github.com/go-delve/delve/cmd/dlv@latest` |
| `js-debug-adapter` | JavaScript, TypeScript | `js-debug-adapter` | `npm install -g @vscode/js-debug` |
| `netcoredbg` | C#, F# | `netcoredbg --interpreter=vscode` | [GitHub](https://github.com/Samsung/netcoredbg) |
| `kotlin-debug-adapter` | Kotlin | `kotlin-debug-adapter` | [GitHub](https://github.com/fwcd/kotlin-debug-adapter) |
| `rdbg` | Ruby | `rdbg --open --command --` | `gem install debug` |
| `php-debug-adapter` | PHP | `php-debug-adapter` | VS Code extension |
| `bash-debug-adapter` | Bash/Shell | `bash-debug-adapter` | `npm install -g @vscode/bash-debug` |
| `dart-debug-adapter` | Dart | `dart debug_adapter` | Dart SDK |
| `flutter-debug-adapter` | Dart (Flutter) | `dart debug_adapter` | Flutter SDK |
| `elixir-ls-debugger` | Elixir | `elixir-ls-debugger` | [GitHub](https://github.com/elixir-lsp/elixir-ls) |

**Adapter auto-selection** works by file extension and project root markers. For example, `.py` files → `debugpy`, `.go` files → `dlv`, `Cargo.toml` → `lldb-dap` or `gdb`.

## API Reference

### `DapSessionManager`

Stateful orchestrator. Holds a single active session at a time.

| Method | Description |
|---|---|
| `launch(options, signal?, timeoutMs?)` | Start a debug session. Returns `DapSessionSummary`. |
| `attach(options, signal?, timeoutMs?)` | Attach to a running process. Returns `DapSessionSummary`. |
| `terminate(signal?, timeoutMs?)` | Terminate the active session. Returns `DapSessionSummary \| null`. |
| `getActiveSession()` | Get summary of the active session, or `null`. |
| `listSessions()` | List all session summaries. |
| `getCapabilities()` | Get adapter capabilities, or `null`. |

**Execution control:**

| Method | Description |
|---|---|
| `continue(signal?, timeoutMs?)` | Continue execution. Returns `DapContinueOutcome` with state. |
| `pause(signal?, timeoutMs?)` | Pause execution. |
| `stepIn(signal?, timeoutMs?)` | Step into. Returns `DapContinueOutcome`. |
| `stepOut(signal?, timeoutMs?)` | Step out. Returns `DapContinueOutcome`. |
| `stepOver(signal?, timeoutMs?)` | Step over (next). Returns `DapContinueOutcome`. |

**Breakpoints:**

| Method | Description |
|---|---|
| `setBreakpoint(file, line, condition?, signal?, timeoutMs?)` | Set a source breakpoint. |
| `removeBreakpoint(file, line, signal?, timeoutMs?)` | Remove a source breakpoint. |
| `setFunctionBreakpoint(name, condition?, signal?, timeoutMs?)` | Set a function breakpoint. |
| `removeFunctionBreakpoint(name, signal?, timeoutMs?)` | Remove a function breakpoint. |
| `setInstructionBreakpoint(instructionReference, offset?, condition?, hitCondition?, signal?, timeoutMs?)` | Set an instruction breakpoint. |
| `removeInstructionBreakpoint(instructionReference, offset?, signal?, timeoutMs?)` | Remove an instruction breakpoint. |
| `dataBreakpointInfo(name, variablesReference?, frameId?, signal?, timeoutMs?)` | Get data breakpoint info for a variable. |
| `setDataBreakpoint(dataId, accessType?, condition?, hitCondition?, signal?, timeoutMs?)` | Set a data breakpoint. |
| `removeDataBreakpoint(dataId, signal?, timeoutMs?)` | Remove a data breakpoint. |

**State inspection:**

| Method | Description |
|---|---|
| `stackTrace(frameCount?, signal?, timeoutMs?)` | Get stack frames. |
| `scopes(frameId?, signal?, timeoutMs?)` | Get scopes for a frame. |
| `variables(variablesReference, signal?, timeoutMs?)` | Get variables in a scope. |
| `evaluate(expression, context, frameId?, signal?, timeoutMs?)` | Evaluate an expression. |
| `threads(signal?, timeoutMs?)` | List threads. |
| `getOutput(limitBytes?)` | Get captured stdout/stderr. |

**Memory & introspection:**

| Method | Description |
|---|---|
| `disassemble(memoryReference, instructionCount, offset?, instructionOffset?, resolveSymbols?, signal?, timeoutMs?)` | Disassemble instructions. |
| `readMemory(memoryReference, count, offset?, signal?, timeoutMs?)` | Read memory. |
| `writeMemory(memoryReference, data, offset?, allowPartial?, signal?, timeoutMs?)` | Write memory. |
| `modules(startModule?, moduleCount?, signal?, timeoutMs?)` | List modules. |
| `loadedSources(signal?, timeoutMs?)` | List loaded sources. |
| `customRequest(command, args?, signal?, timeoutMs?)` | Send an arbitrary DAP request. |

### Adapter Resolution

| Function | Description |
|---|---|
| `getAvailableAdapters(cwd)` | List all adapters resolvable from `$PATH` or local bins. |
| `resolveAdapter(adapterName, cwd)` | Resolve a specific adapter by name. |
| `selectLaunchAdapter(program, cwd, adapterName?, programKind?)` | Auto-select the best adapter for a program. |
| `selectAttachAdapter(cwd, adapterName?, port?)` | Auto-select the best adapter for attach. |
| `resolveLaunchOverrides(adapter, program, programKind)` | Get adapter-specific launch arguments (e.g., dlv mode). |
| `getAdapterConfigs()` | Get the raw adapter config map from the bundled catalog. |

### Key Types

| Type | Description |
|---|---|
| `DapSessionSummary` | Snapshot of session state (status, stop location, breakpoint counts, output stats). |
| `DapContinueOutcome` | Result of continue/step: `{ snapshot, state, timedOut }`. |
| `DapResolvedAdapter` | Adapter with resolved binary path, file types, root markers. |
| `DapCapabilities` | Adapter-reported capabilities (what features it supports). |
| `DapClient` | Low-level DAP wire protocol client. Direct use is rare; prefer `DapSessionManager`. |

## How It Works

```
┌─────────────────────────────────────────────────────┐
│ opencode plugin (opencode.json)                     │
│   "plugin": ["rastarr/opencode-dap"]                │
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│ DapSessionManager (singleton)                       │
│   session lifecycle, breakpoint serialization,      │
│   step/continue orchestration, event handling       │
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│ DapClient (per-session)                             │
│   Content-Length framing, request/response matching,│
│   async event dispatch, reverse request handling    │
└──────────────────┬──────────────────────────────────┘
                   │  stdio pipe or Unix/TCP socket
┌──────────────────▼──────────────────────────────────┐
│ Debug Adapter (external process)                    │
│   debugpy, dlv, lldb-dap, gdb, js-debug-adapter ... │
└─────────────────────────────────────────────────────┘
```

### Wire Protocol

The DAP client implements the full [Debug Adapter Protocol](https://microsoft.github.io/debug-adapter-protocol/) framing:

```
Content-Length: {byteCount}\r\n
\r\n
{JSON body}
```

Messages are typed as `request`, `response`, or `event`. Requests are matched to responses by `seq`/`request_seq`. Events are dispatched to registered handlers.

### Connection Modes

- **stdio** (default): Spawn adapter as child process, communicate via stdin/stdout.
- **socket**: For adapters that use network sockets (e.g., `dlv` on Unix domain sockets on Linux, TCP on macOS).

### Safety

- **Non-interactive environment**: All debugger child processes inherit `TERM=dumb`, disabled pagers, and CI flags to prevent SIGTTIN.
- **Request timeout**: Every DAP request times out at 30s by default.
- **Bounded writes**: Adapter writes are raced against a 30s cap and adapter exit — a wedged adapter stdin cannot hang the client forever, and the client disposes itself on failure.
- **Socket connect hardening**: Unix-socket connects reject on failure (ECONNREFUSED/ENOENT/EACCES) and are bounded; adapter processes are killed when the socket never appears, so nothing leaks.
- **Bounded debuggee output**: `runInTerminal` child stdout is drained into a 128 KiB session buffer — no unbounded memory growth, and the program's output is surfaced to the agent.
- **Breakpoint serialization**: Concurrent breakpoint mutations are queued to prevent `setBreakpoints` from silently overwriting each other.
- **Race-condition safety**: Event subscriptions are registered before sending commands that trigger them.

## Troubleshooting

### "Plugin export is not a function"

You are loading the upstream `@debugtalk/opencode-dap` package (or an old checkout). Its entry module leaks a tool object, which OpenCode's plugin loader rejects. Install this fork instead (see [Install](#install)); the loader error means the plugin did not register.

### "No debug adapter available for this program"

Install the appropriate adapter for your language (see the [Supported Adapters](#supported-adapters) table). You can check which adapters are available on your system:

```ts
import { getAvailableAdapters } from "@debugtalk/opencode-dap";
console.log(getAvailableAdapters(process.cwd()).map(a => a.name));
```

### "Failed to launch debug adapter"

Common causes:
- Adapter binary not in `$PATH` or project-local bin directory.
- Python virtual environment not activated — the resolver checks `.venv/bin/`, `venv/bin/`, and `.env/bin/` for Python projects.
- Missing runtime (e.g., `python` not found when using `debugpy`).

### "Time out" during launch/attach

Some adapters are slow to initialize. Increase the timeout:

```ts
await mgr.launch(options, undefined, 60_000); // 60 seconds
```

### "Not a tty" or hung processes

The package sets non-interactive environment variables automatically (`TERM=dumb`, disabled pagers). If your adapter still hangs, ensure it doesn't try to read from `/dev/tty`.

### "Adapter exited unexpectedly"

Check stderr from the adapter process. Common causes:
- Missing dependencies (e.g., `debugpy` not installed: `pip install debugpy`).
- Wrong architecture (e.g., 64-bit adapter on 32-bit binary).
- Permission issues when attaching to a process.
