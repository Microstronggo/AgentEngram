import { describe, expect, it } from "vitest";
import { createMemoryPartition, isPartitionVisible, memoryPartitionKey, validateMemoryPartition } from "./memory-partition.js";

describe("memory partition", () => {
  it("shares project memory while isolating local worktrees", () => {
    const project = createMemoryPartition("project", { projectId: "p" });
    const localA = createMemoryPartition("local", { projectId: "p", worktreeId: "a" });
    const localB = createMemoryPartition("local", { projectId: "p", worktreeId: "b" });
    expect(isPartitionVisible("project", project, { projectId: "p", worktreeId: "b" })).toBe(true);
    expect(isPartitionVisible("local", localA, { projectId: "p", worktreeId: "a" })).toBe(true);
    expect(isPartitionVisible("local", localA, { projectId: "p", worktreeId: "b" })).toBe(false);
    expect(memoryPartitionKey(localA)).not.toBe(memoryPartitionKey(localB));
  });

  it("requires the identity dimension promised by each scope", () => {
    expect(() => validateMemoryPartition("team", { schemaVersion: 1, projectId: "p" })).toThrow("teamId");
    expect(() => validateMemoryPartition("agent", { schemaVersion: 1 })).toThrow("agentId");
  });

  it("isolates user, agent, team, app, and namespace dimensions", () => {
    expect(isPartitionVisible("user", createMemoryPartition("user", { userId: "u1" }), { userId: "u1" })).toBe(true);
    expect(isPartitionVisible("user", createMemoryPartition("user", { userId: "u1" }), { userId: "u2" })).toBe(false);
    expect(isPartitionVisible("agent", createMemoryPartition("agent", { agentId: "a1" }), { agentId: "a2" })).toBe(false);
    expect(isPartitionVisible("team", createMemoryPartition("team", { teamId: "t1" }), { teamIds: ["t1", "t2"] })).toBe(true);
    const restricted = createMemoryPartition("project", { projectId: "p", appId: "app-a", namespace: "private" });
    expect(isPartitionVisible("project", restricted, { projectId: "p", appId: "app-a", namespace: "private" })).toBe(true);
    expect(isPartitionVisible("project", restricted, { projectId: "p", appId: "app-b", namespace: "private" })).toBe(false);
  });
});
