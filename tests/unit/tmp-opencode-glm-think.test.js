// Throwaway smoke check: opencode (OpenCode Free) must never receive z.ai's
// `thinking` object for glm-5.3-flash-free, while z.ai itself still does.
import { describe, it, expect } from "vitest";
import { getCapabilitiesForModel } from "open-sse/providers/capabilities.js";
import { translateRequest } from "open-sse/translator/index.js";
import { FORMATS } from "open-sse/translator/formats.js";

const bodyWith = () => ({
  model: "glm-5.3-flash-free",
  messages: [{ role: "user", content: "hi" }],
  reasoning_effort: "high",
  stream: true,
});

describe("opencode free glm-5.3-flash thinking wire format", () => {
  it("resolves to the openai thinking format for oc", () => {
    const caps = getCapabilitiesForModel("opencode", "glm-5.3-flash-free");
    expect(caps.thinkingFormat).toBe("openai");
    expect(caps.reasoning).toBe(true);
    expect(caps.contextWindow).toBe(1000000);
  });

  it("emits reasoning_effort and no thinking object for provider=opencode", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, "glm-5.3-flash-free", bodyWith(), true, null, "opencode");
    expect(out.thinking).toBeUndefined();
    expect(out.reasoning_effort).toBeDefined();
  });

  it("still emits zai thinking for provider=glm (z.ai itself)", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, "glm-5.3-flash-free", bodyWith(), true, null, "glm");
    expect(out.thinking).toEqual({ type: "enabled" });
  });

  it("still emits zai thinking for opencode's non-free GLM id", () => {
    const out = translateRequest(FORMATS.OPENAI, FORMATS.OPENAI, "glm-5.3-flash", bodyWith(), true, null, "opencode");
    expect(out.thinking).toEqual({ type: "enabled" });
  });
});
