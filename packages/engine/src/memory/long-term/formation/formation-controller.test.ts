import { describe, expect, it } from "vitest";
import { BackgroundFormationBuffer, detectExplicitMemoryIntent } from "./formation-controller.js";

describe("long-term formation controls", () => {
  it("detects explicit remember, forget and correction paths", () => {
    expect(detectExplicitMemoryIntent("请记住以后都用 pnpm")).toBe("remember");
    expect(detectExplicitMemoryIntent("忘记刚才的偏好")).toBe("forget");
    expect(detectExplicitMemoryIntent("No, actually use pnpm")).toBe("correction");
  });

  it("triggers background review only with stable prose signal", () => {
    const buffer = new BackgroundFormationBuffer({ turnThreshold: 2, toolCallThreshold: 2, minimumTextCharacters: 20 });
    expect(buffer.add({ role: "tool", text: "{}", sourceRef: "t1", toolCall: true })).toBeNull();
    expect(buffer.add({ role: "tool", text: "{}", sourceRef: "t2", toolCall: true })).toBeNull();
    expect(buffer.add({ role: "user", text: "We always use pnpm in every repository", sourceRef: "u1" }))
      .toMatchObject({ sourceRefs: ["t1", "t2", "u1"], metadata: { formation: "background" } });
  });
});
