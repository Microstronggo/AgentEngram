#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  LocalAgentEngramRuntime,
  loadAgentEngramConfig,
  resolveProjectIdentity,
  type MemoryRecord,
  type MemoryPartition,
  type MemoryScope,
  type RememberInput,
} from "@agentengram/engine";
import { createMemoryMcpServer, type MemoryApplicationLike } from "@agentengram/mcp";

const installed = await loadAgentEngramConfig();
const homeDir = installed.config.dataDir!;
const project = await resolveProjectIdentity(process.cwd());
const runtime = await LocalAgentEngramRuntime.create({ homeDir, projectId: project.projectId, contextMode: "enhance" });
const application = withProjectDefaults(runtime.application, project, installed.config.identities);
const server = createMemoryMcpServer(application);
const shutdown = async () => {
  await runtime.close();
  process.exit(0);
};
process.once("SIGINT", () => { void shutdown(); });
process.once("SIGTERM", () => { void shutdown(); });
await server.connect(new StdioServerTransport());

/** Codex launches the stdio server in the active session cwd. */
function withProjectDefaults(
  service: typeof runtime.application,
  project: Awaited<ReturnType<typeof resolveProjectIdentity>>,
  identities: { readonly userId?: string; readonly agentId?: string; readonly teamId?: string } = {},
): MemoryApplicationLike {
  const projectId = project.projectId;
  const configuredUserId = identities.userId;
  const configuredAgentId = identities.agentId;
  const configuredTeamId = identities.teamId;
  const scopedProjectId = (scope: MemoryScope, explicit?: string) => {
    if (scope !== "project" && scope !== "local" && scope !== "team") return undefined;
    if (explicit && explicit !== projectId) {
      throw new Error("Codex memory tools cannot access a project outside the active host binding");
    }
    return projectId;
  };
  const scopedPartition = (scope: MemoryScope): MemoryPartition => {
    if (scope === "project") return { schemaVersion: 1, projectId };
    if (scope === "local") return { schemaVersion: 1, projectId, worktreeId: project.worktreeId };
    if (scope === "user") return { schemaVersion: 1, userId: requireConfiguredIdentity(scope, configuredUserId, "AGENTENGRAM_USER_ID") };
    if (scope === "agent") return { schemaVersion: 1, agentId: requireConfiguredIdentity(scope, configuredAgentId, "AGENTENGRAM_AGENT_ID") };
    return {
      schemaVersion: 1,
      projectId,
      teamId: requireConfiguredIdentity(scope, configuredTeamId, "AGENTENGRAM_TEAM_ID"),
    };
  };
  const audience = {
    projectId,
    worktreeId: project.worktreeId,
    ...(configuredUserId ? { userId: configuredUserId } : {}),
    ...(configuredAgentId ? { agentId: configuredAgentId } : {}),
    ...(configuredTeamId ? { teamIds: [configuredTeamId] } : {}),
  };
  const authoritativeWrite = <Input extends { readonly projectId?: string; readonly partition?: MemoryPartition }>(
    input: Input,
    target: string | undefined,
    partition: MemoryPartition,
  ) => {
    const { projectId: _projectId, partition: _partition, ...portable } = input;
    return { ...portable, ...(target ? { projectId: target } : {}), partition };
  };
  return {
    remember: (input: RememberInput): Promise<MemoryRecord> => {
      const target = scopedProjectId(input.scope, input.projectId);
      const partition = scopedPartition(input.scope);
      return service.remember(authoritativeWrite(input, target, partition) as RememberInput);
    },
    write: (input) => {
      const target = scopedProjectId(input.scope, input.projectId);
      return service.write(authoritativeWrite(input, target, scopedPartition(input.scope)));
    },
    update: (input) => {
      const target = scopedProjectId(input.scope, input.projectId);
      return service.update(authoritativeWrite(input, target, scopedPartition(input.scope)));
    },
    correct: (input) => {
      const target = scopedProjectId(input.scope, input.projectId);
      return service.correct(authoritativeWrite(input, target, scopedPartition(input.scope)));
    },
    search: (input) => {
      const scope = input.scope ?? "project";
      // Resolve the partition even though search only needs an audience; this
      // rejects global scopes unless the host supplied their stable identity.
      scopedPartition(scope);
      const target = scopedProjectId(scope, input.projectId);
      const { projectId: _projectId, audience: _audience, ...query } = input;
      return service.search({ ...query, ...(target ? { projectId: target } : {}), audience });
    },
    read: (scope: MemoryScope, id: string, explicit?: string, _partition?: MemoryPartition) => {
      const target = scopedProjectId(scope, explicit);
      return service.read(scope, id, target, scopedPartition(scope));
    },
    forget: (scope: MemoryScope, id: string, explicit?: string, _partition?: MemoryPartition) => {
      const target = scopedProjectId(scope, explicit);
      return service.forget(scope, id, target, scopedPartition(scope));
    },
    feedback: (input: Omit<RememberInput, "type" | "kind">) => {
      const target = scopedProjectId(input.scope, input.projectId);
      return service.feedback(authoritativeWrite(input, target, scopedPartition(input.scope)));
    },
    inspectContext: (sessionId?: string) => service.inspectContext(sessionId),
  };
}

function requireConfiguredIdentity(scope: MemoryScope, value: string | undefined, variable: string): string {
  if (!value) throw new Error(`${scope} memory scope requires stable host identity via ${variable}`);
  return value;
}
