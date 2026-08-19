import * as path from "node:path";
import * as fs from "node:fs/promises";
import type { Plugin, PluginInput } from "@opencode-ai/plugin";
import { tool } from "@opencode-ai/plugin";
import { DapSessionManager } from "./session";
import {
  selectLaunchAdapter,
  selectAttachAdapter,
  resolveLaunchOverrides,
  getAvailableAdapters,
} from "./config";
import type { LaunchProgramKind } from "./config";
import type {
  DapBreakpointRecord,
  DapContinueOutcome,
  DapDataBreakpointInfoResponse,
  DapDataBreakpointRecord,
  DapDisassembledInstruction,
  DapEvaluateResponse,
  DapFunctionBreakpointRecord,
  DapInstructionBreakpointRecord,
  DapModule,
  DapResolvedAdapter,
  DapScope,
  DapSessionSummary,
  DapSource,
  DapStackFrame,
  DapThread,
  DapVariable,
} from "./types";

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

let _manager: DapSessionManager | null = null;

function getManager(): DapSessionManager {
  if (!_manager) {
    _manager = new DapSessionManager();
  }
  return _manager;
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

function resolveToCwd(target: string, cwd: string): string {
  if (path.isAbsolute(target)) return target;
  return path.resolve(cwd, target);
}

function formatPathRelativeToCwd(target: string, cwd: string): string {
  const rel = path.relative(cwd, target);
  if (!rel.startsWith("..") && !path.isAbsolute(rel)) return rel;
  return target;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type ProgramKind = LaunchProgramKind;

function isEnoent(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function classifyLaunchProgram(program: string): Promise<ProgramKind> {
  try {
    const stat = await fs.stat(program);
    if (stat.isDirectory()) return "directory";
    return "file";
  } catch (error) {
    if (isEnoent(error)) return "missing";
    throw error;
  }
}

async function validateLaunchProgram(
  program: string,
  cwd: string,
  kind: ProgramKind,
  adapter: DapResolvedAdapter,
): Promise<void> {
  if (kind === "missing") {
    throw new Error(`Launch program not found: ${path.resolve(cwd, program)}`);
  }
  if (kind === "directory" && !adapter.acceptsDirectoryProgram) {
    const displayPath = formatPathRelativeToCwd(program, cwd);
    throw new Error(
      `launch program resolves to a directory: ${displayPath}. ` +
        `Pass an executable file path, or for Python use adapter "debugpy" with program set to the .py file.`,
    );
  }
}

function getConfiguredAdapters(cwd: string): string {
  const available = getAvailableAdapters(cwd);
  return available.map((a) => a.name).join(", ") || "none";
}

function resolveDisassemblyReference(memoryReference: string | undefined): string {
  const session = getManager().getActiveSession();
  return memoryReference ?? session?.instructionPointerReference ?? "";
}

function requireCapability(capability: string, label: string): void {
  const capabilities = getManager().getCapabilities();
  if (!capabilities || !(capabilities as Record<string, unknown>)[capability]) {
    throw new Error(`This debug adapter does not support ${label}.`);
  }
}

// ---------------------------------------------------------------------------
// Timeout clamping
// ---------------------------------------------------------------------------

const DEBUG_TIMEOUT_MIN = 5;
const DEBUG_TIMEOUT_MAX = 300;
const DEBUG_TIMEOUT_DEFAULT = 30;

function clampTimeout(seconds: unknown): number {
  const n = typeof seconds === "number" ? seconds : Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return DEBUG_TIMEOUT_DEFAULT;
  return Math.max(DEBUG_TIMEOUT_MIN, Math.min(DEBUG_TIMEOUT_MAX, n));
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatSessionSnapshot(snapshot: DapSessionSummary): string[] {
  const lines = [`Adapter: ${snapshot.adapter}`, `Status: ${snapshot.status}`];
  if (snapshot.program) lines.push(`Program: ${snapshot.program}`);
  if (snapshot.status === "stopped") {
    if (snapshot.stopReason)
      lines.push(
        `Stop reason: ${snapshot.stopReason}${snapshot.stopDescription ? ` (${snapshot.stopDescription})` : ""}`,
      );
    if (snapshot.frameName) {
      const loc = [snapshot.frameName];
      if (snapshot.source?.path) {
        loc.push(snapshot.source.path);
        if (snapshot.line) loc.push(String(snapshot.line));
      }
      lines.push(`Stopped at: ${loc.join(":")}`);
    }
  } else if (snapshot.status === "running") {
    lines.push("Program is running.");
  } else if (snapshot.status === "terminated") {
    if (snapshot.exitCode !== undefined) lines.push(`Exit code: ${snapshot.exitCode}`);
  }
  if (snapshot.breakpointCount > 0) {
    lines.push(`Breakpoints: ${snapshot.breakpointCount} in ${snapshot.breakpointFiles} files`);
  }
  return lines;
}

function formatBreakpoints(sourcePath: string, bps: DapBreakpointRecord[]): string {
  const lines = [`Breakpoints in ${path.basename(sourcePath)}:`];
  if (bps.length === 0) {
    lines.push("  (none)");
  } else {
    for (const bp of bps) {
      const status = bp.verified ? "✓" : "✗";
      const detail = [status, `L${bp.line}`];
      if (bp.condition) detail.push(`if ${bp.condition}`);
      lines.push(`  ${detail.join(" ")}`);
      if (!bp.verified && bp.message) lines.push(`    ${bp.message}`);
    }
  }
  return lines.join("\n");
}

function formatFunctionBreakpoints(bps: DapFunctionBreakpointRecord[]): string {
  const lines = ["Function breakpoints:"];
  if (bps.length === 0) {
    lines.push("  (none)");
  } else {
    for (const bp of bps) {
      const status = bp.verified ? "✓" : "✗";
      const detail = [status, bp.name];
      if (bp.condition) detail.push(`if ${bp.condition}`);
      lines.push(`  ${detail.join(" ")}`);
    }
  }
  return lines.join("\n");
}

function formatInstructionBreakpoints(bps: DapInstructionBreakpointRecord[]): string {
  const lines = ["Instruction breakpoints:"];
  if (bps.length === 0) {
    lines.push("  (none)");
  } else {
    for (const bp of bps) {
      const status = bp.verified ? "✓" : "✗";
      lines.push(
        `  ${status} ${bp.instructionReference}${bp.offset !== undefined ? `+${bp.offset}` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

function formatDataBreakpoints(bps: DapDataBreakpointRecord[]): string {
  const lines = ["Data breakpoints:"];
  if (bps.length === 0) {
    lines.push("  (none)");
  } else {
    for (const bp of bps) {
      const status = bp.verified ? "✓" : "✗";
      lines.push(`  ${status} ${bp.dataId}${bp.accessType ? ` (${bp.accessType})` : ""}`);
    }
  }
  return lines.join("\n");
}

function formatDataBreakpointInfo(info: DapDataBreakpointInfoResponse): string {
  const lines = [
    `Data ID: ${info.dataId ?? "(not supported)"}`,
    `Description: ${info.description}`,
  ];
  if (info.accessTypes) lines.push(`Access types: ${info.accessTypes.join(", ")}`);
  return lines.join("\n");
}

function formatThreads(threads: DapThread[]): string {
  if (threads.length === 0) return "(no threads)";
  return threads.map((t) => `  #${t.id} ${t.name}`).join("\n");
}

function formatStackFrames(frames: DapStackFrame[]): string {
  if (frames.length === 0) return "(no stack frames)";
  return frames
    .map((f, i) => {
      const src = f.source
        ? f.source.path
          ? `${path.basename(f.source.path)}:${f.line}`
          : (f.source.name ?? "")
        : "";
      return `  #${i} ${f.name}${src ? ` — ${src}` : ""}`;
    })
    .join("\n");
}

function formatScopes(scopes: DapScope[]): string {
  if (scopes.length === 0) return "(no scopes)";
  return scopes
    .map((s) => `  ${s.name} (ref: ${s.variablesReference}, expensive: ${s.expensive})`)
    .join("\n");
}

function formatVariables(vars: DapVariable[]): string {
  if (vars.length === 0) return "(no variables)";
  return vars
    .map((v) => `  ${v.name} = ${v.value}${v.type ? ` (${v.type})` : ""}`)
    .join("\n");
}

function formatEvaluation(evalResp: DapEvaluateResponse): string {
  const lines = [evalResp.result];
  if (evalResp.type) lines.push(`Type: ${evalResp.type}`);
  return lines.join("\n");
}

function formatDisassembly(instructions: DapDisassembledInstruction[]): string {
  if (instructions.length === 0) return "(no instructions)";
  return instructions
    .map((i) => `  ${i.address}: ${i.instruction}${i.symbol ? ` ; ${i.symbol}` : ""}`)
    .join("\n");
}

function formatMemoryRead(
  address: string,
  data: string | undefined,
  unreadableBytes: number | undefined,
): string {
  const lines = [`Address: ${address}`];
  if (unreadableBytes !== undefined && unreadableBytes > 0) {
    lines.push(`Unreadable bytes: ${unreadableBytes}`);
  }
  if (data) lines.push(`Data: ${data}`);
  return lines.join("\n");
}

function formatModules(modules: DapModule[]): string {
  if (modules.length === 0) return "(no modules)";
  return modules.map((m) => `  ${m.name} (${m.id})`).join("\n");
}

function formatLoadedSources(sources: DapSource[]): string {
  if (sources.length === 0) return "(no sources)";
  return sources.map((s) => `  ${s.path ?? s.name ?? "(unnamed)"}`).join("\n");
}

function formatCustomResponse(command: string, body: unknown): string {
  return JSON.stringify({ command, body }, null, 2);
}

function buildOutcomeText(
  outcome: DapContinueOutcome,
  timeoutSec: number,
  label: string,
): string {
  const parts = [`${label} result: ${outcome.state}`];
  if (outcome.timedOut) {
    parts.push(`(timed out after ${timeoutSec}s)`);
  }
  parts.push(...formatSessionSnapshot(outcome.snapshot));
  return parts.join("\n");
}

function formatSessions(sessions: DapSessionSummary[]): string {
  if (sessions.length === 0) return "No debug sessions.";
  return sessions
    .map(
      (s) =>
        `  [${s.id}] ${s.adapter} - ${s.status}${s.program ? ` - ${s.program}` : ""}`,
    )
    .join("\n");
}

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

const debugTool = tool({
  description: `Debug a program using the Debug Adapter Protocol (DAP).

When to use: reach for this tool when the failure is reproducible, process-local, and the unknown is runtime state, call stack, or control flow — it observes directly with zero code changes, and direct observation outweighs log/trace reconstruction. Prefer it over adding instrumentation or guessing from logs. Use logging/tracing instead when the failure is intermittent, timing- or race-sensitive, spans processes, or is production-only.

Supports 14 debug adapters: gdb, lldb-dap, codelldb, debugpy (Python), dlv (Go),
js-debug-adapter (JS/TS), netcoredbg (C#), kotlin-debug-adapter, rdbg (Ruby),
php-debug-adapter, bash-debug-adapter, dart-debug-adapter, flutter-debug-adapter,
elixir-ls-debugger.

Actions:
  launch, attach        - Start a debug session
  set_breakpoint, remove_breakpoint  - Source breakpoints (file+line) or function breakpoints
  continue, step_over, step_in, step_out, pause - Execution control
  evaluate              - Evaluate an expression in the debugged context
  stack_trace, threads, scopes, variables  - Program state inspection
  output                - Read captured stdout/stderr
  terminate             - End a debug session
  sessions              - List debug sessions

Read-only actions (safe): output, threads, stack_trace, scopes, variables, sessions, loaded_sources, modules, disassemble, read_memory
Execution actions (take care): launch, attach, set_breakpoint, remove_breakpoint, continue, step_over, step_in, step_out, pause, evaluate, terminate, write_memory, custom_request`,

  args: {
    action: tool.schema
      .enum([
        "launch",
        "attach",
        "set_breakpoint",
        "remove_breakpoint",
        "continue",
        "step_over",
        "step_in",
        "step_out",
        "pause",
        "evaluate",
        "stack_trace",
        "threads",
        "scopes",
        "variables",
        "output",
        "terminate",
        "sessions",
        "loaded_sources",
        "modules",
        "disassemble",
        "read_memory",
        "write_memory",
        "set_instruction_breakpoint",
        "remove_instruction_breakpoint",
        "data_breakpoint_info",
        "set_data_breakpoint",
        "remove_data_breakpoint",
        "set_function_breakpoint",
        "remove_function_breakpoint",
        "custom_request",
      ] as const)
      .describe("The debug action to perform"),
    program: tool.schema.string().optional().describe("Path to program or script to debug (for launch)"),
    args: tool.schema.array(tool.schema.string()).optional().describe("Command-line arguments to pass to the debugged program"),
    cwd: tool.schema.string().optional().describe("Working directory for the debug session (defaults to project root)"),
    adapter: tool.schema.string().optional().describe("Debug adapter name (auto-selected if omitted)"),
    pid: tool.schema.number().optional().describe("Process ID to attach to"),
    port: tool.schema.number().optional().describe("Port to attach to"),
    host: tool.schema.string().optional().describe("Host for TCP attach (default: localhost)"),
    file: tool.schema.string().optional().describe("Source file path for file-based breakpoints"),
    line: tool.schema.number().optional().describe("Line number for file-based breakpoints"),
    function: tool.schema.string().optional().describe("Function name for function breakpoints"),
    condition: tool.schema.string().optional().describe("Conditional expression for breakpoints"),
    expression: tool.schema.string().optional().describe("Expression to evaluate in debug context"),
    context: tool.schema.string().optional().describe("Evaluation context: watch, repl, hover, clipboard, variables"),
    frame_id: tool.schema.number().optional().describe("Stack frame ID for scoped operations"),
    levels: tool.schema.number().optional().describe("Number of stack frames to fetch"),
    variable_ref: tool.schema.number().optional().describe("Variable reference for child variables"),
    scope_id: tool.schema.number().optional().describe("Scope reference for variables"),
    instruction_reference: tool.schema.string().optional().describe("Instruction pointer reference"),
    offset: tool.schema.number().optional().describe("Byte offset for memory/instruction operations"),
    instruction_offset: tool.schema.number().optional().describe("Instruction offset for disassembly"),
    instruction_count: tool.schema.number().optional().describe("Number of instructions to disassemble"),
    resolve_symbols: tool.schema.boolean().optional().describe("Resolve symbols in disassembly"),
    memory_reference: tool.schema.string().optional().describe("Memory reference for read/write"),
    count: tool.schema.number().optional().describe("Byte count for memory read"),
    data: tool.schema.string().optional().describe("Data to write (base64 for memory, string for expressions)"),
    allow_partial: tool.schema.boolean().optional().describe("Allow partial memory writes"),
    name: tool.schema.string().optional().describe("Variable name for data breakpoint info"),
    data_id: tool.schema.string().optional().describe("Data ID for data breakpoints"),
    access_type: tool.schema
      .enum(["read", "write", "readWrite"] as const)
      .optional()
      .describe("Access type for data breakpoints"),
    hit_condition: tool.schema.string().optional().describe("Hit condition for breakpoints"),
    start_module: tool.schema.number().optional().describe("Start module index"),
    module_count: tool.schema.number().optional().describe("Number of modules to fetch"),
    command: tool.schema.string().optional().describe("Custom DAP command name"),
    arguments: tool.schema.record(tool.schema.string(), tool.schema.unknown()).optional().describe("Custom DAP command arguments"),
    timeout: tool.schema.number().optional().default(30).describe("Timeout in seconds (default: 30)"),
  },

  async execute(args, ctx) {
    const mgr = getManager();
    const timeout = clampTimeout(args.timeout);
    const timeoutMs = timeout * 1000;
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const cwd = typeof args.cwd === "string" && args.cwd
      ? resolveToCwd(args.cwd, ctx.directory)
      : ctx.directory;

    switch (args.action) {
      // ── Session management ──────────────────────────────
      case "launch": {
        if (typeof args.program !== "string" || !args.program) {
          throw new Error("'program' is required for launch. Provide the path to the program or script.");
        }
        const program = resolveToCwd(args.program, cwd);
        const programKind = await classifyLaunchProgram(program);
        const adapter = selectLaunchAdapter(
          program,
          cwd,
          typeof args.adapter === "string" ? args.adapter : undefined,
          programKind,
        );
        if (!adapter) {
          if (args.adapter === "debugpy") {
            throw new Error("Adapter 'debugpy' is not available. Install it with: pip install debugpy");
          }
          throw new Error(
            `No debug adapter available for this program. Installed: ${getConfiguredAdapters(cwd)}. ` +
              `Install a debug adapter or specify one explicitly with 'adapter'.`,
          );
        }
        await validateLaunchProgram(program, cwd, programKind, adapter);
        const extraLaunchArgs = resolveLaunchOverrides(adapter, program, programKind);
        const programArgs = Array.isArray(args.args) ? (args.args as string[]) : undefined;
        const snapshot = await mgr.launch(
          { adapter, program, args: programArgs, cwd, extraLaunchArguments: extraLaunchArgs },
          timeoutSignal,
          timeoutMs,
        );
        return formatSessionSnapshot(snapshot).join("\n");
      }
      case "attach": {
        const pid = typeof args.pid === "number" ? args.pid : undefined;
        const port = typeof args.port === "number" ? args.port : undefined;
        if (pid === undefined && port === undefined) {
          throw new Error("'pid' or 'port' is required for attach.");
        }
        const adapter = selectAttachAdapter(
          cwd,
          typeof args.adapter === "string" ? args.adapter : undefined,
          port,
        );
        if (!adapter) {
          throw new Error(`No debug adapter available. Installed: ${getConfiguredAdapters(cwd)}`);
        }
        const host = typeof args.host === "string" ? args.host : undefined;
        const snapshot = await mgr.attach({ adapter, cwd, pid, port, host }, timeoutSignal, timeoutMs);
        return formatSessionSnapshot(snapshot).join("\n");
      }
      case "terminate": {
        const snapshot = await mgr.terminate(timeoutSignal, timeoutMs);
        if (!snapshot) return "No debug session to terminate.";
        return [...formatSessionSnapshot(snapshot), "Debug session terminated."].join("\n");
      }
      case "sessions": {
        const sessions = mgr.listSessions();
        return formatSessions(sessions);
      }
      case "output": {
        const { snapshot, output } = mgr.getOutput();
        const header = formatSessionSnapshot(snapshot).join("\n");
        return output.length > 0 ? `${header}\n--- output ---\n${output}` : `${header}\n(no output captured)`;
      }

      // ── Breakpoints ─────────────────────────────────────
      case "set_breakpoint": {
        if (typeof args.function === "string" && args.function) {
          const result = await mgr.setFunctionBreakpoint(
            args.function,
            typeof args.condition === "string" ? args.condition : undefined,
            timeoutSignal,
            timeoutMs,
          );
          return formatFunctionBreakpoints(result.breakpoints);
        }
        if (typeof args.file !== "string" || typeof args.line !== "number") {
          throw new Error(
            "'file' and 'line' are required for file breakpoints (or use 'function' for function breakpoints).",
          );
        }
        const breakpointFile = resolveToCwd(args.file, cwd);
        const result = await mgr.setBreakpoint(
          breakpointFile,
          args.line,
          typeof args.condition === "string" ? args.condition : undefined,
          timeoutSignal,
          timeoutMs,
        );
        return formatBreakpoints(result.sourcePath, result.breakpoints);
      }
      case "remove_breakpoint": {
        if (typeof args.function === "string" && args.function) {
          const result = await mgr.removeFunctionBreakpoint(args.function, timeoutSignal, timeoutMs);
          return formatFunctionBreakpoints(result.breakpoints);
        }
        if (typeof args.file !== "string" || typeof args.line !== "number") {
          throw new Error(
            "'file' and 'line' are required for file breakpoints (or use 'function' for function breakpoints).",
          );
        }
        const removeBreakpointFile = resolveToCwd(args.file, cwd);
        const result = await mgr.removeBreakpoint(removeBreakpointFile, args.line, timeoutSignal, timeoutMs);
        return formatBreakpoints(result.sourcePath, result.breakpoints);
      }
      case "set_function_breakpoint": {
        if (typeof args.function !== "string" || !args.function) {
          throw new Error("'function' is required.");
        }
        const result = await mgr.setFunctionBreakpoint(
          args.function,
          typeof args.condition === "string" ? args.condition : undefined,
          timeoutSignal,
          timeoutMs,
        );
        return formatFunctionBreakpoints(result.breakpoints);
      }
      case "remove_function_breakpoint": {
        if (typeof args.function !== "string" || !args.function) {
          throw new Error("'function' is required.");
        }
        const result = await mgr.removeFunctionBreakpoint(args.function, timeoutSignal, timeoutMs);
        return formatFunctionBreakpoints(result.breakpoints);
      }
      case "set_instruction_breakpoint": {
        requireCapability("supportsInstructionBreakpoints", "instruction breakpoints");
        if (typeof args.instruction_reference !== "string" || !args.instruction_reference) {
          throw new Error("'instruction_reference' is required.");
        }
        const result = await mgr.setInstructionBreakpoint(
          args.instruction_reference,
          typeof args.offset === "number" ? args.offset : undefined,
          typeof args.condition === "string" ? args.condition : undefined,
          typeof args.hit_condition === "string" ? args.hit_condition : undefined,
          timeoutSignal,
          timeoutMs,
        );
        return formatInstructionBreakpoints(result.breakpoints);
      }
      case "remove_instruction_breakpoint": {
        requireCapability("supportsInstructionBreakpoints", "instruction breakpoints");
        if (typeof args.instruction_reference !== "string" || !args.instruction_reference) {
          throw new Error("'instruction_reference' is required.");
        }
        const result = await mgr.removeInstructionBreakpoint(
          args.instruction_reference,
          typeof args.offset === "number" ? args.offset : undefined,
          undefined,
          timeoutMs,
        );
        return formatInstructionBreakpoints(result.breakpoints);
      }
      case "data_breakpoint_info": {
        requireCapability("supportsDataBreakpoints", "data breakpoints");
        if (typeof args.name !== "string" || !args.name) {
          throw new Error("'name' is required.");
        }
        const result = await mgr.dataBreakpointInfo(
          args.name,
          typeof args.variable_ref === "number" ? args.variable_ref : undefined,
          typeof args.frame_id === "number" ? args.frame_id : undefined,
          timeoutSignal,
          timeoutMs,
        );
        return formatDataBreakpointInfo(result.info);
      }
      case "set_data_breakpoint": {
        requireCapability("supportsDataBreakpoints", "data breakpoints");
        if (typeof args.data_id !== "string" || !args.data_id) {
          throw new Error("'data_id' is required.");
        }
        const result = await mgr.setDataBreakpoint(
          args.data_id,
          args.access_type,
          typeof args.condition === "string" ? args.condition : undefined,
          typeof args.hit_condition === "string" ? args.hit_condition : undefined,
          timeoutSignal,
          timeoutMs,
        );
        return formatDataBreakpoints(result.breakpoints);
      }
      case "remove_data_breakpoint": {
        requireCapability("supportsDataBreakpoints", "data breakpoints");
        if (typeof args.data_id !== "string" || !args.data_id) {
          throw new Error("'data_id' is required.");
        }
        const result = await mgr.removeDataBreakpoint(args.data_id, timeoutSignal, timeoutMs);
        return formatDataBreakpoints(result.breakpoints);
      }

      // ── Execution control ───────────────────────────────
      case "continue": {
        const outcome = await mgr.continue(timeoutSignal, timeoutMs);
        return buildOutcomeText(outcome, timeout, "Continue");
      }
      case "step_over": {
        const outcome = await mgr.stepOver(timeoutSignal, timeoutMs);
        return buildOutcomeText(outcome, timeout, "Step over");
      }
      case "step_in": {
        const outcome = await mgr.stepIn(timeoutSignal, timeoutMs);
        return buildOutcomeText(outcome, timeout, "Step in");
      }
      case "step_out": {
        const outcome = await mgr.stepOut(timeoutSignal, timeoutMs);
        return buildOutcomeText(outcome, timeout, "Step out");
      }
      case "pause": {
        const snapshot = await mgr.pause(timeoutSignal, timeoutMs);
        return [...formatSessionSnapshot(snapshot), "Program paused."].join("\n");
      }

      // ── State inspection ────────────────────────────────
      case "evaluate": {
        if (typeof args.expression !== "string" || !args.expression) {
          throw new Error("'expression' is required for evaluate.");
        }
        const evalCtx = args.context ?? "repl";
        const result = await mgr.evaluate(
          args.expression,
          evalCtx as "watch" | "repl" | "hover" | "clipboard" | "variables",
          typeof args.frame_id === "number" ? args.frame_id : undefined,
          timeoutSignal,
          timeoutMs,
        );
        return formatEvaluation(result.evaluation);
      }
      case "stack_trace": {
        const result = await mgr.stackTrace(
          typeof args.levels === "number" ? args.levels : undefined,
          timeoutSignal,
          timeoutMs,
        );
        const header = formatSessionSnapshot(result.snapshot).join("\n");
        return `${header}\n${formatStackFrames(result.stackFrames)}`;
      }
      case "threads": {
        const result = await mgr.threads(timeoutSignal, timeoutMs);
        return formatThreads(result.threads);
      }
      case "scopes": {
        const result = await mgr.scopes(
          typeof args.frame_id === "number" ? args.frame_id : undefined,
          timeoutSignal,
          timeoutMs,
        );
        return formatScopes(result.scopes);
      }
      case "variables": {
        const variableRef =
          typeof args.variable_ref === "number"
            ? args.variable_ref
            : typeof args.scope_id === "number"
              ? args.scope_id
              : undefined;
        if (variableRef === undefined) {
          throw new Error("'variable_ref' or 'scope_id' is required for variables.");
        }
        const result = await mgr.variables(variableRef, timeoutSignal, timeoutMs);
        return formatVariables(result.variables);
      }

      // ── Memory & disassembly ────────────────────────────
      case "disassemble": {
        requireCapability("supportsDisassembleRequest", "disassembly");
        if (typeof args.instruction_count !== "number") {
          throw new Error("'instruction_count' is required for disassemble.");
        }
        const result = await mgr.disassemble(
          resolveDisassemblyReference(
            typeof args.memory_reference === "string" ? args.memory_reference : undefined,
          ),
          args.instruction_count,
          typeof args.offset === "number" ? args.offset : undefined,
          typeof args.instruction_offset === "number" ? args.instruction_offset : undefined,
          args.resolve_symbols,
          timeoutSignal,
          timeoutMs,
        );
        return formatDisassembly(result.instructions);
      }
      case "read_memory": {
        requireCapability("supportsReadMemoryRequest", "memory reads");
        if (typeof args.memory_reference !== "string" || !args.memory_reference) {
          throw new Error("'memory_reference' is required.");
        }
        if (typeof args.count !== "number") {
          throw new Error("'count' is required for read_memory.");
        }
        const result = await mgr.readMemory(
          args.memory_reference,
          args.count,
          typeof args.offset === "number" ? args.offset : undefined,
          timeoutSignal,
          timeoutMs,
        );
        return formatMemoryRead(result.address, result.data, result.unreadableBytes);
      }
      case "write_memory": {
        requireCapability("supportsWriteMemoryRequest", "memory writes");
        if (typeof args.memory_reference !== "string" || !args.memory_reference) {
          throw new Error("'memory_reference' is required.");
        }
        if (typeof args.data !== "string") {
          throw new Error("'data' is required for write_memory.");
        }
        const result = await mgr.writeMemory(
          args.memory_reference,
          args.data,
          typeof args.offset === "number" ? args.offset : undefined,
          args.allow_partial,
          timeoutSignal,
          timeoutMs,
        );
        return [
          "Memory write completed.",
          ...(result.bytesWritten !== undefined ? [`Bytes written: ${result.bytesWritten}`] : []),
          ...(result.offset !== undefined ? [`Offset: ${result.offset}`] : []),
        ].join("\n");
      }

      // ── Introspection ───────────────────────────────────
      case "modules": {
        requireCapability("supportsModulesRequest", "module introspection");
        const result = await mgr.modules(
          typeof args.start_module === "number" ? args.start_module : undefined,
          typeof args.module_count === "number" ? args.module_count : undefined,
          timeoutSignal,
          timeoutMs,
        );
        return formatModules(result.modules);
      }
      case "loaded_sources": {
        requireCapability("supportsLoadedSourcesRequest", "loaded sources");
        const result = await mgr.loadedSources(timeoutSignal, timeoutMs);
        return formatLoadedSources(result.sources);
      }
      case "custom_request": {
        if (typeof args.command !== "string" || !args.command) {
          throw new Error("'command' is required for custom_request.");
        }
        const customArgs = args.arguments as Record<string, unknown> | undefined;
        const result = await mgr.customRequest(args.command, customArgs, timeoutSignal, timeoutMs);
        return formatCustomResponse(args.command, result.body);
      }

      default:
        throw new Error(`Unsupported debug action: ${args.action}`);
    }
  },
});

// ---------------------------------------------------------------------------
// Plugin export
// ---------------------------------------------------------------------------

export { debugTool };

export const opencodeDapPlugin: Plugin = async (_input: PluginInput) => {
  return {
    tool: {
      debug: debugTool,
    },
    event: async ({ event }) => {
      if (event?.type === "session.idle" || event?.type === "session.deleted") {
        try {
          await getManager().terminate(undefined, 5_000);
        } catch {
          // best-effort cleanup
        }
      }
    },
  };
};
