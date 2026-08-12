import { describe, expect, it } from "vitest";
import { createHostBinding, validateHostIdentity, type HostIdentity } from "./host-identity.js";

const identity: HostIdentity = {
  hostType: "pi",
  hostProjectId: "project-a",
  hostSessionId: "session-a",
  hostThreadId: "thread-a",
  worktreeId: "worktree-a",
};

describe("host identity", () => {
  it("uses canonical host project and thread identities as conservative defaults", () => {
    expect(createHostBinding(identity)).toEqual({
      namespaceId: "project-a",
      threadId: "thread-a",
      identity,
    });
  });

  it("accepts trusted portable namespace and thread overrides", () => {
    expect(createHostBinding(identity, { namespaceId: "shared-project", threadId: "portable-thread" }))
      .toMatchObject({ namespaceId: "shared-project", threadId: "portable-thread" });
  });

  it("rejects incomplete or blank host identity dimensions", () => {
    expect(() => validateHostIdentity({ ...identity, hostSessionId: " " })).toThrow("hostSessionId");
    expect(() => createHostBinding(identity, { namespaceId: "" })).toThrow("namespaceId");
  });
});
