# Changelog

All notable changes to this fork of opencode-dap. Format follows [Keep a Changelog](https://keepachangelog.com/); the fork adds fixes on top of upstream `debugtalk/opencode-dap` v0.2.0.

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
