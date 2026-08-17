# Changelog

## [Unreleased]

### Fixed

- Plugin entry contract: `src/index.ts` now default-exports the OpenCode v1
  plugin module (`{ id, server }`). The previous `export *` barrel leaked
  `debugTool` as a named export, which the OpenCode plugin loader rejects
  with "Plugin export is not a function" — the plugin never registered.
  Verified live against `opencode serve` (`/experimental/tool/ids` contains
  `debug`).

## [0.2.0] — 2026-06-29

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

## [0.1.0] — 2026-06-13

### Added

- Initial release, ported from oh-my-pi's DAP implementation
- Full DAP wire protocol client (stdio + socket)
- Session manager with launch/attach, breakpoints, step control, variable inspection, memory I/O, disassembly
- 14 bundled debug adapters covering ~18 languages
- Adapter auto-selection by file extension and project root markers
- OpenCode `debug` tool with 30 actions and session lifecycle auto-cleanup
- Non-interactive environment injection, race-condition-safe event handling, serialized breakpoint mutations
- Zero runtime dependencies (Bun + Node.js built-ins only)
