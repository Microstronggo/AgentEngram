import { AgentEngramAdminService, type AdminLocationOptions } from "./runtime/admin-service.js";
import type { DurableJobStatus } from "./runtime/durable-job-runtime.js";
import { AGENTENGRAM_VERSION } from "./version.js";

/** Injectable output boundary used by CLI system tests and embedders. */
export interface AdminCliIO {
  readonly stdout: (line: string) => void;
  readonly stderr: (line: string) => void;
}

/** Executes one `agentengram` admin command and returns a process-style status. */
export async function runAdminCli(argv: readonly string[], io: AdminCliIO = consoleIO()): Promise<number> {
  try {
    const parsed = parseArguments(argv);
    if (parsed.help || !parsed.command) {
      io.stdout(helpText());
      return 0;
    }
    const service = new AgentEngramAdminService(parsed.location);
    switch (parsed.command) {
      case "version":
        io.stdout(AGENTENGRAM_VERSION);
        return 0;
      case "config-print":
        io.stdout(JSON.stringify(await service.effectiveConfig(), null, 2));
        return 0;
      case "setup": {
        if (!parsed.adapter) throw new Error("setup requires pi or codex");
        io.stdout(JSON.stringify(await service.setupAdapter(parsed.adapter, { dryRun: parsed.dryRun, force: parsed.force }), null, 2));
        return 0;
      }
      case "doctor": {
        const checks = await service.doctor(parsed.adapter);
        io.stdout(JSON.stringify({ ok: !checks.some(({ status }) => status === "error"), checks }, null, 2));
        return checks.some(({ status }) => status === "error") ? 1 : 0;
      }
      case "inspect":
        io.stdout(JSON.stringify(await service.inspect(), null, 2));
        return 0;
      case "migrate":
        io.stdout(JSON.stringify(await service.migrate(parsed.dryRun), null, 2));
        return 0;
      case "init": {
        if (!parsed.adapter) throw new Error("init requires pi or codex");
        io.stdout(JSON.stringify(await service.initializeAdapter(parsed.adapter, { dryRun: parsed.dryRun, force: parsed.force }), null, 2));
        return 0;
      }
      case "jobs-list":
        io.stdout(JSON.stringify(await service.listJobs(parsed.status), null, 2));
        return 0;
      case "jobs-retry": {
        if (!parsed.jobId) throw new Error("jobs retry requires a job id");
        const retried = await service.retryJob(parsed.jobId);
        io.stdout(JSON.stringify({ jobId: parsed.jobId, retried }, null, 2));
        return retried ? 0 : 2;
      }
      case "transcript-verify": {
        const verification = await service.verifyTranscripts(parsed.sessionId);
        io.stdout(JSON.stringify({ valid: verification.every(({ valid }) => valid), sessions: verification }, null, 2));
        return verification.every(({ valid }) => valid) ? 0 : 2;
      }
      case "transcript-repair": {
        const verification = await service.repairTranscripts(parsed.sessionId);
        io.stdout(JSON.stringify({ valid: verification.every(({ valid }) => valid), sessions: verification }, null, 2));
        return verification.every(({ valid }) => valid) ? 0 : 2;
      }
      case "index-rebuild":
        io.stdout(JSON.stringify({ rebuiltRecords: await service.rebuildMemoryIndex() }, null, 2));
        return 0;
      case "bindings-list":
        io.stdout(JSON.stringify(await service.listHostBindings(), null, 2));
        return 0;
      case "bindings-rebind":
        io.stdout(JSON.stringify(await service.rebindHost({
          hostType: requiredParsed(parsed.hostType, "--host-type"),
          hostProjectId: requiredParsed(parsed.hostProjectId, "--host-project"),
          hostSessionId: requiredParsed(parsed.hostSessionId, "--host-session"),
          hostThreadId: requiredParsed(parsed.hostThreadId, "--host-thread"),
          namespaceId: requiredParsed(parsed.namespaceId, "--namespace"),
          threadId: requiredParsed(parsed.threadId, "--thread"),
        }), null, 2));
        return 0;
      case "data-export":
        io.stdout(JSON.stringify(await service.exportBundle({
          outputDir: requiredParsed(parsed.outputDir, "--output"),
          includeGlobalMemory: parsed.includeGlobal,
          includeHostBindings: parsed.includeBindings,
        }), null, 2));
        return 0;
      case "data-import":
        io.stdout(JSON.stringify(await service.importBundle({
          inputDir: requiredParsed(parsed.inputDir, "--input"),
          includeHostBindings: parsed.includeBindings,
          overwrite: parsed.overwrite,
        }), null, 2));
        return 0;
      case "data-purge":
        io.stdout(JSON.stringify(await service.purgeData({
          ...(parsed.sessionId ? { sessionId: parsed.sessionId } : {}),
          dryRun: parsed.dryRun,
          confirmed: parsed.yes,
        }), null, 2));
        return 0;
      case "data-prune":
        io.stdout(JSON.stringify(await service.pruneTranscripts({
          ...(parsed.days === undefined ? {} : { days: parsed.days }),
          dryRun: parsed.dryRun,
          confirmed: parsed.yes,
        }), null, 2));
        return 0;
    }
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

type AdminCommand = "version" | "config-print" | "setup" | "doctor" | "inspect" | "migrate" | "init" | "jobs-list" | "jobs-retry"
  | "transcript-verify" | "transcript-repair" | "index-rebuild" | "bindings-list" | "bindings-rebind"
  | "data-export" | "data-import" | "data-purge" | "data-prune";

interface ParsedArguments {
  readonly command?: AdminCommand;
  readonly location: AdminLocationOptions;
  readonly help: boolean;
  readonly dryRun: boolean;
  readonly status?: DurableJobStatus;
  readonly jobId?: string;
  readonly sessionId?: string;
  readonly adapter?: "pi" | "codex";
  readonly force: boolean;
  readonly yes: boolean;
  readonly includeGlobal: boolean;
  readonly includeBindings: boolean;
  readonly overwrite: boolean;
  readonly outputDir?: string;
  readonly inputDir?: string;
  readonly days?: number;
  readonly hostType?: string;
  readonly hostProjectId?: string;
  readonly hostSessionId?: string;
  readonly hostThreadId?: string;
  readonly namespaceId?: string;
  readonly threadId?: string;
}

function parseArguments(argv: readonly string[]): ParsedArguments {
  const positionals: string[] = [];
  let homeDir: string | undefined;
  let cwd: string | undefined;
  let projectId: string | undefined;
  let status: DurableJobStatus | undefined;
  let sessionId: string | undefined;
  let dryRun = false;
  let help = false;
  let force = false;
  let yes = false;
  let includeGlobal = false;
  let includeBindings = false;
  let overwrite = false;
  let adapter: "pi" | "codex" | undefined;
  let outputDir: string | undefined;
  let inputDir: string | undefined;
  let days: number | undefined;
  let hostType: string | undefined;
  let hostProjectId: string | undefined;
  let hostSessionId: string | undefined;
  let hostThreadId: string | undefined;
  let namespaceId: string | undefined;
  let threadId: string | undefined;
  let version = false;
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]!;
    if (argument === "--help" || argument === "-h") help = true;
    else if (argument === "--version" || argument === "-v") version = true;
    else if (argument === "--json" || argument === "--effective" || argument === "--redacted") {
      // These explicit output-contract flags are accepted for script clarity.
      // V1 operational output is already JSON and configuration never contains credential values.
    }
    else if (argument === "--dry-run") dryRun = true;
    else if (argument === "--force") force = true;
    else if (argument === "--yes") yes = true;
    else if (argument === "--include-global") includeGlobal = true;
    else if (argument === "--include-bindings") includeBindings = true;
    else if (argument === "--overwrite") overwrite = true;
    else if (argument === "--adapter") adapter = parseAdapter(requiredValue(argv, ++index, argument));
    else if (argument === "--home") homeDir = requiredValue(argv, ++index, argument);
    else if (argument === "--cwd") cwd = requiredValue(argv, ++index, argument);
    else if (argument === "--project-id") projectId = requiredValue(argv, ++index, argument);
    else if (argument === "--status") status = parseJobStatus(requiredValue(argv, ++index, argument));
    else if (argument === "--session") sessionId = requiredValue(argv, ++index, argument);
    else if (argument === "--output") outputDir = requiredValue(argv, ++index, argument);
    else if (argument === "--input") inputDir = requiredValue(argv, ++index, argument);
    else if (argument === "--days") days = parsePositiveInteger(requiredValue(argv, ++index, argument), argument);
    else if (argument === "--host-type") hostType = requiredValue(argv, ++index, argument);
    else if (argument === "--host-project") hostProjectId = requiredValue(argv, ++index, argument);
    else if (argument === "--host-session") hostSessionId = requiredValue(argv, ++index, argument);
    else if (argument === "--host-thread") hostThreadId = requiredValue(argv, ++index, argument);
    else if (argument === "--namespace") namespaceId = requiredValue(argv, ++index, argument);
    else if (argument === "--thread") threadId = requiredValue(argv, ++index, argument);
    else if (argument.startsWith("-")) throw new Error(`unknown option: ${argument}`);
    else positionals.push(argument);
  }
  const [first, second, third] = positionals;
  let command: AdminCommand | undefined;
  let jobId: string | undefined;
  if (version) command = "version";
  else if (first === "doctor" || first === "inspect" || first === "migrate" || first === "version") command = first;
  else if (first === "setup") { command = "setup"; adapter = parseAdapter(second); }
  else if (first === "config" && second === "print") command = "config-print";
  else if (first === "init") { command = "init"; adapter = parseAdapter(second); }
  else if (first === "jobs" && second === "list") command = "jobs-list";
  else if (first === "jobs" && second === "retry") { command = "jobs-retry"; jobId = third; }
  else if (first === "transcript" && second === "verify") command = "transcript-verify";
  else if (first === "transcript" && second === "repair") command = "transcript-repair";
  else if (first === "index" && second === "rebuild") command = "index-rebuild";
  else if (first === "bindings" && second === "list") command = "bindings-list";
  else if (first === "bindings" && second === "rebind") command = "bindings-rebind";
  else if (first === "data" && second === "export") command = "data-export";
  else if (first === "data" && second === "import") command = "data-import";
  else if (first === "data" && second === "purge") command = "data-purge";
  else if (first === "data" && second === "prune") command = "data-prune";
  else if (first !== undefined) throw new Error(`unknown command: ${positionals.join(" ")}`);
  return {
    ...(command === undefined ? {} : { command }),
    location: {
      ...(homeDir === undefined ? {} : { homeDir }),
      ...(cwd === undefined ? {} : { cwd }),
      ...(projectId === undefined ? {} : { projectId }),
    },
    help,
    dryRun,
    force,
    yes,
    includeGlobal,
    includeBindings,
    overwrite,
    ...(adapter === undefined ? {} : { adapter }),
    ...(outputDir === undefined ? {} : { outputDir }),
    ...(inputDir === undefined ? {} : { inputDir }),
    ...(days === undefined ? {} : { days }),
    ...(hostType === undefined ? {} : { hostType }),
    ...(hostProjectId === undefined ? {} : { hostProjectId }),
    ...(hostSessionId === undefined ? {} : { hostSessionId }),
    ...(hostThreadId === undefined ? {} : { hostThreadId }),
    ...(namespaceId === undefined ? {} : { namespaceId }),
    ...(threadId === undefined ? {} : { threadId }),
    ...(status === undefined ? {} : { status }),
    ...(jobId === undefined ? {} : { jobId }),
    ...(sessionId === undefined ? {} : { sessionId }),
  };
}

function requiredValue(argv: readonly string[], index: number, option: string): string {
  const value = argv[index];
  if (!value || value.startsWith("-")) throw new Error(`${option} requires a value`);
  return value;
}

function parseJobStatus(value: string): DurableJobStatus {
  if (value === "pending" || value === "processing" || value === "completed" || value === "dead_letter") return value;
  throw new Error(`invalid job status: ${value}`);
}

function parseAdapter(value: string | undefined): "pi" | "codex" {
  if (value === "pi" || value === "codex") return value;
  throw new Error("adapter must be pi or codex");
}

function parsePositiveInteger(value: string, option: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${option} requires a positive integer`);
  return parsed;
}

function requiredParsed(value: string | undefined, option: string): string {
  if (!value) throw new Error(`${option} is required`);
  return value;
}

function helpText(): string {
  return `AgentEngram operational CLI

Usage:
  agentengram version
  agentengram setup pi|codex [--dry-run] [--force]
  agentengram init pi|codex [--dry-run] [--force]
  agentengram config print --effective --redacted
  agentengram doctor [--adapter pi|codex] [--home PATH] [--cwd PATH]
  agentengram inspect [--project-id ID]
  agentengram migrate [--dry-run]
  agentengram jobs list [--status STATUS]
  agentengram jobs retry JOB_ID
  agentengram transcript verify [--session SESSION_ID]
  agentengram transcript repair [--session SESSION_ID]
  agentengram index rebuild
  agentengram bindings list
  agentengram bindings rebind --host-type TYPE --host-project ID --host-session ID --host-thread ID --namespace ID --thread ID
  agentengram data export --output DIR [--include-global] [--include-bindings]
  agentengram data import --input DIR [--include-bindings] [--overwrite]
  agentengram data purge [--session ID] (--dry-run | --yes)
  agentengram data prune --days N (--dry-run | --yes)

Common options: --home PATH --cwd PATH --project-id ID`;
}

function consoleIO(): AdminCliIO {
  return { stdout: (line) => console.log(line), stderr: (line) => console.error(line) };
}
