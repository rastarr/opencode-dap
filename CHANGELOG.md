# Changelog

All notable changes to this fork of opencode-dap. Format follows [Keep a Changelog](https://keepachangelog.com/); the fork adds fixes on top of upstream `debugtalk/opencode-dap` v0.2.0.

## [0.3.4] — 2026-08-20

### Fixed

- **"When to use" trigger now actually ships** — the v0.3.3 decision trigger
  lived only in `prompts/tools/debug.md`, which is never read at runtime
  (OpenCode's plugin API takes the tool description inline; the prompts dir
  is vestigial from the OMP port) and was excluded from the package anyway
  (the `files` whitelist shipped only `src/`, `README.md`, `LICENSE`). The
  trigger is now embedded in the `debugTool` description in `src/plugin.ts`,
  the text the model actually receives, and `prompts/` is added to the
  `files` whitelist so repo and package stay consistent.

## [0.3.3] — 2026-08-20

### Changed

- **Decision trigger for `debug` in agent skills** — `prompts/tools/debug.md`
  gains a "When to use" block: prefer `debug` when the failure is
  reproducible, process-local, and the unknown is runtime state, call stack,
  or control flow — direct observation beats log/trace reconstruction; use
  logging/tracing instead for intermittent, timing/race-sensitive,
  cross-process, or production-only failures. Companion edits to
  `debug-trace-instrumentation`, `root-cause-analysis`, and
  `test-first-repair` skills make the tool the first move at their decision
  points instead of unnamed "debugger inspection".

## [0.3.2] — 2026-08-17

### Fixed

- **Telemetry output noise** — debugpy emits two telemetry output events on
  session start (`{"category": "telemetry", "output": "ptvsd"}` and
  `"debugpy"`); the handler appended every output event verbatim, so the
  captured-output buffer began with `ptvsddebugpy` before the debuggee's real
  stdout. Filter by category: keep stdout/stderr/console/important, drop
  telemetry. The useful content (debuggee stdout, traceback) is captured
  intact.

## [0.3.1] — 2026-08-17

### Fixed

- **SIGTTIN suspension** — adapters now spawn detached (`setsid`), matching
  OMP's `ptree.spawn(..., { detached: true })`. Without it the adapter and
  its debuggee children inherited the harness's controlling terminal; a
  debuggee touching `/dev/tty` triggered SIGTTIN and suspended the entire
  OpenCode process under shell job control (`zsh: suspended (tty input)`).
  Verified: a debuggee opening `/dev/tty` now gets `[Errno 6] No such
  device or address` and runs to completion.

## [0.3.0] — 2026-08-17

### Fixed

- **Plugin entry contract** — `src/index.ts` now default-exports the OpenCode
  v1 plugin module (`{ id: "opencode-dap", server }`). The previous `export *`
  barrel leaked `debugTool` as a named export, which OpenCode's plugin loader
  rejects with `Plugin export is not a function` — the plugin never registered
  in any install form (npm spec, GitHub spec, or path). The library barrel
  exports are preserved for standalone API use. Verified live against
  `opencode serve` (`/experimental/tool/ids` contains `debug`).
- **Bounded DAP writes** (ported from oh-my-pi `23cbeb49f`, issue #4233) —
  `#writeMessage` races the stdin flush against a 30 s cap and adapter exit,
  disposing the client on either failure. A wedged adapter stdin previously
  blocked `writeMessage` forever; `sendRequest` now fires the write in the
  background with a passive unhandled-rejection guard, so the caller's
  `timeoutMs` wins over a hung flush.
- **Unix-socket connect rejection and bound** (ported from oh-my-pi `3b194a3e3`,
  issue #4087) — `connectSocket` rejects on connect failure (ECONNREFUSED /
  ENOENT / EACCES, close-before-open, Bun.connect rejection) and bounds the
  connect with a timeout. A stat-ready-but-dead socket previously hung the
  launch forever.
- **Socket-spawn cleanup** (ported from oh-my-pi `23cbeb49f`) — the unix and
  TCP client-addr spawn paths now kill the adapter process when the
  readiness/connect race fails, closing an orphan-process leak on socket
  connect timeouts.
- **`runInTerminal` stdout drain** (ported from oh-my-pi `4fcab2c78`, issue
  #8111) — the reverse-request handler now drains the debuggee's stdout into
  the session output buffer, bounded at 128 KiB. Previously the unconsumed
  pipe buffered unboundedly in-process (measured ~9x RSS growth for a 200 MB
  output child) and the program's output was lost.
- **debugpy adapter uses the `debugpy-adapter` binary** instead of
  `python -m debugpy.adapter` — the module form fails on NixOS and other
  systems where `python` and the debugpy package are separate Nix store
  paths (the module is not importable from the profile interpreter even
  though `debugpy-adapter` is on `PATH`). The console-script binary is
  installed by `pip install debugpy` on every platform, so this is strictly
  more portable. Verified end-to-end on NixOS: launch → continue → output
  capture → terminate.

### Added

- Regression tests for all of the above: wedged-flush timeout (no
  unhandled rejection), connectSocket reject path, socket-spawn kill on
  timeout, `runInTerminal` drain into the session buffer, and the plugin
  entry contract (default export shape + hooks registration).
- `socketReadyTimeoutMs` test hook on `DapClient.spawn` so socket-spawn
  tests do not wait the full 10 s cap.
- README: fork notice, requirements table (OpenCode ≥ 1.18, Bun ≥ 1.3.14,
  host-provided `@opencode-ai/plugin`), GitHub-spec install, deterministic
  serve-based verification, safety documentation, `Plugin export is not a
  function` troubleshooting entry.
- CHANGELOG with fork release history and upstream provenance.

### Changed

- Version bumped to 0.3.0 (fork's first release; upstream was 0.2.0).
- Adapter table: debugpy install remains `pip install debugpy` (provides
  the `debugpy-adapter` binary).

## [0.2.0] — 2026-06-29 (upstream)

### Added

- `docs/publish.md` — publish, install, upgrade, and verify workflow
- `.npmrc` pinned to public npm registry
- `publishConfig`, `engines`, npm metadata (`author`, `repository`, etc.)

### Changed

- `@opencode-ai/plugin` upgraded to `^1.17.11`
- `package-lock.json` regenerated with public registry
- `test` script normalized, `files` field expanded

### Fixed

- README and AGENTS updated with install/upgrade/verify instructions

> **Note**: the upstream 0.2.0 plugin entry does not load in OpenCode
> (`Plugin export is not a function`). This fork fixes that — see [Unreleased].

## [0.1.0] — 2026-06-13 (upstream)

### Added

- Initial release, ported from oh-my-pi's DAP implementation
- Full DAP wire protocol client (stdio + socket)
- Session manager with launch/attach, breakpoints, step control, variable inspection, memory I/O, disassembly
- 14 bundled debug adapters covering ~18 languages
- Adapter auto-selection by file extension and project root markers
- OpenCode `debug` tool with 30 actions and session lifecycle auto-cleanup
- Non-interactive environment injection, race-condition-safe event handling, serialized breakpoint mutations
- Zero runtime dependencies (Bun + Node.js built-ins only)
